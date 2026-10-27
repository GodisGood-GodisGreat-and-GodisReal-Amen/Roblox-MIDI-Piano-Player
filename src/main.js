// Roblox MIDI Piano Player — plays MIDI files on a Roblox piano, and lets you
// play the Roblox piano live from its window.
//
// The whole app is this one JavaScript for Automation script, started by
// osascript from the app bundle's launcher (app/RobloxMidiPianoPlayer).
// The same file runs in two roles:
//   * the window (mainWindowUI, at the end of the file): AppKit built from
//     JavaScript; loads and maps songs, settings, live keys, live speed;
//   * the background player (run --worker <job>, workerMain): waits for
//     Roblox, then sends every chord's keys to the Roblox process.
// They talk through small JSON files in ~/Library/Application Support/
// Roblox MIDI Piano Player/. docs/architecture.md walks through the code.
//
// Public domain (The Unlicense). Not affiliated with Roblox Corporation.
// https://github.com/GodisGood-GodisGreat-and-GodisReal-Amen/Roblox-MIDI-Piano-Player

ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
try { ObjC.import('signal'); } catch (_) {}   // kill(pid, 0) for a cheap "is it alive?" check

var app = Application.currentApplication();
app.includeStandardAdditions = true;

var APP_NAME = "Roblox MIDI Piano Player";
var APP_VERSION = "2.1.1";
var APP_REPO_URL = "https://github.com/GodisGood-GodisGreat-and-GodisReal-Amen/Roblox-MIDI-Piano-Player";
var SUPPORT_DIR_NAME = "Roblox MIDI Piano Player";
var WAIT_FOR_ROBLOX_PROMPT_SECONDS = 30;
var PLAYBACK_STATE_FILE = "playback_state.json";
var PLAYBACK_PID_FILE = "playback.pid";
var PLAYBACK_STOP_FILE = "playback.stop";
var PLAYBACK_CONTROL_FILE = "playback_control.json";
var PLAYBACK_JOB_PREFIX = "playback_job_";
var PLAYBACK_LOG_FILE = "playback.log";
var STALE_JOB_SECONDS = 3600;          // leftover job files older than this are removed at launch

// --- Live speed and pause (v2.1.0) ------------------------------------------
// While a song plays, the window writes playback_control.json ({ jobId, speed,
// paused }). The worker reads it a few times a second and re-anchors its
// timeline on the spot, so the music slows down, speeds up or pauses from the
// note that is playing now — no jump, no catch-up burst.
var CONTROL_POLL_SECONDS = 0.1;       // how often the worker looks at the control file
var SPEED_MIN = 0.25;
var SPEED_MAX = 2.0;
var SPEED_STEP = 0.05;

// --- Playback timing tuning (v1.7.3) ---------------------------------------
// Sending one key to Roblox through the Accessibility API is slow (~10-15ms
// per event on a real target). The old engine sent a key DOWN and a key UP for
// every note, plus settle/hold sleeps, all on the timeline's critical path.
// Chord-heavy songs needed dozens of these slow calls per beat, so playback
// fell progressively behind and never caught up (observed: 30s+ late by the end
// of a dense song). The engine therefore only puts key DOWNS on the critical
// path and releases keys lazily during the gaps between notes, which keeps
// onsets on time. Quartz (CGEventPostToPid, about 2ms per key) is now the
// default sender; Accessibility remains as the fallback.
// Each key is now held for the note's REAL length taken from the MIDI, so
// sustained notes ring and short notes stay short — instead of every note being
// clipped to one fixed length (which sounded rushed/clamped). These bound it:
var MIN_HOLD_SECONDS = 0.05;          // floor, so even a staccato note is clearly struck
var MAX_HOLD_SECONDS = 2.5;           // ceiling, so a very long / stuck note can't ring forever
var DEFAULT_HOLD_SECONDS = 0.14;      // used when the MIDI gave no note-off for a note
var SHIFT_SETTLE_SECONDS = 0.0015;    // brief settle after toggling Shift on
var CHORD_EPSILON_SECONDS = 0.006;    // notes within this window play as one chord
var STOP_CHECK_INTERVAL_SECONDS = 0.05; // how often the worker polls the stop signal

// --- Steady-tempo controls (v1.7.5) ----------------------------------------
// A fat chord costs one slow key event per note, so it can over-run the gap to
// the next note. The old engine then fired the whole backlog as fast as it
// could — a rushed burst — before settling again. Dense passages therefore
// wobbled: drag, rush, drag. Two rules keep the pulse steady instead:
//   1. RELEASES are budgeted, so a clump of key-ups can never shove a note late.
//   2. When we genuinely cannot make a deadline we SLIP the whole remaining
//      timeline instead of compressing the gaps. Relative rhythm (what the ear
//      actually hears) is preserved; the song just sits a few ms later, and the
//      slip is quietly clawed back during rests.
var RELEASE_SLACK_SECONDS = 0.03;     // never send a key-up with less than this before the next onset
var MAX_RELEASES_PER_GAP = 6;         // spread key-ups out instead of firing them in one clump
var FORCE_RELEASE_AFTER_SECONDS = 1.5; // a note this overdue is released even when busy (one at a time)
var SLIP_TRIGGER_SECONDS = 0.01;      // ignore sub-10ms overruns; only slip for real ones
var SLIP_REST_SECONDS = 0.30;         // a gap longer than this counts as a rest we can borrow from
var SLIP_RECOVER_FRACTION = 0.25;     // claw back at most a quarter of a rest...
var SLIP_RECOVER_MAX_SECONDS = 0.12;  // ...and never more than this much from one rest
var ASSUMED_KEY_COST_SECONDS = 0.015; // starting guess for one Accessibility key event (measured 12-17ms)
var QUARTZ_KEY_COST_SECONDS = 0.003;  // starting guess for one Quartz key event (measured ~2ms)
var MAX_CHORD_SHIFT_TOGGLES = 2;      // spend at most this many Shift changes to roll a chord in
                                      // true pitch order; past that, speed matters more than order
var PRE_RELEASE_FRACTION = 0.25;      // ...or up to this share of the note's own length, whichever is
                                      // larger, so long ringing notes can clear out of a chord's way

var defaultConfig = {
  baseMIDINote: 36,
  keyboardProfile: "us",
  keyLayout: "1234567890qwertyuiopasdfghjklzxcvbnm,./",
  startDelaySeconds: 0.5,
  speed: 1,
  noteRecognitionMode: "perfect",
  mappingModel: "max61",
  // How key presses are delivered to Roblox.
  //   "quartz"        - CGEventPostToPid. Measured at about 2ms per key and
  //                     confirmed audible in Roblox both in front and in the
  //                     background. Roughly 6-8x faster than Accessibility.
  //   "accessibility" - AXUIElementPostKeyboardEvent. ~12-17ms per key, because
  //                     it waits for Roblox to handle each event.
  //   "auto"          - prefer Quartz, fall back to Accessibility.
  keySendMethod: "auto",
  // Which Roblox piano you play on (v2.0.0):
  //   "classic"  - the standard 61-key piano, C2..C7
  //   "extended" - the full 88-key piano, A0..C8; the 15 lowest and 12 highest
  //                notes are the dotted keys, played with Ctrl held down
  keyboardMode: "classic",
  // Key held for the extended notes: "ctrl" (standard) or "alt" (Option).
  extendedModifier: "ctrl",
  // Window language: "auto" (follow macOS), "en" or "fr".
  uiLanguage: "auto",
  // Also open the Terminal live-log window when arming. The window itself now
  // shows the playback status, so this is off by default.
  openLiveLogWindow: false,
  // Live keys (v2.1.0): keys pressed in the window, or clicked on its piano
  // picture, are pressed in Roblox too.
  liveKeys: true
};

var LEGACY_US_LAYOUT = "1234567890qwertyuiopasdfghjklzxcvbnm,./";
var LEGACY_AZERTY_LAYOUT = "&é\"'(-è_çàazertyuiopqsdfghjklwxcvbn,;:!";
var MAX_WHITE_KEYCODES = [
  18, 19, 20, 21, 23, 22, 26, 28, 25, 29,
  12, 13, 14, 15, 17, 16, 32, 34, 31, 35,
  0, 1, 2, 3, 5, 4, 38, 40, 37,
  6, 7, 8, 9, 11, 45, 46
];
var US_PROFILE_LABELS = [
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
  "q", "w", "e", "r", "t", "y", "u", "i", "o", "p",
  "a", "s", "d", "f", "g", "h", "j", "k", "l",
  "z", "x", "c", "v", "b", "n", "m"
];
var AZERTY_PROFILE_LABELS = [
  "&", "é", "\"", "'", "(", "-", "è", "_", "ç", "à",
  "a", "z", "e", "r", "t", "y", "u", "i", "o", "p",
  "q", "s", "d", "f", "g", "h", "j", "k", "l",
  "w", "x", "c", "v", "b", "n", ","
];
var US_TOP_ROW_SHIFT_LABELS = ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")"];
var AZERTY_TOP_ROW_SHIFT_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

// --- The 88-key extended Roblox piano (v2.0.0) ------------------------------
// The classic Roblox piano has 61 keys, C2..C7: white keys 1..m and black keys
// on Shift. Many Roblox pianos (Talent Show, Got Talent, ...) also offer the
// full 88 keys of a real piano: while Ctrl is held, the first fifteen keys
// (1 2 3 4 5 6 7 8 9 0 q w e r t) become the fifteen lowest notes A0..B1 and
// the next twelve keys (y u i o p a s d f g h j) become the twelve highest
// notes C#7..C8. The game draws those keys with a dot above the label. Both
// extensions are chromatic: every key is one semitone, black keys included, so
// no Shift is involved for them.
var EXTENDED_MODIFIER_KEYCODES = { ctrl: 59, alt: 58 };    // left Control / left Option
var EXTENDED_LOW_COUNT = 15;
var EXTENDED_HIGH_COUNT = 12;
var CLASSIC_KEY_COUNT = 61;
var EXTENDED_LOW_KEYCODES = [18, 19, 20, 21, 23, 22, 26, 28, 25, 29, 12, 13, 14, 15, 17];   // 1234567890qwert
var EXTENDED_LOW_IS_BLACK = [false, true, false, false, true, false, true, false, false, true, false, true, false, true, false];
var EXTENDED_HIGH_KEYCODES = [16, 32, 34, 31, 35, 0, 1, 2, 3, 5, 4, 38];                    // yuiopasdfghj
var EXTENDED_HIGH_IS_BLACK = [true, false, true, false, false, true, false, true, false, true, false, false];
var US_EXTENDED_LOW_LABELS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "q", "w", "e", "r", "t"];
var US_EXTENDED_HIGH_LABELS = ["y", "u", "i", "o", "p", "a", "s", "d", "f", "g", "h", "j"];
var AZERTY_EXTENDED_LOW_LABELS = ["&", "é", "\"", "'", "(", "-", "è", "_", "ç", "à", "a", "z", "e", "r", "t"];
var AZERTY_EXTENDED_HIGH_LABELS = ["y", "u", "i", "o", "p", "q", "s", "d", "f", "g", "h", "j"];

var DIRECT_EVENT_PERMISSION_HELP = [
  "Background playback needs Accessibility permission so it can send piano keys to Roblox.",
  "",
  "Open System Settings → Privacy & Security → Accessibility, allow Roblox MIDI Piano Player, and if macOS shows osascript there instead, allow that too. Then reopen the app and try again."
].join("\n");

function run(argv) {
  argv = argv || [];
  if (argv.length >= 2 && String(argv[0]) === "--worker") {
    try {
      workerMain(String(argv[1]));
    } catch (e) {
      workerFatal(String(argv[1]), e);
    }
    return;
  }

  if (argv.length >= 1 && String(argv[0]) === "--selftest-senders") {
    return selfTestSenders(argv.length >= 2 ? String(argv[1]) : "");
  }

  // The classic dialog flow is still available on request.
  if (argv.length >= 1 && String(argv[0]) === "--dialogs") {
    try {
      main();
    } catch (e) {
      showDialog(APP_NAME, "Unexpected error.\n\n" + messageOf(e), ["OK"], "OK", null, "stop");
    }
    return;
  }

  // Builds the window, loads a MIDI, flips modes and captures pictures of it.
  if (argv.length >= 1 && String(argv[0]) === "--ui-selftest") {
    return uiSelfTest(argv.slice(1));
  }

  var midiArg = "";
  if (argv.length >= 2 && String(argv[0]) === "--midi") midiArg = String(argv[1]);

  try {
    mainWindowUI({ midiPath: midiArg });
  } catch (e) {
    // The window could not be created. Say so in the log, then fall back to
    // the dialog flow so the app is still usable.
    try { appendPlaybackLog(ensureSupportDir(), "Window UI failed, falling back to dialogs: " + messageOf(e)); } catch (_) {}
    try {
      main();
    } catch (e2) {
      showDialog(APP_NAME, "Unexpected error.\n\n" + messageOf(e2), ["OK"], "OK", null, "stop");
    }
  }
}

// Bring some other app to the front so Roblox is genuinely in the background.
// Used by the background self test so the result cannot depend on the user
// remembering to switch away at the right moment.
function activateFinderApp() {
  try {
    var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    for (var i = 0; i < Number(apps.count); i++) {
      var a = apps.objectAtIndex(i);
      var bid = String(unwrapMaybe(a.bundleIdentifier) || "").toLowerCase();
      if (bid === "com.apple.finder") {
        a.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
        return "Finder";
      }
    }
  } catch (e) {
    // fall through
  }
  try {
    app.doShellScript("/usr/bin/open -a Finder");
    return "Finder (via open)";
  } catch (e2) {
    return "";
  }
}

// Locate the actual Roblox game process (not the menu-bar helper or its network
// process). Used by the sender self test, which aims events at a process id.
function findRobloxPlayerProcess() {
  try {
    var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
    var count = Number(apps.count);
    var best = null;
    for (var i = 0; i < count; i++) {
      var a = apps.objectAtIndex(i);
      var info = {
        name: String(unwrapMaybe(a.localizedName) || ""),
        bundleIdentifier: String(unwrapMaybe(a.bundleIdentifier) || ""),
        path: "",
        pid: Math.round(Number(a.processIdentifier))
      };
      try { if (a.executableURL) info.path = String(unwrapMaybe(a.executableURL.path) || ""); } catch (_) {}
      var bid = info.bundleIdentifier.toLowerCase();
      var nm = info.name.toLowerCase();
      if (bid.indexOf("menubar") >= 0 || nm.indexOf("menubar") >= 0) continue;
      if (bid.indexOf("webkit") >= 0 || nm.indexOf("networking") >= 0) continue;
      if (isOwnApplicationInfo(info)) continue;
      if (!isRobloxApplicationInfo(info)) continue;
      // Prefer the real player bundle if several match.
      if (bid === "com.roblox.robloxplayer") return info;
      if (!best) best = info;
    }
    return best;
  } catch (e) {
    return null;
  }
}

// Plays the same short run of notes twice — once through Quartz, once through
// Accessibility — so it can be heard which methods actually reach the Roblox
// piano, and how fast each one is. Run with --selftest-senders.
function selfTestSenders(mode) {
  var background = String(mode || "").toLowerCase() === "background";
  var supportDir = ensureSupportDir();
  var lines = [];
  // Write every step to the log as it happens, so progress can be followed live
  // rather than only appearing once the whole test has finished.
  function say(s) {
    lines.push(String(s));
    console.log(String(s));
    appendPlaybackLog(supportDir, "[selftest] " + String(s));
  }

  say(APP_NAME + " v" + APP_VERSION + " — key sender self test");
  say("Accessibility trusted: " + describeAccessibilityTrustStatus());

  var caps = directInputCapabilities();
  say("Available: AX=" + caps.ax + ", Quartz=" + caps.cg);

  var cfg = sanitizeConfig(loadConfig(supportDir + "/config.json"));
  var profile = resolveKeyboardProfile(cfg);
  say("Keyboard profile: " + keyboardProfileLabel(profile));

  // A short rising run of white keys from key "1", using this config's own key
  // map. In extended mode the two lowest keys (Ctrl) are added in front so the
  // Ctrl path gets exercised too.
  var anchor = profile.anchorIndex || 0;
  var stepIndexes = [0, 2, 4, 5, 7, 9, 11, 12];
  var notes = [];
  if (anchor > 0) {
    var lowPick = [anchor - 15, anchor - 12];
    for (var lp = 0; lp < lowPick.length; lp++) {
      var lst = profile.steps[lowPick[lp]];
      if (lst && isFiniteNumber(lst.code)) notes.push(lst);
    }
  }
  for (var i = 0; i < stepIndexes.length; i++) {
    var st = profile.steps[anchor + stepIndexes[i]];
    if (st && isFiniteNumber(st.code)) notes.push(st);
  }
  var ctrlKeyCode = extendedModifierKeyCode(cfg.extendedModifier);
  if (notes.length === 0) {
    say("No playable keys in this profile — nothing to test.");
    return lines.join("\n");
  }
  say("Test phrase: " + notes.map(function (s) { return formatPreviewKeyLabel(stepDisplayLabel(s)); }).join(" "));

  // Find Roblox directly by process, rather than waiting for it to become the
  // front window. NSWorkspace's "frontmost application" can hand back a stale
  // value in a long-running script with no run loop spinning, so a countdown is
  // far more dependable here: the events are aimed at the process by id anyway.
  var target = findRobloxPlayerProcess();
  if (!target || !(target.pid > 0)) {
    say("Could not find a running Roblox player process. Start Roblox, then run this again.");
    return lines.join("\n");
  }
  say("Found Roblox: " + describeApplicationInfo(target));

  say("");
  say("MODE: " + (background ? "BACKGROUND (Roblox must NOT be the front window)" : "FOREGROUND (Roblox in front)"));
  if (background) {
    // Don't rely on the user switching away at the right moment — do it here.
    var moved = activateFinderApp();
    say(moved ? ("Pushed Roblox to the background by activating " + moved + ".")
              : "Could not bring another app forward; the result may not be a true background test.");
    sleepSeconds(1.5);
  } else {
    say("SWITCH TO ROBLOX NOW and put your cursor on the piano.");
  }
  for (var cd = (background ? 3 : 8); cd >= 1; cd--) {
    say("Playing in " + cd + "...");
    sleepSeconds(1);
  }
  var frontNow = frontmostApplicationInfo();
  say("Front window at play time: " + describeApplicationInfo(frontNow));

  function playWith(sender, label) {
    var t0 = nowSeconds();
    var events = 0;
    for (var n = 0; n < notes.length; n++) {
      var s = notes[n];
      if (s.ctrl) { sender.postKeyCode(ctrlKeyCode, true, ""); events++; }
      if (s.shift) { sender.postKeyCode(56, true, ""); events++; }
      sender.postKeyCode(s.code, true, s.label || ""); events++;
      sleepSeconds(0.12);                     // audible, clearly separated notes
      sender.postKeyCode(s.code, false, s.label || ""); events++;
      if (s.shift) { sender.postKeyCode(56, false, ""); events++; }
      if (s.ctrl) { sender.postKeyCode(ctrlKeyCode, false, ""); events++; }
    }
    var elapsed = nowSeconds() - t0;
    var sleptFor = notes.length * 0.12;
    var perKey = events > 0 ? ((elapsed - sleptFor) / events) : 0;
    say(label + ": sent " + events + " key events, about " + formatNumber(perKey * 1000, 2) + " ms per event.");
    return perKey;
  }

  var quartzCost = null, axCost = null;

  if (caps.cg) {
    say("");
    say(">>> ROUND 1 of 2: QUARTZ. Listen now.");
    try {
      var cg = createCGKeySender(target.pid);
      quartzCost = playWith(cg, "Quartz");
      cg.close();
    } catch (e) {
      say("Quartz failed: " + messageOf(e));
    }
  }

  sleepSeconds(1.5);

  if (caps.ax) {
    say("");
    say(">>> ROUND 2 of 2: ACCESSIBILITY. Listen now.");
    try {
      var ax = createAXKeySender(target.pid);
      axCost = playWith(ax, "Accessibility");
      ax.close();
    } catch (e2) {
      say("Accessibility failed: " + messageOf(e2));
    }
  }

  say("");
  say("Done. Round 1 was Quartz, round 2 was Accessibility.");
  if (quartzCost != null && axCost != null && axCost > 0) {
    say("Speed: Quartz " + formatNumber(quartzCost * 1000, 2) + " ms/event vs Accessibility " +
        formatNumber(axCost * 1000, 2) + " ms/event (" + formatNumber(axCost / Math.max(quartzCost, 0.000001), 1) + "x).");
  }
  return lines.join("\n");
}

function main() {
  var supportDir = ensureSupportDir();
  var configPath = supportDir + "/config.json";
  var cfg = loadConfig(configPath);

  while (true) {
    var playback = getPlaybackStatus(supportDir);
    var action = menuAction(cfg, playback);

    if (!action || action === "Quit") {
      if (playback.active) {
        var quitAnswer = showDialog(
          APP_NAME,
          [
            "Background playback is still active.",
            "",
            "Choose Stop Playback to cancel it now, or Quit Anyway to close the app while playback keeps running in the background."
          ].join("\n"),
          ["Cancel", "Quit Anyway", "Stop Playback"],
          "Stop Playback",
          "Cancel",
          "note"
        );
        if (quitAnswer === "Stop Playback") {
          stopPlayback(supportDir);
          continue;
        }
        if (quitAnswer !== "Quit Anyway") {
          continue;
        }
      }
      return;
    }

    if (action === "Play MIDI") {
      try {
        cfg = sanitizeConfig(loadConfig(configPath));
        var playResult = playMIDIFlow(cfg, configPath, supportDir);
        if (playResult && playResult.exitAfter) {
          return;
        }
      } catch (e) {
        if (!isCanceledError(e)) {
          showDialog(APP_NAME, "Playback could not start.\n\n" + messageOf(e), ["OK"], "OK", null, "caution");
        }
      }
    } else if (action === "Stop Playback") {
      stopPlayback(supportDir);
    } else if (action === "Edit Settings") {
      try {
        var updated = editSettings(cfg);
        if (updated) {
          cfg = sanitizeConfig(updated);
          saveConfig(configPath, cfg);
          showDialog(APP_NAME, "Settings saved.", ["OK"], "OK", null, "note");
        }
      } catch (e) {
        if (!isCanceledError(e)) {
          showDialog(APP_NAME, "Settings could not be edited.\n\n" + messageOf(e), ["OK"], "OK", null, "caution");
        }
      }
    } else if (action === "Open Config Folder") {
      app.doShellScript('/usr/bin/open ' + shellQuote(supportDir));
    } else if (action === "About") {
      var aboutText = [
        "This app loads a MIDI file, uses an explicit keyboard profile, and sends timed keystrokes directly to Roblox.",
        "",
        "Notes:",
        "• After a MIDI is loaded, choose Arm in Background and then click the Roblox piano window once to begin.",
        "• After playback starts, you can switch to other applications while the notes continue in Roblox.",
        "• Perfect Mapping follows the standard 61-key Roblox piano map: white keys from 1 to m, with black keys on the matching Shifted keys. The extended 88-key piano adds 15 low and 12 high dotted keys played with Ctrl.",
        "• US QWERTY and French AZERTY are built-in exact profiles for that MAX map. Legacy Custom is still available for unusual piano experiences.",
        "• A live Terminal log window opens automatically when a song is armed, and both the outer worker shell and the playback script write into playback.log in the config folder.",
        "• The built-in MAX profiles now anchor the first white key at C2 by default. You can still override the run base, and you can still save a different base in Settings if your Roblox piano is offset.",
        "• Grant Accessibility access when macOS asks so the app can send keystrokes."
      ].join("\n");
      showDialog(APP_NAME, aboutText, ["OK"], "OK", null, "note");
    }
  }
}

function playMIDIFlow(cfg, configPath, supportDir) {
  var playback = getPlaybackStatus(supportDir);
  if (playback.active) {
    throw new Error("A background playback is already active.\n\nChoose Stop Playback from the main menu before arming another MIDI.");
  }

  var midiPath = chooseMIDIFile();
  var parsed = parseMIDIFile(midiPath);
  var notes = parsed.notes;
  var tempos = parsed.tempos;
  var division = parsed.division;

  if (division <= 0) {
    throw new Error("Unsupported MIDI timing division.");
  }
  if (notes.length === 0) {
    throw new Error("The MIDI file did not contain any note-on events.");
  }

  var profile = resolveKeyboardProfile(cfg);
  var layout = profile.steps;
  if (layout.length === 0) {
    throw new Error("The selected keyboard profile does not contain any playable keys. Open Edit Settings and choose US QWERTY, French AZERTY, or a non-empty legacy custom layout.");
  }
  validateBackgroundLayout(profile);

  var analysis = analyzeNotes(notes, profile, cfg.baseMIDINote, cfg.noteRecognitionMode);
  analysis.keyboardProfile = profile;
  var selectedBase = analysis.detectedBase;

  while (true) {
    var playbackCfg = clone(cfg);
    playbackCfg.baseMIDINote = selectedBase;
    playbackCfg.savedBaseMIDINote = analysis.savedBase;
    playbackCfg.noteRecognitionMode = analysis.noteRecognitionMode;
    playbackCfg.keyboardProfile = profile.id;
    playbackCfg.keyLayout = profile.layoutString;

    var built = buildSchedule(notes, tempos, division, playbackCfg, profile);
    var schedule = built.schedule;
    if (schedule.events.length === 0) {
      throw new Error("None of the MIDI notes fit inside the current mapping range.");
    }

    var summary = buildPlaybackSummary(midiPath, playbackCfg, profile, analysis, built, selectedBase, notes);
    var answer = showDialog(APP_NAME, summary, ["Cancel", "Edit Base Note", "Arm in Background"], "Arm in Background", "Cancel", "note");
    if (answer === "Cancel") {
      throw canceledError();
    }
    if (answer === "Edit Base Note") {
      try {
        selectedBase = promptForBaseNoteOverride(selectedBase, analysis, layout.length);
      } catch (e) {
        if (isCanceledError(e)) {
          continue;
        }
        throw e;
      }
      continue;
    }

    var armed = armBackgroundPlayback(schedule, midiPath, supportDir);
    openLiveLogWindow(supportDir, basename(midiPath));

    var readyState = waitForBackgroundWorkerReady(supportDir, armed.jobId, 6.0);
    if (readyState && readyState.status === "error") {
      throw new Error(buildPlaybackLaunchFailureMessage(supportDir, readyState.detail || "Background playback could not be armed."));
    }
    if (readyState && readyState.status === "stopped") {
      throw new Error(buildPlaybackLaunchFailureMessage(supportDir, readyState.detail || "Background playback stopped before it could arm."));
    }
    if (!isPlaybackReadyState(readyState)) {
      if (!isProcessAlive(armed.pid)) {
        var earlyState = readPlaybackState(supportDir);
        var intro = earlyState && earlyState.detail ? String(earlyState.detail) : "Background playback exited before it could arm.";
        throw new Error(buildPlaybackLaunchFailureMessage(supportDir, intro));
      }
      throw new Error(buildPlaybackLaunchFailureMessage(supportDir, "Background playback did not report a ready state, so the app is staying open instead of quitting."));
    }

    appendPlaybackLog(supportDir, "Playback armed successfully; worker reached state " + String(readyState.status || "(unknown)") + ".");
    showNotificationSafe(
      "Playback is armed. Click the Roblox piano window once to begin. A live debug log window is also opening.",
      APP_NAME,
      basename(midiPath)
    );
    return { exitAfter: true };
  }
}



function buildPlaybackSummary(midiPath, cfg, profile, analysis, built, selectedBase, notes) {
  var coverage = analysis.totalNotes > 0 ? (built.mapped * 100.0 / analysis.totalNotes) : 0;
  var runBase = clampBaseNote(selectedBase);
  var savedBase = clampBaseNote(analysis.savedBase);
  var anchor = profile.anchorIndex || 0;
  var midiRangeStart = clampBaseNote(runBase - anchor);
  var midiRangeEnd = Math.min(127, midiRangeStart + profile.steps.length - 1);
  var pianoRangeStart = clampBaseNote(savedBase - anchor);
  var pianoRangeEnd = Math.min(127, pianoRangeStart + profile.steps.length - 1);
  var rangeWord = keyboardRangeWord(profile);
  var skippedText = String(built.skipped);
  var skippedParts = [];
  if (built.skippedLow > 0) skippedParts.push(built.skippedLow + " below range");
  if (built.skippedHigh > 0) skippedParts.push(built.skippedHigh + " above range");
  if (skippedParts.length > 0) skippedText += " (" + skippedParts.join(", ") + ")";

  var autoModeText = describeAutoDetectionMode(analysis);
  var runShift = Math.round(runBase - savedBase);
  var playedShift = Math.round(savedBase - runBase);
  var recognitionLabel = noteRecognitionModeLabel(analysis.noteRecognitionMode);
  var mappingPreview = buildNoteMappingPreview(notes, profile, savedBase, runBase, 6);
  var baseMode = runBase === analysis.detectedBase ? "auto" : "manual override";
  var precisionVerdict = "";
  if (analysis.noteRecognitionMode === "perfect") {
    if (runBase !== savedBase) {
      precisionVerdict = "Manual transpose in use. This run will still use exact semitone steps, but it is no longer perfect relative to the saved piano base.";
    } else if (built.skipped === 0) {
      precisionVerdict = "Perfect. Every MIDI note fits the " + rangeWord + " Roblox range with zero hidden transposition.";
    } else {
      precisionVerdict = "Exact where playable. " + built.skipped + " out-of-range note" + (built.skipped === 1 ? "" : "s") + (built.skipped === 1 ? " falls" : " fall") + " outside the " + rangeWord + " Roblox range, so " + (built.skipped === 1 ? "it will" : "they will") + " be skipped instead of being moved.";
    }
  } else {
    precisionVerdict = built.skipped === 0 && playedShift === 0
      ? "Best fit kept the saved piano base and still covered the full song."
      : "Best fit may transpose the song to fit more notes into the available range.";
  }

  var lines = [
    "MIDI loaded and ready.",
    "",
    "File: " + basename(midiPath),
    "Keyboard profile: " + keyboardProfileLabel(profile),
    "Key map: " + keyMapDescription(profile),
    "Precision mode: " + recognitionLabel,
    "Precision verdict: " + precisionVerdict,
    "Song note span: " + noteName(analysis.minNote) + " to " + noteName(analysis.maxNote),
    "Saved piano base: " + noteLabel(savedBase),
    "Exact piano range: " + noteName(pianoRangeStart) + " to " + noteName(pianoRangeEnd),
    "Run base for this song: " + noteLabel(runBase) + " (" + baseMode + (analysis.noteRecognitionMode === "perfect" && runBase === savedBase ? ", perfect mapping" : "") + ")",
    "Recognized MIDI window: " + noteName(midiRangeStart) + " to " + noteName(midiRangeEnd),
    "Mapped notes: " + built.mapped + " / " + analysis.totalNotes + " (" + formatNumber(coverage, 1) + "%)",
    "Skipped notes: " + skippedText,
    "Approx. play time after click: " + formatNumber(built.duration + cfg.startDelaySeconds, 1) + " seconds",
    "After-click delay: " + formatNumber(cfg.startDelaySeconds, 2) + " seconds",
    "Speed: " + formatNumber(cfg.speed, 2) + "x"
  ];

  if (analysis.noteRecognitionMode !== "perfect") {
    lines.splice(8, 0, "Auto-selected run base: " + noteLabel(analysis.detectedBase) + " (" + autoModeText + ")");
    lines.splice(10, 0, "Run base shift from saved piano base: " + describeSemitoneShift(runShift));
    lines.splice(11, 0, "Resulting song transposition: " + describeSemitoneShift(playedShift));
  }

  if (mappingPreview) {
    lines.push("");
    lines.push("Exact mapping preview: " + mappingPreview);
  }

  lines.push("");
  if (analysis.noteRecognitionMode === "perfect") {
    lines.push("Perfect Mapping means the " + rangeWord + " Roblox layout is treated literally: white keys run from 1 to m, black keys are the matching Shifted keys" + (anchor > 0 ? ", the dotted keys are played with " + (normalizeExtendedModifier(cfg.extendedModifier) === "alt" ? "Option" : "Ctrl") : "") + ", C4 stays C4, and any note outside range is skipped instead of being moved.");
  } else {
    lines.push("Smart Best Fit can shift the run base to fit more of the song into range. That usually increases coverage, but it can sound transposed.");
  }
  lines.push("Choose Arm in Background, then click the Roblox piano window once.");
  lines.push("After arming, the app only closes once the background worker really reports that it is ready, so a failed start no longer looks like a silent quit.");

  return lines.join("\n");
}



function describeAutoDetectionMode(analysis) {
  if (!analysis) return "perfect mapping";
  if (analysis.noteRecognitionMode === "perfect") return "perfect mapping, no transpose";
  if (analysis.detectedMode === "chromatic") return "chromatic fallback";
  if (analysis.detectedShift === 0) return "smart best fit, kept saved base";
  return "smart best fit, shifted " + describeSemitoneShift(analysis.detectedShift);
}



// `options.language` ("en" / "fr") picks the language of the worker's
// notifications; `options.quiet` turns them off (self tests);
// `options.songName` is the name shown (the file name otherwise).
function armBackgroundPlayback(schedule, midiPath, supportDir, options) {
  options = options || {};
  ensureBackgroundPlaybackReady();

  var execPath = currentExecutablePath();
  if (!execPath) {
    throw new Error("Could not determine the app executable path for background playback.");
  }

  var mainScriptPath = currentMainScriptPath();
  if (!mainScriptPath) {
    throw new Error("Could not determine the app script path for background playback.");
  }

  removeFileIfExists(playbackStopPath(supportDir));
  removeFileIfExists(playbackPIDPath(supportDir));
  removeFileIfExists(playbackStatePath(supportDir));
  removeFileIfExists(playbackControlPath(supportDir));
  resetPlaybackLog(supportDir);
  appendPlaybackLog(supportDir, APP_NAME + " v" + APP_VERSION + " preparing background playback for " + basename(midiPath) + ".");
  appendPlaybackLog(supportDir, "Launcher executable path: " + execPath);
  appendPlaybackLog(supportDir, "Worker main.js path: " + mainScriptPath);
  appendPlaybackLog(supportDir, "Frontmost while arming: " + describeApplicationInfo(frontmostApplicationInfo()));
  appendPlaybackLog(supportDir, "Schedule summary: events=" + ((schedule && schedule.events) ? schedule.events.length : 0) + ", startDelay=" + formatNumber(schedule.startDelay || 0, 3) + "s, speed=" + formatNumber(schedule.speed || 1, 3) + "x, runBase=" + noteLabel(schedule.baseMIDINote || 0) + ", pianoBase=" + noteLabel(schedule.savedBaseMIDINote || schedule.baseMIDINote || 0) + ", keyboardProfile=" + String(schedule.keyboardProfileLabel || schedule.keyboardProfile || "Legacy Custom") + ", noteRecognition=" + noteRecognitionModeLabel(schedule.noteRecognitionMode || "perfect") + ".");
  appendPlaybackLog(supportDir, "Schedule preview: " + schedulePreviewText(schedule, 8));

  var jobId = String(new Date().getTime()) + "_" + String(Math.floor(Math.random() * 1000000));
  var jobPath = supportDir + "/" + PLAYBACK_JOB_PREFIX + jobId + ".json";
  var launchedAt = nowSeconds();

  var job = {
    jobId: jobId,
    supportDir: supportDir,
    songName: options.songName ? String(options.songName) : basename(midiPath),
    midiPath: midiPath,
    language: normalizeUILanguage(options.language) === "fr" ? "fr" : "en",
    quiet: !!options.quiet,
    createdAt: launchedAt,
    schedule: schedule
  };
  writeJSONFile(jobPath, job);
  // The control file starts at the song's own speed. The window rewrites it
  // when the speed is changed or the song is paused.
  writePlaybackControl(supportDir, { jobId: jobId, speed: schedule.speed || 1, paused: false, updatedAt: launchedAt });
  appendPlaybackLog(supportDir, "Wrote playback job " + jobId + ".");

  var launcherPath = ensureWorkerLaunchScript(supportDir, execPath, mainScriptPath, jobPath, jobId);
  appendPlaybackLog(supportDir, "Worker launch script: " + launcherPath);

  var cmd = '/usr/bin/nohup ' + shellQuote(launcherPath) + ' >/dev/null 2>&1 & echo $!';
  var pidText = trim(app.doShellScript(cmd));
  var pid = parseInt(pidText, 10);
  if (!(pid > 0)) {
    removeFileIfExists(jobPath);
    appendPlaybackLog(supportDir, "Worker launch failed: shell did not return a PID.");
    throw new Error("Could not launch the background playback worker.");
  }

  writeTextFile(playbackPIDPath(supportDir), String(pid));
  savePlaybackState(supportDir, {
    jobId: jobId,
    pid: pid,
    songName: job.songName,
    midiPath: midiPath,
    status: "launching",
    detail: "Starting background worker.",
    launcherPath: launcherPath,
    createdAt: launchedAt,
    updatedAt: launchedAt
  });
  appendPlaybackLog(supportDir, "Background worker shell launched with PID " + pid + ".");

  return { pid: pid, jobId: jobId, launcherPath: launcherPath };
}

function waitForBackgroundWorkerReady(supportDir, jobId, timeoutSeconds) {
  var end = nowSeconds() + Math.max(0.25, Number(timeoutSeconds) || 0);
  var lastState = null;
  while (nowSeconds() < end) {
    var state = readPlaybackState(supportDir);
    if (state && (!jobId || String(state.jobId || "") === String(jobId))) {
      lastState = state;
      if (state.status === "waiting" || state.status === "delay" || state.status === "playing" || state.status === "error" || state.status === "stopped") {
        return state;
      }
    }
    sleepSeconds(0.05);
  }
  return lastState;
}

function stopPlayback(supportDir) {
  var result = stopPlaybackCore(supportDir);
  if (!result.wasActive) {
    showDialog(APP_NAME, "There is no active background playback.", ["OK"], "OK", null, "note");
    return;
  }
  if (result.dead) {
    showDialog(APP_NAME, "Background playback stopped.", ["OK"], "OK", null, "note");
  } else {
    showDialog(
      APP_NAME,
      "A stop was requested, but the background worker (PID " + String(result.pid) + ") has not exited yet. It should stop within a moment. If notes keep playing, quit Roblox to be sure.",
      ["OK"], "OK", null, "caution"
    );
  }
}

// Stops the background worker and reports what happened, without any dialog,
// so both the dialog flow and the window can use it. `quiet` skips the
// notification (the window shows the result itself).
function stopPlaybackCore(supportDir, quiet) {
  var playback = getPlaybackStatus(supportDir);
  if (!playback.active) {
    // Nothing is running, so it is safe to clear any stale stop signal.
    removeFileIfExists(playbackStopPath(supportDir));
    removeFileIfExists(playbackPIDPath(supportDir));
    removeFileIfExists(playbackControlPath(supportDir));
    return { wasActive: false, dead: true, pid: 0 };
  }

  var pid = playback.pid;

  // 1. Ask the worker to stop cleanly. It checks this file ~20x/sec, then
  //    releases every key and Shift and removes its own files on the way out.
  //    IMPORTANT: we must NOT delete this file until the worker is actually
  //    gone. The old code deleted it after only 0.1s, which raced the worker's
  //    own poll and is why "Stop" sometimes did nothing.
  writeTextFile(playbackStopPath(supportDir), String(nowSeconds()));
  if (playback.state) {
    playback.state.status = "stopped";
    playback.state.detail = "Stop requested by the user.";
    playback.state.updatedAt = nowSeconds();
    savePlaybackState(supportDir, playback.state);
  }

  // 2. Give the clean soft-stop a short moment to take effect.
  waitForProcessExit(pid, 0.6);

  // 3. Still alive? Now signal the process directly. Because the launcher
  //    now `exec`s the worker, the tracked PID really is the worker that
  //    sends keys, so this reaches it (the old build killed the wrong PID).
  if (isProcessAlive(pid)) {
    tryShellKill(pid, "");
    waitForProcessExit(pid, 1.0);
  }
  if (isProcessAlive(pid)) {
    tryShellKill(pid, "-9");
    waitForProcessExit(pid, 0.5);
  }

  var dead = !isProcessAlive(pid);

  // 4. Clean up. Only remove the stop signal once the worker is confirmed
  //    gone; if it somehow survived, leave the signal so it can still notice.
  removeFileIfExists(playbackPIDPath(supportDir));
  if (dead) {
    removeFileIfExists(playbackStopPath(supportDir));
    removeFileIfExists(playbackControlPath(supportDir));
  }

  if (!quiet) {
    showNotificationSafe("Background playback stopped.", APP_NAME, playback.state && playback.state.songName ? playback.state.songName : "");
  }
  return { wasActive: true, dead: dead, pid: pid };
}

function tryShellKill(pid, flag) {
  try {
    app.doShellScript('/bin/kill ' + (flag ? (flag + ' ') : '') + String(pid) + ' >/dev/null 2>&1 || true');
  } catch (e) {
    // Ignore; the caller re-checks whether the process is still alive.
  }
}

function waitForProcessExit(pid, timeoutSeconds) {
  var end = nowSeconds() + Math.max(0, Number(timeoutSeconds) || 0);
  while (nowSeconds() < end) {
    if (!isProcessAlive(pid)) return true;
    sleepSeconds(0.05);
  }
  return !isProcessAlive(pid);
}

function getPlaybackStatus(supportDir) {
  var state = readPlaybackState(supportDir);
  var pid = 0;

  if (state && state.pid != null) {
    pid = parseInt(String(state.pid), 10);
  }
  if (!(pid > 0)) {
    var pidText = readTextFileIfExists(playbackPIDPath(supportDir));
    if (pidText) {
      pid = parseInt(trim(pidText), 10);
    }
  }

  var active = pid > 0 && isProcessAlive(pid);

  if (!active) {
    removeFileIfExists(playbackPIDPath(supportDir));
    removeFileIfExists(playbackStopPath(supportDir));
    if (state && (state.status === "launching" || state.status === "waiting" || state.status === "delay" || state.status === "playing")) {
      state.status = "stopped";
      state.detail = "Background worker is no longer running.";
      state.updatedAt = nowSeconds();
      savePlaybackState(supportDir, state);
    }
  } else if (state && state.pid !== pid) {
    state.pid = pid;
    state.updatedAt = nowSeconds();
    savePlaybackState(supportDir, state);
  }

  state = readPlaybackState(supportDir);
  return {
    active: active,
    pid: active ? pid : 0,
    state: state,
    statusText: playbackStatusText(state, active)
  };
}

function playbackStatusText(state, active) {
  if (!state) return "";
  var song = state.songName ? String(state.songName) : "MIDI";
  if (active) {
    if (state.status === "launching") return "Background playback: starting " + song;
    if (state.status === "waiting") return "Background playback: armed for Roblox — " + song;
    if (state.status === "delay") return "Background playback: Roblox detected — " + song;
    if (state.status === "playing") return "Background playback: playing " + song;
    return "Background playback: active — " + song;
  }
  if (state.status === "error") {
    return "Last background error: " + shortText(state.detail || "Unknown error.", 120);
  }
  return "";
}

function playbackLogPath(supportDir) {
  return supportDir + "/" + PLAYBACK_LOG_FILE;
}

function resetPlaybackLog(supportDir) {
  try {
    writeTextFile(playbackLogPath(supportDir), "");
    return;
  } catch (e) {
    // Fall through to the shell fallback.
  }

  try {
    app.doShellScript('/usr/bin/printf "" > ' + shellQuote(playbackLogPath(supportDir)));
  } catch (_) {
    // Ignore optional logging setup errors.
  }
}

function appendPlaybackLog(supportDir, message) {
  if (!supportDir) return;

  var path = playbackLogPath(supportDir);
  var line = "[" + (new Date()).toISOString() + "] " + String(message || "");
  var wrote = false;

  try {
    if (!$.NSFileManager.defaultManager.fileExistsAtPath($(path))) {
      writeTextFile(path, "");
    }

    var fh = $.NSFileHandle.fileHandleForWritingAtPath($(path));
    if (fh) {
      fh.seekToEndOfFile;
      fh.writeData($(line + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
      fh.closeFile;
      wrote = true;
    }
  } catch (e) {
    wrote = false;
  }

  if (!wrote) {
    try {
      app.doShellScript('/usr/bin/touch ' + shellQuote(path) + ' && /usr/bin/printf ' + shellQuote('%s\n') + ' ' + shellQuote(line) + ' >> ' + shellQuote(path));
    } catch (_) {
      // Ignore optional logging failures.
    }
  }
}

function createPlaybackTraceWriter(supportDir) {
  if (!supportDir) {
    return {
      write: function(_) {},
      close: function() {}
    };
  }

  try {
    var path = playbackLogPath(supportDir);
    if (!$.NSFileManager.defaultManager.fileExistsAtPath($(path))) {
      writeTextFile(path, "");
    }
    var fh = $.NSFileHandle.fileHandleForWritingAtPath($(path));
    if (!fh) throw new Error("Could not open the playback log for appending.");
    fh.seekToEndOfFile;
    return {
      write: function(message) {
        try {
          var line = "[" + (new Date()).toISOString() + "] " + String(message || "") + "\n";
          fh.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding));
        } catch (_) {
          // Ignore per-line trace failures.
        }
      },
      close: function() {
        try {
          fh.closeFile;
        } catch (_) {
          // Ignore close failures.
        }
      }
    };
  } catch (e) {
    appendPlaybackLog(supportDir, "Could not create the detailed playback trace writer: " + messageOf(e));
    return {
      write: function(_) {},
      close: function() {}
    };
  }
}

function recentPlaybackLogExcerpt(supportDir, maxLines) {
  var text = readTextFileIfExists(playbackLogPath(supportDir));
  if (!text) return "";

  var lines = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  maxLines = Math.max(1, Number(maxLines) || 10);
  if (lines.length > maxLines) {
    lines = lines.slice(lines.length - maxLines);
  }
  return lines.join("\n");
}

function buildPlaybackLaunchFailureMessage(supportDir, intro) {
  intro = String(intro || "Background playback could not be armed.");
  var excerpt = recentPlaybackLogExcerpt(supportDir, 12);
  if (excerpt) {
    return intro + "\n\nRecent playback log:\n" + excerpt;
  }
  return intro + "\n\nThe playback log is still empty, which usually means the worker never reached the script logic that writes its normal startup trace.";
}

function isPlaybackReadyState(state) {
  if (!state) return false;
  var status = String(state.status || "");
  return status === "waiting" || status === "delay" || status === "playing";
}

function liveLogLauncherPath(supportDir) {
  return supportDir + "/open_live_log.command";
}

function ensureLiveLogLauncher(supportDir, songName) {
  var scriptPath = liveLogLauncherPath(supportDir);
  var logPath = playbackLogPath(supportDir);
  var scriptText = [
    "#!/bin/sh",
    "LOG_PATH=" + shellQuote(logPath),
    "SONG_NAME=" + shellQuote(songName || ""),
    "clear",
    "printf '%s\n' 'Roblox MIDI Piano Player live log'",
    "printf '%s\n' 'Close this Terminal window whenever you like. Playback keeps running.'",
    "printf '\n'",
    'printf "Song: %s\n" "$SONG_NAME"',
    'printf "Log file: %s\n\n" "$LOG_PATH"',
    '/usr/bin/touch "$LOG_PATH"',
    'exec /usr/bin/tail -n 200 -F "$LOG_PATH"'
  ].join("\n") + "\n";
  writeTextFile(scriptPath, scriptText);
  app.doShellScript('/bin/chmod 755 ' + shellQuote(scriptPath));
  return scriptPath;
}

function openLiveLogWindow(supportDir, songName) {
  if (!supportDir) return;
  try {
    var scriptPath = ensureLiveLogLauncher(supportDir, songName || "");
    app.doShellScript('/usr/bin/open -g -a Terminal ' + shellQuote(scriptPath));
    appendPlaybackLog(supportDir, "Requested the live log window in Terminal.");
  } catch (e) {
    appendPlaybackLog(supportDir, "Could not open the live log window automatically: " + messageOf(e));
  }
}

function playbackStatePath(supportDir) {
  return supportDir + "/" + PLAYBACK_STATE_FILE;
}

function playbackPIDPath(supportDir) {
  return supportDir + "/" + PLAYBACK_PID_FILE;
}

function playbackStopPath(supportDir) {
  return supportDir + "/" + PLAYBACK_STOP_FILE;
}

function playbackControlPath(supportDir) {
  return supportDir + "/" + PLAYBACK_CONTROL_FILE;
}

// { jobId, speed, paused } — or null when there is none or it cannot be read
// (a half-written file is simply read again on the next poll).
function readPlaybackControl(supportDir) {
  try {
    return readJSONFile(playbackControlPath(supportDir));
  } catch (e) {
    return null;
  }
}

function writePlaybackControl(supportDir, control) {
  writeJSONFile(playbackControlPath(supportDir), control);
}

function workerLaunchScriptPath(supportDir) {
  return supportDir + "/launch_playback_worker.sh";
}

function ensureWorkerLaunchScript(supportDir, execPath, mainScriptPath, jobPath, jobId) {
  var scriptPath = workerLaunchScriptPath(supportDir);
  var logPath = playbackLogPath(supportDir);
  var scriptText = [
    "#!/bin/bash",
    "set -u",
    "export ROBLOX_MIDI_PLAYER_EXECUTABLE=" + shellQuote(execPath || ""),
    "MAIN_JS=" + shellQuote(mainScriptPath || ""),
    "JOB_PATH=" + shellQuote(jobPath || ""),
    "LOG_PATH=" + shellQuote(logPath),
    "JOB_ID=" + shellQuote(jobId || ""),
    'timestamp() { /bin/date -u "+%Y-%m-%dT%H:%M:%SZ"; }',
    'log_line() { /usr/bin/printf "[%s] %s\\n" "$(timestamp)" "$1" >> "$LOG_PATH"; }',
    '/usr/bin/touch "$LOG_PATH"',
    'log_line "Worker shell starting. jobId=$JOB_ID main.js=$MAIN_JS job=$JOB_PATH"',
    // `exec` replaces this shell with osascript so the PID we captured with
    // `echo $!` at launch time IS the worker that sends keys. That is what lets
    // Stop reliably signal the real process; the old build killed this bash
    // wrapper while the osascript child kept playing.
    'exec /usr/bin/osascript -l JavaScript "$MAIN_JS" --worker "$JOB_PATH" >> "$LOG_PATH" 2>&1'
  ].join("\n") + "\n";
  writeTextFile(scriptPath, scriptText);
  app.doShellScript('/bin/chmod 755 ' + shellQuote(scriptPath));
  return scriptPath;
}

function currentExecutablePath() {
  try {
    var env = $.NSProcessInfo.processInfo.environment;
    var path = unwrapMaybe(env.objectForKey($("ROBLOX_MIDI_PLAYER_EXECUTABLE")));
    if (path) return String(path);
  } catch (e) {
    // Ignore.
  }
  return "";
}

function currentMainScriptPath() {
  try {
    var execPath = currentExecutablePath();
    var marker = "/Contents/MacOS/";
    var idx = execPath.lastIndexOf(marker);
    if (idx >= 0) {
      var byExec = execPath.slice(0, idx) + "/Contents/Resources/main.js";
      if ($.NSFileManager.defaultManager.fileExistsAtPath($(byExec))) {
        return byExec;
      }
    }
  } catch (e) {
    // Ignore.
  }

  try {
    var resourcePath = unwrapMaybe($.NSBundle.mainBundle.resourcePath);
    if (resourcePath) {
      var byBundle = String(resourcePath) + "/main.js";
      if ($.NSFileManager.defaultManager.fileExistsAtPath($(byBundle))) {
        return byBundle;
      }
    }
  } catch (e2) {
    // Ignore.
  }

  return "";
}

function savePlaybackState(supportDir, state) {
  writeJSONFile(playbackStatePath(supportDir), state);
}

function readPlaybackState(supportDir) {
  return readJSONFile(playbackStatePath(supportDir));
}

function readJSONFile(path) {
  if (!$.NSFileManager.defaultManager.fileExistsAtPath($(path))) {
    return null;
  }
  return JSON.parse(readTextFile(path));
}

function writeJSONFile(path, value) {
  writeTextFile(path, JSON.stringify(value, null, 2));
}

function writeTextFile(path, text) {
  var ok = $(String(text)).writeToFileAtomicallyEncodingError($(path), true, $.NSUTF8StringEncoding, null);
  if (!ok) {
    throw new Error("Could not write file: " + path);
  }
}

function readTextFileIfExists(path) {
  if (!$.NSFileManager.defaultManager.fileExistsAtPath($(path))) {
    return "";
  }
  return readTextFile(path);
}

function removeFileIfExists(path) {
  try {
    if ($.NSFileManager.defaultManager.fileExistsAtPath($(path))) {
      $.NSFileManager.defaultManager.removeItemAtPathError($(path), null);
    }
  } catch (e) {
    // Ignore cleanup errors.
  }
}

function isProcessAlive(pid) {
  pid = parseInt(String(pid), 10);
  if (!(pid > 0)) return false;
  // kill(pid, 0) sends no signal; it only asks whether the process exists. It
  // is far cheaper than spawning a shell, which matters now that the window
  // polls the playback state twice a second.
  try {
    if ($.kill) return Number($.kill(pid, 0)) === 0;
  } catch (_) {
    // Fall back to the shell below.
  }
  try {
    app.doShellScript('/bin/kill -0 ' + String(pid) + ' >/dev/null 2>&1');
    return true;
  } catch (e) {
    return false;
  }
}

// The worker's notifications, in the language the window was using when the
// song was armed.
var WORKER_STRINGS = {
  en: {
    armed: "Armed. Click the Roblox piano window once to begin. You can switch to other apps while it plays.",
    stillArmed: "Still armed. Click the Roblox piano window to begin playback.",
    startingIn: "Roblox detected. Playback begins in {s} seconds.",
    finished: "Playback finished.",
    stopped: "Playback stopped.",
    error: "Playback hit an error. Click Open log in the app window for details."
  },
  fr: {
    armed: "Armé. Clique une fois sur la fenêtre du piano Roblox pour commencer. Tu peux passer à d'autres apps pendant la lecture.",
    stillArmed: "Toujours armé. Clique sur la fenêtre du piano Roblox pour lancer la lecture.",
    startingIn: "Roblox détecté. La lecture commence dans {s} secondes.",
    finished: "Lecture terminée.",
    stopped: "Lecture arrêtée.",
    error: "La lecture a rencontré une erreur. Clique sur Journal dans la fenêtre de l'app pour les détails."
  }
};

function workerNotify(job, key, vars) {
  if (job && job.quiet) return;
  showNotificationSafe(workerText(job, key, vars), APP_NAME, job && job.songName ? job.songName : "");
}

function workerText(job, key, vars) {
  var table = WORKER_STRINGS[job && job.language === "fr" ? "fr" : "en"];
  var text = String(table[key] != null ? table[key] : WORKER_STRINGS.en[key]);
  if (vars) {
    for (var k in vars) {
      if (vars.hasOwnProperty(k)) text = text.split("{" + k + "}").join(String(vars[k]));
    }
  }
  return text;
}

function workerMain(jobPath) {
  var job = readJSONFile(jobPath);
  if (!job || !job.supportDir || !job.schedule || !job.schedule.events) {
    throw new Error("Invalid playback job.");
  }

  var supportDir = String(job.supportDir);
  appendPlaybackLog(supportDir, "Worker booting for job " + String(job.jobId || "") + ".");
  appendPlaybackLog(supportDir, "Worker process PID: " + currentProcessId() + ".");
  appendPlaybackLog(supportDir, "Operating system: " + (currentOperatingSystemVersionText() || "(unknown)") + ".");
  appendPlaybackLog(supportDir, "Worker executable path: " + (currentExecutablePath() || "(unknown)"));
  appendPlaybackLog(supportDir, "Worker bundle path: " + (currentAppBundlePath() || "(unknown)"));
  appendPlaybackLog(supportDir, "Worker schedule preview: " + schedulePreviewText(job.schedule, 12));
  appendPlaybackLog(supportDir, "Frontmost at worker start: " + describeApplicationInfo(frontmostApplicationInfo()));
  var bootCaps = directInputCapabilities();
  appendPlaybackLog(supportDir, "Direct input capabilities: AX=" + bootCaps.ax + ", CG=" + bootCaps.cg + ".");
  appendPlaybackLog(supportDir, "Accessibility trusted: " + describeAccessibilityTrustStatus() + ".");

  ensureBackgroundPlaybackReady();
  appendPlaybackLog(supportDir, "Background input prerequisites passed.");

  var pid = 0;
  try {
    pid = parseInt(trim(readTextFileIfExists(playbackPIDPath(supportDir))), 10);
  } catch (e) {
    pid = 0;
  }

  savePlaybackState(supportDir, {
    jobId: job.jobId || "",
    pid: pid > 0 ? pid : 0,
    songName: job.songName || basename(job.midiPath || ""),
    midiPath: job.midiPath || "",
    status: "waiting",
    detail: "Armed. Click Roblox to start playback.",
    createdAt: job.createdAt || nowSeconds(),
    updatedAt: nowSeconds()
  });
  appendPlaybackLog(supportDir, "Worker armed and waiting for Roblox.");

  workerNotify(job, "armed");

  try {
    var frontmost = waitForRobloxFrontmost(supportDir, job);
    var targetPid = frontmost.pid;
    appendPlaybackLog(supportDir, "Roblox became frontmost with PID " + targetPid + ".");

    savePlaybackState(supportDir, {
      jobId: job.jobId || "",
      pid: pid > 0 ? pid : 0,
      songName: job.songName || basename(job.midiPath || ""),
      midiPath: job.midiPath || "",
      status: "delay",
      detail: job.schedule.startDelay > 0
        ? ("Roblox detected. Starting in " + formatNumber(job.schedule.startDelay, 2) + " seconds.")
        : "Roblox detected. Starting now.",
      targetPid: targetPid,
      createdAt: job.createdAt || nowSeconds(),
      updatedAt: nowSeconds()
    });

    if (job.schedule.startDelay > 0) {
      appendPlaybackLog(supportDir, "Waiting the after-click delay of " + formatNumber(job.schedule.startDelay, 2) + " seconds.");
      // Only worth a notification when the wait is long enough to notice.
      if (job.schedule.startDelay >= 1.5) {
        workerNotify(job, "startingIn", { s: formatNumber(job.schedule.startDelay, 1) });
      }
      waitWithStop(supportDir, job.schedule.startDelay);
    } else {
      appendPlaybackLog(supportDir, "No after-click delay; starting immediately.");
    }

    savePlaybackState(supportDir, {
      jobId: job.jobId || "",
      pid: pid > 0 ? pid : 0,
      songName: job.songName || basename(job.midiPath || ""),
      midiPath: job.midiPath || "",
      status: "playing",
      detail: "Sending notes directly to Roblox. You can switch apps while it plays.",
      targetPid: targetPid,
      totalEvents: job.schedule.events.length,
      createdAt: job.createdAt || nowSeconds(),
      updatedAt: nowSeconds()
    });
    appendPlaybackLog(supportDir, "Playback starting with " + job.schedule.events.length + " events.");

    performPlaybackToPid(job.schedule, targetPid, supportDir, job);

    savePlaybackState(supportDir, {
      jobId: job.jobId || "",
      pid: 0,
      songName: job.songName || basename(job.midiPath || ""),
      midiPath: job.midiPath || "",
      status: "finished",
      detail: "Playback finished.",
      targetPid: targetPid,
      totalEvents: job.schedule.events.length,
      createdAt: job.createdAt || nowSeconds(),
      updatedAt: nowSeconds()
    });
    appendPlaybackLog(supportDir, "Playback finished normally.");
    workerNotify(job, "finished");
  } catch (e) {
    if (isCanceledError(e)) {
      savePlaybackState(supportDir, {
        jobId: job.jobId || "",
        pid: 0,
        songName: job.songName || basename(job.midiPath || ""),
        midiPath: job.midiPath || "",
        status: "stopped",
        detail: "Playback stopped.",
        createdAt: job.createdAt || nowSeconds(),
        updatedAt: nowSeconds()
      });
      appendPlaybackLog(supportDir, "Playback stopped.");
      workerNotify(job, "stopped");
    } else {
      savePlaybackState(supportDir, {
        jobId: job.jobId || "",
        pid: 0,
        songName: job.songName || basename(job.midiPath || ""),
        midiPath: job.midiPath || "",
        status: "error",
        detail: messageOf(e),
        createdAt: job.createdAt || nowSeconds(),
        updatedAt: nowSeconds()
      });
      appendPlaybackLog(supportDir, "Playback error: " + messageOf(e));
      workerNotify(job, "error");
    }
  } finally {
    appendPlaybackLog(supportDir, "Worker cleanup.");
    removeFileIfExists(playbackPIDPath(supportDir));
    removeFileIfExists(playbackStopPath(supportDir));
    removeOwnControlFile(supportDir, job.jobId);
    removeFileIfExists(jobPath);
  }
}

// Removes the control file only when it belongs to this job, so a worker that
// ends late can never delete the control file of a song armed after it.
function removeOwnControlFile(supportDir, jobId) {
  var control = readPlaybackControl(supportDir);
  if (control && String(control.jobId || "") === String(jobId || "")) {
    removeFileIfExists(playbackControlPath(supportDir));
  }
}

function workerFatal(jobPath, e) {
  try {
    var job = readJSONFile(jobPath);
    if (job && job.supportDir) {
      appendPlaybackLog(String(job.supportDir), "Fatal worker error before normal init: " + messageOf(e));
      savePlaybackState(String(job.supportDir), {
        jobId: job.jobId || "",
        pid: 0,
        songName: job.songName || basename(job.midiPath || ""),
        midiPath: job.midiPath || "",
        status: "error",
        detail: messageOf(e),
        createdAt: job.createdAt || nowSeconds(),
        updatedAt: nowSeconds()
      });
      removeFileIfExists(playbackPIDPath(String(job.supportDir)));
      removeFileIfExists(playbackStopPath(String(job.supportDir)));
      removeOwnControlFile(String(job.supportDir), job.jobId);
      removeFileIfExists(jobPath);
      workerNotify(job, "error");
      return;
    }
  } catch (_) {
    // Ignore.
  }
}

function waitForRobloxFrontmost(supportDir, job) {
  var waited = 0;
  var lastSeenKey = "";
  var candidatePid = 0;
  var candidateSince = 0;

  while (true) {
    if (stopRequested(supportDir)) {
      throw canceledError();
    }

    var info = frontmostApplicationInfo();
    var infoKey = [String(info.name || ""), String(info.bundleIdentifier || ""), String(info.path || ""), String(info.pid || 0)].join("\n");
    if (infoKey !== lastSeenKey) {
      appendPlaybackLog(supportDir, "Frontmost application changed: " + describeApplicationInfo(info));
      lastSeenKey = infoKey;
    }

    if (isRobloxApplicationInfo(info) && info.pid > 0) {
      if (candidatePid !== info.pid) {
        candidatePid = info.pid;
        candidateSince = nowSeconds();
        appendPlaybackLog(supportDir, "Roblox candidate detected: " + describeApplicationInfo(info));
      } else if (nowSeconds() - candidateSince >= 0.15) {
        appendPlaybackLog(supportDir, "Roblox confirmed as frontmost target: " + describeApplicationInfo(info));
        return info;
      }
    } else {
      candidatePid = 0;
      candidateSince = 0;
    }

    sleepSeconds(0.05);
    waited += 0.05;

    if (waited >= WAIT_FOR_ROBLOX_PROMPT_SECONDS) {
      workerNotify(job, "stillArmed");
      waited = 0;
    }
  }
}

function waitWithStop(supportDir, seconds) {
  var end = nowSeconds() + Math.max(0, Number(seconds) || 0);
  while (true) {
    if (stopRequested(supportDir)) {
      throw canceledError();
    }
    var remaining = end - nowSeconds();
    if (remaining <= 0) {
      return;
    }
    if (remaining > 0.25) {
      sleepSeconds(0.1);
    } else if (remaining > 0.05) {
      sleepSeconds(0.02);
    } else if (remaining > 0.01) {
      sleepSeconds(0.005);
    } else if (remaining > 0.003) {
      sleepSeconds(0.001);
    }
  }
}

function stopRequested(supportDir) {
  return $.NSFileManager.defaultManager.fileExistsAtPath($(playbackStopPath(supportDir)));
}

function performPlaybackToPid(schedule, targetPid, supportDir, job) {
  if (!isApplicationRunning(targetPid)) {
    throw new Error("The selected Roblox process is no longer running.");
  }

  var events = schedule.events || [];
  var sender = createDirectKeySender(targetPid, supportDir, schedule.keySendMethod);
  var ctrl = createKeyController(sender, schedule.modifierKeyCode);
  var targetInfo = applicationInfoForPid(targetPid);
  var trace = createPlaybackTraceWriter(supportDir);
  // Live speed / pause requests from the window (see CONTROL_POLL_SECONDS).
  var live = createLiveControl(supportDir, job, schedule);
  var timeline = createPlaybackTimeline();
  var songLength = scheduleLengthSeconds(schedule);

  appendPlaybackLog(supportDir, "Direct key sender mode: " + sender.mode + ".");
  appendPlaybackLog(supportDir, "Target application info: " + describeApplicationInfo(targetInfo));
  trace.write("Detailed playback trace starting. senderMode=" + sender.mode + ", target=" + describeApplicationInfo(targetInfo) + ".");

  // Everything the window shows comes from here. Positions are song seconds
  // at 1x, so the clock reads the same whatever the speed. The worker's own
  // pid is written too: with it missing, the window would rewrite the file
  // (getPlaybackStatus) and could undo a state saved in between.
  var progress = 0;
  var workerPid = currentProcessId();
  function saveState(now, position, extra) {
    var state = {
      jobId: job.jobId || "",
      pid: workerPid,
      songName: job.songName || basename(job.midiPath || ""),
      midiPath: job.midiPath || "",
      status: "playing",
      detail: live.paused ? "Paused." : "Sending notes directly to Roblox. You can switch apps while it plays.",
      targetPid: targetPid,
      targetApp: targetInfo,
      senderMode: sender.mode,
      progressEvents: progress,
      totalEvents: events.length,
      positionSeconds: Math.max(0, Math.min(songLength, position)) * live.baseSpeed,
      durationSeconds: songLength * live.baseSpeed,
      speed: live.speed,
      paused: live.paused,
      createdAt: job.createdAt || now,
      updatedAt: now
    };
    if (extra) {
      for (var k in extra) {
        if (extra.hasOwnProperty(k)) state[k] = extra[k];
      }
    }
    savePlaybackState(supportDir, state);
  }

  // Paused: let go of every key, then wait (still honouring Stop) until the
  // window resumes. The song picks up exactly where it stopped.
  function holdPause(position) {
    try { ctrl.releaseAll(); } catch (_) {}
    appendPlaybackLog(supportDir, "Paused at " + formatNumber(position * live.baseSpeed, 2) + "s.");
    saveState(nowSeconds(), position);
    var lastAliveCheck = nowSeconds();
    while (live.paused) {
      if (stopRequested(supportDir)) {
        throw canceledError();
      }
      sleepSeconds(0.05);
      var now = nowSeconds();
      live.poll(now, true);
      if (now - lastAliveCheck >= 1) {
        lastAliveCheck = now;
        if (!isApplicationRunning(targetPid)) {
          throw new Error("The selected Roblox process closed during playback.");
        }
      }
    }
    var resumedAt = nowSeconds();
    timeline.restart(resumedAt, position, live.rate());
    appendPlaybackLog(supportDir, "Resumed at " + formatNumber(live.speed, 2) + "x.");
    saveState(resumedAt, position);
  }

  // A new speed (or a pause) takes effect from the current position: the
  // timeline is re-anchored on "now", so nothing jumps and nothing rushes.
  function applyLiveChange() {
    var now = nowSeconds();
    var position = timeline.positionAt(now);
    if (live.paused) {
      holdPause(position);
      return;
    }
    timeline.restart(now, position, live.rate());
    appendPlaybackLog(supportDir, "Speed changed to " + formatNumber(live.speed, 2) + "x at " + formatNumber(position * live.baseSpeed, 2) + "s.");
    saveState(now, position);
  }

  // Anchor the schedule to the moment the loop actually begins so the very
  // first note is not already late by setup time.
  live.poll(nowSeconds(), true);
  var start = nowSeconds();
  timeline.restart(start, 0, live.rate());
  saveState(start, 0);
  if (live.paused) {
    // Paused while still armed: wait here, before the first note.
    holdPause(0);
    start = nowSeconds();
  }

  var lastStateRefresh = start;
  var maxDrift = 0;
  var maxSlip = 0;

  try {
    var i = 0;
    while (i < events.length) {
      // Check the stop signal every chord, independently of the wait below.
      // When playback is running behind (a very dense song), waitForOnset
      // returns immediately and would otherwise never look at the stop file,
      // so a soft Stop could be missed exactly when it matters most.
      if (stopRequested(supportDir)) {
        throw canceledError();
      }
      // The same goes for the speed and pause controls (rate-limited inside).
      if (live.poll(nowSeconds(), false)) {
        applyLiveChange();
      }

      var ev = events[i];
      var chordTime = Number(ev.t || 0);

      // Work out the whole chord BEFORE waiting, for two reasons: none of this
      // preparation then sits between the wait and the keystroke, and knowing
      // which keys are coming lets us pre-release them during the gap.
      //
      // Group every note within a hair of this instant into one chord. A
      // small epsilon (not exact equality) keeps slightly-humanized chords
      // together instead of smearing them into a fast, uneven arpeggio.
      var chordEnd = i;
      while (
        chordEnd + 1 < events.length &&
        (Number(events[chordEnd + 1].t || 0) - chordTime) <= CHORD_EPSILON_SECONDS
      ) {
        chordEnd++;
      }
      var chordSize = chordEnd - i + 1;

      var specs = [];
      for (var c = i; c <= chordEnd; c++) {
        var sp = eventKeySpec(events[c]);
        if (sp) {
          // The event, so the hold can be worked out at the speed in force
          // when the chord is actually pressed.
          sp.ev = events[c];
          // Pitch order, so a big chord rolls out bottom-up like a real one.
          sp.pitch = events[c].stepIndex != null
            ? Number(events[c].stepIndex)
            : (events[c].sourceMIDINote != null ? Number(events[c].sourceMIDINote) : 0);
          specs.push(sp);
        }
      }

      // Keys this chord is about to press. Any of them still held from an
      // earlier note would otherwise have to be released mid-chord, doubling
      // that note's cost right when we can least afford it, so we hand the list
      // to the wait below and let it clear them during the gap instead.
      var upcomingCodes = {};
      for (var uc = 0; uc < specs.length; uc++) {
        upcomingCodes[specs[uc].code] = true;
      }

      // If we owe time from an earlier over-run, claw a little of it back during
      // a rest. Shortening a rest slightly is far less audible than squeezing
      // the gaps between notes, which is what made dense passages wobble.
      if (timeline.slip > 0) {
        var untilOnset = timeline.wallTimeFor(chordTime) - nowSeconds();
        if (untilOnset > SLIP_REST_SECONDS) {
          var recover = Math.min(
            timeline.slip,
            (untilOnset - SLIP_REST_SECONDS) * SLIP_RECOVER_FRACTION,
            SLIP_RECOVER_MAX_SECONDS
          );
          if (recover > 0) timeline.slip -= recover;
        }
      }

      // Wait for this chord's instant. The idle time is spent on key RELEASES
      // (budgeted so they can never delay the note-on), which keeps the actual
      // keystrokes the only thing on the timeline's critical path. A speed
      // change or a pause during the wait moves the instant, so wait again.
      var onsetWall = timeline.wallTimeFor(chordTime);
      while (waitForOnset(onsetWall, ctrl, supportDir, upcomingCodes, live)) {
        applyLiveChange();
        onsetWall = timeline.wallTimeFor(chordTime);
      }

      var beforeSend = nowSeconds();
      var drift = beforeSend - onsetWall;
      if (drift > maxDrift) maxDrift = drift;

      // How long to hold each key: the note's real length from the MIDI at the
      // current speed, clamped to sane bounds; a default when the MIDI had no
      // note-off.
      for (var hs = 0; hs < specs.length; hs++) {
        specs[hs].hold = holdSecondsForEvent(specs[hs].ev, timeline.rate);
      }

      // Press the chord's key DOWNS now (releases happen later, in the gaps).
      try {
        ctrl.playChord(specs, beforeSend);
      } catch (sendError) {
        appendPlaybackLog(
          supportDir,
          "Direct key send failed at event " + (i + 1) + "/" + events.length +
            (chordSize > 1 ? (" (chord of " + chordSize + ")") : "") +
            (ev.sourceMIDINote != null ? (" note=" + noteName(ev.sourceMIDINote)) : "") +
            " key=" + formatPreviewKeyLabel(specs.length ? specs[0].label : (ev.k || "?")) +
            " mode=" + sender.mode + ". " + messageOf(sendError)
        );
        throw sendError;
      }
      progress = chordEnd + 1;

      // Pressing a fat chord takes real time. If that pushed us past the next
      // note's slot, shift the WHOLE remaining timeline by the overrun instead
      // of letting the backlog fire off back-to-back. The next note is then the
      // only one that lands late, and everything after it keeps its proper
      // spacing — a steady pulse a few ms later, rather than a rushed burst.
      var nextIdx = chordEnd + 1;
      if (nextIdx < events.length) {
        var nextTarget = timeline.wallTimeFor(Number(events[nextIdx].t || 0));
        var earliestNext = nowSeconds();
        var overrun = earliestNext - nextTarget;
        if (overrun > SLIP_TRIGGER_SECONDS) {
          timeline.slip += overrun;
          if (timeline.slip > maxSlip) maxSlip = timeline.slip;
        }
      }

      var spec0 = specs.length ? specs[0] : eventKeySpec(ev);
      var shouldTrace = (i < 32 || chordEnd === events.length - 1 || (((chordEnd + 1) % 128) === 0));
      if (shouldTrace) {
        trace.write(
          "Event " + (i + 1) + "/" + events.length +
          (chordSize > 1 ? (" (chord of " + chordSize + ")") : "") +
          ": scheduled=" + formatNumber(chordTime, 4) + "s" +
          ", actual=" + formatNumber(beforeSend - start, 4) + "s" +
          ", drift=" + formatNumber(drift, 4) + "s" +
          (live.speed !== live.baseSpeed ? (", speed=" + formatNumber(live.speed, 2) + "x") : "") +
          (ev.sourceMIDINote != null ? (", source=" + noteName(ev.sourceMIDINote)) : "") +
          (ev.playedMIDINote != null ? (", played=" + noteName(ev.playedMIDINote)) : "") +
          ", key=" + formatPreviewKeyLabel(spec0 && spec0.label != null ? spec0.label : (ev.k || "?")) +
          (spec0 ? (", keyCode=" + spec0.code + (spec0.shift ? "+shift" : "") + (spec0.ctrl ? "+ctrl" : "")) : ", keyCode=?") +
          ", mode=" + sender.mode
        );
      }

      if (((i % 128) === 0) && !isApplicationRunning(targetPid)) {
        throw new Error("The selected Roblox process closed during playback.");
      }

      var now = nowSeconds();
      if (i === 0 || chordEnd === events.length - 1 || now - lastStateRefresh >= 1) {
        saveState(now, timeline.positionAt(now), {
          lastEventIndex: chordEnd + 1,
          lastEventKey: spec0 && spec0.label != null ? String(spec0.label) : String(ev.k || ""),
          lastEventMIDINote: ev.sourceMIDINote != null ? ev.sourceMIDINote : null,
          lastEventPlayedMIDINote: ev.playedMIDINote != null ? ev.playedMIDINote : null,
          lastEventScheduledSeconds: chordTime,
          lastEventActualSeconds: now - start
        });
        lastStateRefresh = now;
      }

      i = chordEnd + 1;
    }

    // Let the last notes ring for their written length instead of cutting
    // them off the instant the final chord is pressed (Stop still works).
    var ringUntil = nowSeconds() + MAX_HOLD_SECONDS + 0.1;
    while (ctrl.held.length > 0 && nowSeconds() < ringUntil) {
      if (stopRequested(supportDir)) {
        throw canceledError();
      }
      var tNow = nowSeconds();
      // Pausing now would only hold the last notes: let go and finish.
      live.poll(tNow, false);
      if (live.paused) break;
      ctrl.flushDue(tNow, tNow + 10, MAX_RELEASES_PER_GAP, null);
      if (ctrl.held.length > 0) sleepSeconds(0.02);
    }
  } finally {
    // Always let go of every key and the Shift/Ctrl modifiers, whether we
    // finished normally or were stopped mid-song. This guarantees a stopped
    // song never leaves a note ringing or a modifier stuck down in Roblox.
    try { ctrl.releaseAll(); } catch (_) {}
    trace.write("Detailed playback trace ending. maxDrift=" + formatNumber(maxDrift, 4) + "s, maxTimelineSlip=" + formatNumber(maxSlip, 4) + "s, measuredKeyCost=" + formatNumber((ctrl.keyCost || 0) * 1000, 1) + "ms.");
    trace.close();
    if (sender) sender.close();
    // If we ended up well behind schedule, the song has more notes per second
    // than the chosen key-send method can deliver in real time. Say so plainly,
    // and point at the two things that actually help.
    if (maxDrift > 1.0) {
      appendPlaybackLog(
        supportDir,
        "Note: this song fell up to " + formatNumber(maxDrift, 1) + "s behind schedule. It is very " +
        "chord-dense — more notes per second than the key sender can deliver in real time. " +
        "Try the Quartz key-send method in Settings (much faster), or lower Speed (e.g. 0.8x)."
      );
    }
  }
}

// Maps song positions (schedule seconds) to wall-clock times. `rate` is how
// many schedule seconds pass per real second (1 = the speed the song was armed
// at); `slip` is the over-run shift described with the SLIP_* constants. Every
// speed change or pause restarts it at the current position.
function createPlaybackTimeline() {
  return {
    anchorWall: 0,
    anchorPosition: 0,
    rate: 1,
    slip: 0,
    wallTimeFor: function(position) {
      return this.anchorWall + (position - this.anchorPosition) / this.rate + this.slip;
    },
    positionAt: function(wall) {
      return this.anchorPosition + (wall - this.anchorWall - this.slip) * this.rate;
    },
    restart: function(wall, position, rate) {
      this.anchorWall = wall;
      this.anchorPosition = position;
      this.rate = rate > 0 ? rate : 1;
      this.slip = 0;
    }
  };
}

// The speed and pause requested by the window for this job. `speed` is the
// absolute speed (1 = the MIDI's own tempo); the schedule was built at
// `baseSpeed`, so the timeline runs at speed / baseSpeed.
function createLiveControl(supportDir, job, schedule) {
  var baseSpeed = schedule && Number(schedule.speed) > 0 ? Number(schedule.speed) : 1;
  var jobId = String((job && job.jobId) || "");
  return {
    baseSpeed: baseSpeed,
    speed: baseSpeed,
    paused: false,
    lastPoll: -1,
    rate: function() {
      return this.speed / this.baseSpeed;
    },
    // Reads the control file, at most every CONTROL_POLL_SECONDS unless
    // forced. Returns true when the speed or the pause state changed. A file
    // left by another job is ignored.
    poll: function(now, force) {
      if (!force && this.lastPoll >= 0 && now - this.lastPoll < CONTROL_POLL_SECONDS) return false;
      this.lastPoll = now;
      var control = readPlaybackControl(supportDir);
      if (!control || String(control.jobId || "") !== jobId) return false;
      var speed = Number(control.speed);
      if (!isFinite(speed) || speed <= 0) speed = this.speed;
      speed = clamp(speed, SPEED_MIN, SPEED_MAX);
      var paused = !!control.paused;
      var changed = Math.abs(speed - this.speed) > 0.0001 || paused !== this.paused;
      this.speed = speed;
      this.paused = paused;
      return changed;
    }
  };
}

// Where the song ends, in schedule seconds: the last note's end.
function scheduleLengthSeconds(schedule) {
  var events = (schedule && schedule.events) || [];
  var end = 0;
  for (var i = 0; i < events.length; i++) {
    var e = Number(events[i].t || 0) + Math.max(0, Number(events[i].dur || 0));
    if (e > end) end = e;
  }
  return end;
}

// A small stateful controller around the raw key sender. It tracks which keys
// are currently held down and whether Shift is down, so that:
//   * key RELEASES can be deferred and done in the gaps between notes,
//   * Shift is toggled only when it actually needs to change,
//   * nothing is ever left stuck down.
// How long to hold a note's key: its real length from the MIDI (at the live
// `rate`, see createPlaybackTimeline), clamped to a sane floor/ceiling, or a
// default when the MIDI had no note-off for it.
function holdSecondsForEvent(ev, rate) {
  var dur = ev && ev.dur != null ? Number(ev.dur) : 0;
  if (!(dur > 0)) return DEFAULT_HOLD_SECONDS;
  if (rate > 0) dur = dur / rate;
  if (dur < MIN_HOLD_SECONDS) return MIN_HOLD_SECONDS;
  if (dur > MAX_HOLD_SECONDS) return MAX_HOLD_SECONDS;
  return dur;
}

function createKeyController(sender, ctrlKeyCode) {
  return {
    sender: sender,
    held: [],          // [{ code, downAt, releaseAt }] oldest first
    shiftDown: false,
    ctrlDown: false,
    SHIFT_KEYCODE: 56,
    // The key held for the extended (dotted) notes of the 88-key piano. Ctrl by
    // default; the schedule carries the user's choice.
    CTRL_KEYCODE: isFiniteNumber(ctrlKeyCode) ? ctrlKeyCode : EXTENDED_MODIFIER_KEYCODES.ctrl,

    ensureShift: function(desired) {
      if (desired === this.shiftDown) return;
      this.sender.postKeyCode(this.SHIFT_KEYCODE, desired, "");
      this.shiftDown = desired;
      if (desired) sleepSeconds(SHIFT_SETTLE_SECONDS);
    },

    ensureCtrl: function(desired) {
      if (desired === this.ctrlDown) return;
      this.sender.postKeyCode(this.CTRL_KEYCODE, desired, "");
      this.ctrlDown = desired;
      if (desired) sleepSeconds(SHIFT_SETTLE_SECONDS);
    },

    // Bring both modifiers to the wanted state, releasing before pressing so
    // there is never a moment with an extra modifier down.
    ensureModifiers: function(shift, ctrl) {
      shift = !!shift;
      ctrl = !!ctrl;
      if (!shift) this.ensureShift(false);
      if (!ctrl) this.ensureCtrl(false);
      if (shift) this.ensureShift(true);
      if (ctrl) this.ensureCtrl(true);
    },

    // How many modifier key events it takes to get from one state to another.
    modifierCost: function(fromShift, fromCtrl, toShift, toCtrl) {
      return ((!!fromShift) !== (!!toShift) ? 1 : 0) + ((!!fromCtrl) !== (!!toCtrl) ? 1 : 0);
    },

    indexOfHeld: function(code) {
      for (var i = 0; i < this.held.length; i++) {
        if (this.held[i].code === code) return i;
      }
      return -1;
    },

    releaseHeldAt: function(idx) {
      var h = this.held[idx];
      this.held.splice(idx, 1);
      this.sender.postKeyCode(h.code, false, "");
    },

    pressDown: function(code, now, holdSeconds) {
      // If this physical key is still held from an earlier note, release it
      // first so Roblox registers a fresh key-down (a real retrigger).
      var existing = this.indexOfHeld(code);
      if (existing >= 0) this.releaseHeldAt(existing);
      this.sender.postKeyCode(code, true, "");
      // releaseAt = when this note musically ends and should let go. hold is kept
      // so an early release can be judged against the note's own length.
      this.held.push({ code: code, downAt: now, releaseAt: now + holdSeconds, hold: holdSeconds });
    },

    playChord: function(specs, now) {
      // Drop exact duplicates (same key + same modifiers) so a malformed MIDI
      // that lists the same note twice at one instant does not double-strike.
      // Keep the LONGEST hold among duplicates so a note is never cut short.
      // Notes are grouped by the modifier state they need: plain, Shift (black
      // keys of the classic piano) or Ctrl (the extended low/high keys).
      var seen = {};
      var groups = {};
      var groupOrder = [];
      var unique = [];
      for (var i = 0; i < specs.length; i++) {
        var s = specs[i];
        var modKey = (s.shift ? "S" : "") + (s.ctrl ? "C" : "");
        var key = s.code + ":" + modKey;
        if (seen[key] != null) {
          var prior = seen[key];
          if ((s.hold || 0) > (prior.hold || 0)) prior.hold = s.hold;
          continue;
        }
        seen[key] = s;
        unique.push(s);
        if (!groups[modKey]) { groups[modKey] = []; groupOrder.push(modKey); }
        groups[modKey].push(s);
      }

      // A big chord cannot be pressed instantly — each key costs one slow event,
      // so it unavoidably comes out as a fast roll. Make that roll run bottom-up
      // like a pianist spreading a chord, rather than jumping about.
      //
      // Every modifier change (Shift or Ctrl up/down) costs another key event.
      // So: play strictly low-to-high when that needs only a couple of modifier
      // changes; otherwise fall back to one run per modifier group (each
      // low-to-high, in order of their lowest note), which keeps the changes to
      // at most two per group.
      var byPitch = function(a, b) { return (a.pitch || 0) - (b.pitch || 0); };
      unique.sort(byPitch);

      var sequence;
      if (groupOrder.length <= 1) {
        sequence = unique;
      } else {
        var cost = 0;
        var stShift = this.shiftDown;
        var stCtrl = this.ctrlDown;
        for (var q = 0; q < unique.length; q++) {
          cost += this.modifierCost(stShift, stCtrl, unique[q].shift, unique[q].ctrl);
          stShift = !!unique[q].shift;
          stCtrl = !!unique[q].ctrl;
        }
        if (cost <= MAX_CHORD_SHIFT_TOGGLES) {
          sequence = unique;
        } else {
          var runs = [];
          for (var g = 0; g < groupOrder.length; g++) {
            var run = groups[groupOrder[g]].slice().sort(byPitch);
            runs.push(run);
          }
          runs.sort(function(a, b) { return (a[0].pitch || 0) - (b[0].pitch || 0); });
          sequence = [];
          for (var r = 0; r < runs.length; r++) sequence = sequence.concat(runs[r]);
        }
      }

      var t0 = nowSeconds();
      for (var k = 0; k < sequence.length; k++) {
        this.ensureModifiers(!!sequence[k].shift, !!sequence[k].ctrl);   // only toggles on a change
        this.pressDown(sequence[k].code, now, sequence[k].hold);
      }
      this.noteKeyCost(t0, sequence.length);
    },

    // Keep a live estimate of how long one key event takes on this Mac, so the
    // release budget below is based on measured reality rather than a guess.
    // Seeded from the sender in use: Quartz is far cheaper than Accessibility.
    keyCost: (sender && sender.mode === "cg") ? QUARTZ_KEY_COST_SECONDS : ASSUMED_KEY_COST_SECONDS,
    noteKeyCost: function(t0, count) {
      if (!(count > 0)) return;
      var per = (nowSeconds() - t0) / count;
      if (!(per > 0) || per > 0.5) return;          // ignore nonsense samples
      this.keyCost = this.keyCost * 0.8 + per * 0.2; // smooth it
    },

    // Release keys whose note has ended. Releases are BUDGETED: we only send as
    // many key-ups as measurably fit before the next onset, and never within
    // RELEASE_SLACK of it. That stops a fat chord's key-ups from arriving in one
    // clump and shoving the next note late (a main cause of tempo wobble).
    // Letting a key up slightly late is inaudible; a late note-on is not.
    flushDue: function(now, deadline, maxKeys, upcomingCodes) {
      if (this.held.length === 0) return;
      var released = 0;
      var kept = [];
      // Smallest useful lead time for clearing a key out of a chord's way. It
      // tracks the measured cost of a key event, so a slow sender gets real
      // runway while a fast one releases almost just-in-time.
      var leadFloor = RELEASE_SLACK_SECONDS + (4 * this.keyCost);
      for (var i = 0; i < this.held.length; i++) {
        var h = this.held[i];
        // Release a key when its note has ended — or, if the very next chord is
        // about to re-strike that key, up to a hair early. The tolerance matters:
        // letting go a few ms before a note that is about to sound again is
        // inaudible and keeps the costly release out of the chord, but releasing
        // a note with plenty left to run would clip it short. Notes still well
        // inside their length are left alone and released during the chord.
        // How early: a share of the note's own length (so a long, ringing note
        // can clear well out of a fat chord's way), but never less than the lead
        // floor above, so short notes still get out of the way in time.
        var tolerance = Math.max(leadFloor, (h.hold || 0) * PRE_RELEASE_FRACTION);
        var due = (now >= h.releaseAt) ||
                  (upcomingCodes && upcomingCodes[h.code] && (h.releaseAt - now) <= tolerance);
        var slack = deadline - nowSeconds();
        if (due && released < maxKeys && slack > RELEASE_SLACK_SECONDS + this.keyCost) {
          this.sender.postKeyCode(h.code, false, "");
          released++;
        } else {
          kept.push(h);
        }
      }
      this.held = kept;
    },

    // Safety valve: if a passage is so busy that a key never gets a quiet moment
    // to come up, let go of the single most overdue one anyway. One key event is
    // a far smaller timing hit than a whole stuck note ringing on.
    forceOverdue: function(now) {
      if (this.held.length === 0) return;
      var worstIdx = -1;
      var worstAge = FORCE_RELEASE_AFTER_SECONDS;
      for (var i = 0; i < this.held.length; i++) {
        var age = now - this.held[i].releaseAt;
        if (age >= worstAge) { worstAge = age; worstIdx = i; }
      }
      if (worstIdx >= 0) this.releaseHeldAt(worstIdx);
    },

    releaseAll: function() {
      for (var i = 0; i < this.held.length; i++) {
        try { this.sender.postKeyCode(this.held[i].code, false, ""); } catch (_) {}
      }
      this.held = [];
      try { this.sender.postKeyCode(this.SHIFT_KEYCODE, false, ""); } catch (_) {}
      this.shiftDown = false;
      try { this.sender.postKeyCode(this.CTRL_KEYCODE, false, ""); } catch (_) {}
      this.ctrlDown = false;
    }
  };
}

// Sleep until targetTime, using the idle time to release matured keys and to
// poll the stop signal. Releases only happen when there is comfortable slack
// before the onset, so they can never make a note-on late. Returns true when
// the speed or the pause state changed meanwhile (`live`, optional): the
// caller then works out a new targetTime and waits again.
function waitForOnset(targetTime, ctrl, supportDir, upcomingCodes, live) {
  var lastStopCheck = 0;
  while (true) {
    var now = nowSeconds();
    var remaining = targetTime - now;
    if (remaining <= 0) {
      return false;
    }

    var dueForPeriodicWork = (now - lastStopCheck > STOP_CHECK_INTERVAL_SECONDS);
    if (dueForPeriodicWork) {
      if (stopRequested(supportDir)) {
        throw canceledError();
      }
      lastStopCheck = now;
      if (live && live.poll(now, false)) {
        return true;
      }
    }

    // Use the gap for key-ups, but only as many as measurably fit before the
    // next onset. In a truly back-to-back passage the budget is zero and we send
    // none, so notes simply ride on a little longer (legato) instead of the next
    // note arriving late.
    if (ctrl) {
      var budget = Math.floor((remaining - RELEASE_SLACK_SECONDS) / Math.max(ctrl.keyCost, 0.001));
      if (budget > 0) {
        ctrl.flushDue(now, targetTime, Math.min(budget, MAX_RELEASES_PER_GAP), upcomingCodes);
      } else if (dueForPeriodicWork) {
        // No room at all. Rate-limited to the periodic tick so this can never
        // turn into a burst of forced releases.
        ctrl.forceOverdue(now);
      }
    }

    if (remaining > 0.25) {
      sleepSeconds(0.05);
    } else if (remaining > 0.05) {
      sleepSeconds(0.02);
    } else if (remaining > 0.01) {
      sleepSeconds(0.005);
    } else if (remaining > 0.003) {
      sleepSeconds(0.001);
    }
  }
}



function validateBackgroundLayout(profileOrSteps) {
  var profile = profileOrSteps && profileOrSteps.steps ? profileOrSteps : { steps: profileOrSteps || [], label: "Legacy Custom" };
  var steps = profile.steps || [];
  var bad = [];
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i] || {};
    if (!isFiniteNumber(step.code)) {
      bad.push(step.label != null ? String(step.label) : ("step " + (i + 1)));
    }
  }
  if (bad.length > 0) {
    throw new Error(
      "The current keyboard profile contains keys that background playback cannot send directly: " +
      bad.join(" ") +
      "\n\nChoose US QWERTY or French AZERTY for the precise built-in mapping, or edit the custom layout so it only contains supported keys."
    );
  }
}



function directInputCapabilities() {
  return {
    ax: !!($.AXUIElementCreateApplication && $.AXUIElementPostKeyboardEvent),
    cg: !!($.CGEventCreateKeyboardEvent && $.CGEventPostToPid)
  };
}

function ensureBackgroundPlaybackReady() {
  ensureAccessibilityTrusted();
  var caps = directInputCapabilities();
  if (!caps.ax && !caps.cg) {
    throw new Error("This macOS build does not expose any direct keyboard event APIs needed for background playback.");
  }
}

function ensureAccessibilityTrusted() {
  try {
    if ($.AXIsProcessTrusted && !Boolean($.AXIsProcessTrusted())) {
      throw new Error(DIRECT_EVENT_PERMISSION_HELP);
    }
  } catch (e) {
    var msg = messageOf(e);
    if (String(msg).indexOf(DIRECT_EVENT_PERMISSION_HELP) >= 0) {
      throw e;
    }
  }
}

function shouldEnableQuartzFallback() {
  try {
    var env = $.NSProcessInfo.processInfo.environment;
    var raw = unwrapMaybe(env.objectForKey($("ROBLOX_MIDI_PLAYER_ALLOW_QUARTZ")));
    if (raw != null) {
      raw = String(raw).toLowerCase();
      return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
    }
  } catch (e) {
    // Ignore.
  }
  return false;
}

function isApplicationRunning(pid) {
  pid = Math.round(Number(pid));
  if (!(pid > 0)) return false;
  try {
    return !!$.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  } catch (e) {
    return isProcessAlive(pid);
  }
}

function createDirectKeySender(pid, supportDir, keySendMethod) {
  var caps = directInputCapabilities();
  var method = normalizeKeySendMethod(keySendMethod);
  // The legacy environment switch still forces Quartz if anyone relies on it.
  if (shouldEnableQuartzFallback()) method = "quartz";

  var axSender = null;
  var cgSender = null;
  var prepErrors = [];
  var preferQuartz = (method === "quartz" || method === "auto");

  appendPlaybackLog(
    supportDir,
    "Preparing a direct key sender for PID " + Math.round(Number(pid)) +
      ". Method: " + keySendMethodLabel(method) + "."
  );

  if (preferQuartz && caps.cg) {
    try {
      cgSender = createCGKeySender(pid);
      appendPlaybackLog(supportDir, "Quartz sender prepared successfully (about 2ms per key).");
    } catch (e2) {
      prepErrors.push("Quartz-targeted input could not be prepared: " + messageOf(e2));
      appendPlaybackLog(supportDir, "Quartz sender preparation failed: " + messageOf(e2));
    }
  }

  // Always prepare Accessibility too when it is available, so there is a live
  // fallback if Quartz ever stops being accepted mid-song.
  if (caps.ax) {
    try {
      axSender = createAXKeySender(pid);
      appendPlaybackLog(supportDir, "Accessibility sender prepared successfully.");
    } catch (e) {
      prepErrors.push("Accessibility-targeted input could not be prepared: " + messageOf(e));
      appendPlaybackLog(supportDir, "AX sender preparation failed: " + messageOf(e));
    }
  }

  if (!axSender && !cgSender) {
    throw new Error(
      prepErrors.length > 0
        ? ("Could not prepare a direct keyboard sender.\n\n" + prepErrors.join("\n"))
        : "Could not prepare a direct keyboard sender."
    );
  }

  var startMode = (preferQuartz && cgSender) ? "cg" : (axSender ? "ax" : "cg");
  appendPlaybackLog(supportDir, "Key sender mode in use: " + (startMode === "cg" ? "Quartz" : "Accessibility") + ".");

  return {
    pid: Math.round(Number(pid)),
    mode: startMode,
    ax: axSender,
    cg: cgSender,
    postKeyCode: function(keyCode, isDown, ch) {
      if (this.mode === "cg" && this.cg) {
        try {
          this.cg.postKeyCode(keyCode, isDown, ch);
          return;
        } catch (eq) {
          if (this.ax) {
            appendPlaybackLog(supportDir, "Quartz send failed; switching to Accessibility. " + messageOf(eq));
            this.mode = "ax";
          } else {
            throw new Error("Quartz-targeted input failed.\n\n" + messageOf(eq));
          }
        }
      }

      if (this.mode === "ax" && this.ax) {
        try {
          this.ax.postKeyCode(keyCode, isDown, ch);
          return;
        } catch (e) {
          if (this.cg) {
            appendPlaybackLog(supportDir, "Accessibility send failed; switching to Quartz. " + messageOf(e));
            this.mode = "cg";
            this.cg.postKeyCode(keyCode, isDown, ch);
            return;
          }
          throw new Error("Accessibility-targeted input failed.\n\n" + messageOf(e));
        }
      }

      if (this.cg) { this.mode = "cg"; this.cg.postKeyCode(keyCode, isDown, ch); return; }
      if (this.ax) { this.mode = "ax"; this.ax.postKeyCode(keyCode, isDown, ch); return; }

      throw new Error("No working direct keyboard sender is available.");
    },
    close: function() {
      try {
        if (this.ax) this.ax.close();
      } catch (_) {}
      try {
        if (this.cg) this.cg.close();
      } catch (_) {}
    }
  };
}

function createAXKeySender(pid) {
  if (!$.AXUIElementCreateApplication || !$.AXUIElementPostKeyboardEvent) {
    throw new Error("AXUIElementPostKeyboardEvent is unavailable.");
  }

  var appRef = $.AXUIElementCreateApplication(Math.round(Number(pid)));
  if (!appRef) {
    throw new Error("Could not create an accessibility target for Roblox.");
  }

  return {
    postKeyCode: function(keyCode, isDown) {
      var err = $.AXUIElementPostKeyboardEvent(appRef, 0, keyCode, isDown);
      if (Number(err) !== 0) {
        throw new Error("AXUIElementPostKeyboardEvent returned " + Number(err) + ".");
      }
    },
    close: function() {
      releaseCFObject(appRef);
    }
  };
}

function createCGKeySender(pid) {
  var source = null;
  try {
    if ($.CGEventSourceCreate && $.kCGEventSourceStateHIDSystemState != null) {
      source = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
    }
  } catch (e) {
    // Fall back to a null event source.
  }

  return {
    postKeyCode: function(keyCode, isDown) {
      var ev = $.CGEventCreateKeyboardEvent(source || null, keyCode, isDown);
      if (!ev) {
        throw new Error("Could not create a Quartz keyboard event.");
      }
      try {
        $.CGEventPostToPid(Math.round(Number(pid)), ev);
      } finally {
        releaseCFObject(ev);
      }
    },
    close: function() {
      releaseCFObject(source);
    }
  };
}

function releaseCFObject(ref) {
  // Deliberately does nothing. Calling $.CFRelease() here used to CRASH the
  // playback worker outright (SIGSEGV), and the try/catch below could not save
  // it because a segfault is not a catchable JavaScript error.
  //
  // Why: AXUIElementCreateApplication / CGEventCreateKeyboardEvent /
  // CGEventSourceCreate all follow the Core Foundation "Create Rule", so they
  // hand back an object that is already owned by the JavaScript bridge (its
  // retain count is 1 and the JS wrapper holds that reference). The bridge
  // releases it by itself once the wrapper is collected. Releasing it here as
  // well drops the count to zero early, so the object is freed while the
  // wrapper still points at it — a double free, and the process dies.
  //
  // This bit the app twice:
  //   * sender.close() released the Accessibility handle at the END of every
  //     song, so the worker crashed just after the last note. That is why the
  //     log stopped at "trace ending" and never reached "Playback finished",
  //     and why the pid file was sometimes left behind.
  //   * the Quartz sender released every single key event, so it died on the
  //     very first note — which is what made Quartz look unusable at first.
  //
  // Verified: create-then-CFRelease segfaults; create-and-post WITHOUT the
  // release runs 25,000 cycles cleanly. Letting the bridge own these objects is
  // both correct and leak-free.
  return;
}

function eventKeySpec(ev) {
  if (ev && ev.keyCode != null) {
    return {
      code: Math.round(Number(ev.keyCode)),
      shift: !!ev.keyShift,
      ctrl: !!ev.keyCtrl,
      label: ev.keyLabel != null ? String(ev.keyLabel) : (ev.k != null ? String(ev.k) : "")
    };
  }
  if (ev && ev.k != null) {
    var fallback = layoutCharSpec(ev.k);
    if (fallback) {
      fallback.ctrl = false;
      fallback.label = String(ev.k);
      return fallback;
    }
  }
  return null;
}

// "1", "!" or "Ctrl+1" — how a key step is shown in logs and previews.
function stepDisplayLabel(step) {
  if (!step) return "?";
  var label = step.label != null ? String(step.label) : "?";
  if (step.ctrl) return (step.modifierName || "Ctrl") + "+" + label;
  return label;
}

function layoutCharSpec(ch) {
  ch = String(ch || "");
  if (!ch) return null;

  if (ch >= "A" && ch <= "Z") {
    ch = ch.toLowerCase();
  }

  var plain = {
    "a": 0,
    "s": 1,
    "d": 2,
    "f": 3,
    "h": 4,
    "g": 5,
    "z": 6,
    "x": 7,
    "c": 8,
    "v": 9,
    "b": 11,
    "q": 12,
    "w": 13,
    "e": 14,
    "r": 15,
    "y": 16,
    "t": 17,
    "1": 18,
    "2": 19,
    "3": 20,
    "4": 21,
    "6": 22,
    "5": 23,
    "=": 24,
    "9": 25,
    "7": 26,
    "-": 27,
    "8": 28,
    "0": 29,
    "]": 30,
    "o": 31,
    "u": 32,
    "[": 33,
    "i": 34,
    "p": 35,
    "l": 37,
    "j": 38,
    "'": 39,
    "k": 40,
    ";": 41,
    "\\": 42,
    ",": 43,
    "/": 44,
    "n": 45,
    "m": 46,
    ".": 47,
    "`": 50
  };
  if (plain.hasOwnProperty(ch)) {
    return { code: plain[ch], shift: false };
  }

  var shifted = {
    "!": 18,
    "@": 19,
    "#": 20,
    "$": 21,
    "^": 22,
    "%": 23,
    "+": 24,
    "(": 25,
    "&": 26,
    "_": 27,
    "*": 28,
    ")": 29,
    "}": 30,
    "{": 33,
    ":": 41,
    "\"": 39,
    "|": 42,
    "<": 43,
    "?": 44,
    ">": 47,
    "~": 50
  };
  if (shifted.hasOwnProperty(ch)) {
    return { code: shifted[ch], shift: true };
  }

  return null;
}


function debugCharText(ch) {
  ch = String(ch || "");
  return "'" + ch.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

function schedulePreviewText(schedule, maxItems) {
  schedule = schedule || {};
  var events = schedule.events || [];
  maxItems = Math.max(1, Number(maxItems) || 8);
  if (events.length === 0) return "(no events)";
  var parts = [];
  var limit = Math.min(events.length, maxItems);
  for (var i = 0; i < limit; i++) {
    var ev = events[i] || {};
    var spec = eventKeySpec(ev);
    var keyLabel = spec && spec.label != null ? spec.label : (ev.k != null ? ev.k : "?");
    parts.push(
      "#" + (i + 1) +
      " t=" + formatNumber(ev.t || 0, 3) + "s" +
      (ev.sourceMIDINote != null ? (" note=" + noteName(ev.sourceMIDINote)) : "") +
      (ev.playedMIDINote != null ? (" out=" + noteName(ev.playedMIDINote)) : "") +
      " key=" + formatPreviewKeyLabel(keyLabel) +
      (spec ? (" code=" + spec.code + (spec.shift ? "+shift" : "") + (spec.ctrl ? "+ctrl" : "")) : "")
    );
  }
  if (events.length > limit) {
    parts.push("... " + (events.length - limit) + " more events");
  }
  return parts.join(" | ");
}



function shortText(s, maxLen) {
  s = String(s || "");
  maxLen = Math.max(8, Number(maxLen) || 120);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}


function ensureSupportDir() {
  var home = ObjC.unwrap($.NSHomeDirectory());
  var path = home + "/Library/Application Support/" + SUPPORT_DIR_NAME;
  // Tests (and anyone who wants a separate setup) can point the app at another
  // folder; a worker always uses the folder written in its job.
  try {
    var override = unwrapMaybe($.NSProcessInfo.processInfo.environment.objectForKey($("ROBLOX_MIDI_PLAYER_SUPPORT_DIR")));
    if (override) path = String(override);
  } catch (_) {}
  try {
    app.doShellScript('/bin/mkdir -p ' + shellQuote(path));
  } catch (e) {
    throw new Error("Could not create the Application Support folder.\n\n" + messageOf(e));
  }
  return path;
}

function menuAction(cfg, playback) {
  playback = playback || { active: false, statusText: "" };

  var profile = resolveKeyboardProfile(cfg);
  var mappedCount = profile.steps.length;
  var promptLines = [
    "Saved piano base (first white key): " + noteLabel(cfg.baseMIDINote),
    "Keyboard profile: " + keyboardProfileLabel(profile),
    "Precision mode: " + noteRecognitionModeLabel(cfg.noteRecognitionMode),
    "Key sending: " + keySendMethodLabel(cfg.keySendMethod),
    "Piano: " + keyboardModeLabel(cfg.keyboardMode) + " (" + mappedCount + " keys)",
    "After-click delay: " + formatNumber(cfg.startDelaySeconds, 2) + " seconds",
    "Speed: " + formatNumber(cfg.speed, 2) + "x"
  ];

  if (playback.statusText) {
    promptLines.push("");
    promptLines.push(playback.statusText);
  }

  promptLines.push("");
  promptLines.push("Each MIDI is analyzed automatically before playback.");
  promptLines.push(cfg.noteRecognitionMode === "perfect"
    ? "Perfect Mapping uses the chosen keyboard profile and the standard Roblox/MAX 61-key layout. A note is only considered precise when it lands on the same musical note name with zero hidden transposition."
    : "Smart Best Fit tries to fit more of the song by shifting the run base, which can sound transposed but usually increases coverage.");
  promptLines.push(playback.active ? "You can open settings while the song is armed or playing." : "Choose what to do next.");
  promptLines.push("If songs play on the right keys but sound too high or too low, adjust the Saved piano base for the first white key in Settings.");

  var prompt = promptLines.join("\n");

  while (true) {
    var buttons = playback.active ? ["Quit", "More", "Stop Playback"] : ["Quit", "More", "Play MIDI"];
    var defaultButton = playback.active ? "More" : "Play MIDI";
    var action = showDialog(APP_NAME, prompt, buttons, defaultButton, "Quit", "note");
    if (!action || action === "Quit") {
      return "Quit";
    }
    if (action === "Play MIDI") {
      return "Play MIDI";
    }
    if (action === "Stop Playback") {
      return "Stop Playback";
    }
    if (action === "More") {
      var more = showDialog(APP_NAME, "More options", ["Back", "About", "Tools"], "Tools", "Back", "note");
      if (!more || more === "Back") {
        continue;
      }
      if (more === "About") {
        return "About";
      }
      var toolButtons = playback.active ? ["Back", "Open Config Folder", "Edit Settings", "Stop Playback"] : ["Back", "Open Config Folder", "Edit Settings"];
      var toolsDefault = playback.active ? "Stop Playback" : "Edit Settings";
      var tools = showDialog(APP_NAME, "Tools", toolButtons, toolsDefault, "Back", "note");
      if (!tools || tools === "Back") {
        continue;
      }
      return tools;
    }
  }
}



function editSettings(current) {
  current = sanitizeConfig(current);

  var baseAns = promptForText(
    "Saved piano base",
    [
      "Enter the MIDI note for the first white key in your Roblox piano layout.",
      "",
      "Example: on the standard MAX map the first white key is usually C2, so enter 36 or C2.",
      "Perfect Mapping treats this saved piano base as the exact instrument anchor.",
      "If every song sounds consistently too high or too low, this is the value to change."
    ].join("\n"),
    String(current.baseMIDINote)
  );
  var baseNote = parseMIDINoteInput(trim(baseAns));
  if (baseNote == null) {
    throw new Error("The saved piano base must be a MIDI number like 36 or a note name like C2.");
  }

  var profileChoice = chooseKeyboardProfile(current.keyboardProfile, current.keyLayout);

  var delayAns = promptForText(
    "After-click delay",
    "Enter the delay in seconds after Roblox becomes active. Example: 0.5 starts almost immediately after you click the piano window.",
    trimFloat(current.startDelaySeconds)
  );
  var startDelay = parseFloat(trim(delayAns));
  if (!isFinite(startDelay)) {
    throw new Error("The after-click delay must be a number.");
  }

  var speedAns = promptForText(
    "Playback speed",
    "Enter the playback speed multiplier, from 0.25 to 2. Example: 1 for normal, 0.5 for half-speed, 1.25 for slightly faster.",
    trimFloat(current.speed)
  );
  var speed = parseFloat(trim(speedAns));
  if (!isFinite(speed)) {
    throw new Error("The playback speed must be a number.");
  }

  var noteRecognitionMode = chooseNoteRecognitionMode(current.noteRecognitionMode);
  var keySendMethod = chooseKeySendMethod(current.keySendMethod);

  var keyboardMode = chooseKeyboardMode(current.keyboardMode);

  return sanitizeConfig({
    baseMIDINote: baseNote,
    keyboardProfile: profileChoice.keyboardProfile,
    keyLayout: profileChoice.keyLayout,
    startDelaySeconds: startDelay,
    speed: speed,
    noteRecognitionMode: noteRecognitionMode,
    keySendMethod: keySendMethod,
    keyboardMode: keyboardMode,
    extendedModifier: current.extendedModifier,
    uiLanguage: current.uiLanguage,
    openLiveLogWindow: current.openLiveLogWindow
  });
}

function chooseKeyboardMode(currentMode) {
  currentMode = normalizeKeyboardMode(currentMode);
  var answer = showDialog(
    APP_NAME,
    [
      "Which Roblox piano do you play on?",
      "",
      "Classic 61 keys: C2 to C7. White keys 1 to m, black keys with Shift.",
      "",
      "Extended 88 keys: A0 to C8. Adds the 15 lowest notes (Ctrl + 1 to t) and the 12 highest (Ctrl + y to j), the dotted keys in the game.",
      "",
      "Current: " + keyboardModeLabel(currentMode)
    ].join("\n"),
    ["Cancel", "Extended 88 keys", "Classic 61 keys"],
    currentMode === "extended" ? "Extended 88 keys" : "Classic 61 keys",
    "Cancel",
    "note"
  );
  if (answer === "Cancel") throw canceledError();
  return answer === "Extended 88 keys" ? "extended" : "classic";
}



function chooseKeySendMethod(currentMethod) {
  currentMethod = normalizeKeySendMethod(currentMethod);
  var answer = showDialog(
    APP_NAME,
    [
      "Choose how key presses are delivered to Roblox.",
      "",
      "Quartz is the fast path. Measured at about 2 ms per key, and confirmed to reach the Roblox piano both when Roblox is in front and when it is in the background. A ten-note chord takes roughly 20 ms instead of 130 ms, so chords land together and dense songs keep tempo.",
      "",
      "Accessibility is the older, more cautious path at about 12-17 ms per key, because it waits for Roblox to handle every single event. Choose it if Quartz ever stops working after a Roblox update.",
      "",
      "Automatic uses Quartz and falls back to Accessibility if Quartz cannot be prepared. This is the recommended setting.",
      "",
      "Current: " + keySendMethodLabel(currentMethod)
    ].join("\n"),
    ["Accessibility", "Quartz", "Automatic"],
    currentMethod === "accessibility" ? "Accessibility" : (currentMethod === "quartz" ? "Quartz" : "Automatic"),
    null,
    "note"
  );
  if (answer === "Quartz") return "quartz";
  if (answer === "Accessibility") return "accessibility";
  return "auto";
}

function chooseNoteRecognitionMode(currentMode) {
  currentMode = normalizeNoteRecognitionMode(currentMode);
  var answer = showDialog(
    APP_NAME,
    [
      "Choose how strict the note mapping should be.",
      "",
      "Perfect Mapping is the strict mode. It treats the standard Roblox/MAX map literally: white keys run from 1 to m, black keys are the matching Shifted keys, the saved piano base is used directly, and notes outside range are skipped instead of being transposed.",
      "",
      "Smart Best Fit can still shift the run base to fit more of the song into range. It usually plays more notes, but it can sound transposed on the 61-key instrument.",
      "",
      "You can still manually override the run base on any single song after loading the MIDI."
    ].join("\n"),
    ["Cancel", "Smart Best Fit", "Perfect Mapping"],
    currentMode === "smart" ? "Smart Best Fit" : "Perfect Mapping",
    "Cancel",
    "note"
  );
  if (answer === "Cancel") throw canceledError();
  return answer === "Smart Best Fit" ? "smart" : "perfect";
}



function promptForBaseNoteOverride(currentBase, analysis, layoutLength) {
  var ans = promptForText(
    "Base note for this run",
    [
      "Enter the base note to use for this MIDI.",
      "",
      "You can type a MIDI note number like 36 or a note name like C2.",
      "Song span: " + noteName(analysis.minNote) + " to " + noteName(analysis.maxNote),
      "Saved piano base (first white key): " + noteLabel(analysis.savedBase),
      "Auto-selected run base: " + noteLabel(analysis.detectedBase) + " (" + describeAutoDetectionMode(analysis) + ")",
      "Piano size: " + layoutLength + " keys",
      analysis.noteRecognitionMode === "perfect"
        ? "Perfect Mapping keeps exact semitone identity relative to the saved first-white-key base on the standard Roblox/MAX map. Manual override can still transpose this one run if you want, but it is no longer perfect."
        : "Smart Best Fit prefers coverage and may transpose the song so more notes fit in range. Manual override can use any semitone.",
      "If every song sounds consistently too high or too low, change Saved piano base in Settings instead of overriding each run."
    ].join("\n"),
    String(currentBase)
  );

  var parsed = parseMIDINoteInput(trim(ans));
  if (parsed == null) {
    throw new Error("The base note must be a MIDI number like 36 or a note name like C2.");
  }
  return parsed;
}



// `buttons` is [cancel, save] in the window's language (English by default).
function promptForText(title, message, defaultAnswer, buttons) {
  var cancel = buttons && buttons[0] ? String(buttons[0]) : "Cancel";
  var save = buttons && buttons[1] ? String(buttons[1]) : "Save";
  try {
    var ans = app.displayDialog(message, {
      withTitle: title,
      defaultAnswer: defaultAnswer,
      buttons: [cancel, save],
      defaultButton: save,
      cancelButton: cancel,
      withIcon: "note"
    });
    return String(ans.textReturned);
  } catch (e) {
    if (isCanceledError(e)) throw canceledError();
    throw e;
  }
}

function chooseMIDIFile() {
  try {
    var picked = app.chooseFile({
      withPrompt: "Choose a MIDI file",
      ofType: ["mid", "midi"]
    });
    return String(picked);
  } catch (e) {
    if (isCanceledError(e)) throw canceledError();
    throw e;
  }
}

function showDialog(title, message, buttons, defaultButton, cancelButton, iconName) {
  buttons = buttons || ["OK"];
  if (!Array.isArray(buttons) || buttons.length === 0) buttons = ["OK"];
  defaultButton = defaultButton || buttons[buttons.length - 1];
  try {
    var opts = {
      withTitle: title,
      buttons: buttons,
      defaultButton: defaultButton
    };
    if (cancelButton) opts.cancelButton = cancelButton;
    if (iconName) opts.withIcon = iconName;
    var ans = app.displayDialog(message, opts);
    if (!ans || ans.buttonReturned == null) return defaultButton;
    return String(ans.buttonReturned);
  } catch (e) {
    if (isCanceledError(e)) return cancelButton || null;
    throw e;
  }
}

function showNotificationSafe(message, title, subtitle) {
  try {
    var opts = {
      withTitle: title || APP_NAME
    };
    if (subtitle) opts.subtitle = subtitle;
    app.displayNotification(String(message), opts);
  } catch (e) {
    // Notifications are optional.
  }
}

function loadConfig(path) {
  if (!$.NSFileManager.defaultManager.fileExistsAtPath($(path))) {
    saveConfig(path, defaultConfig);
    return clone(defaultConfig);
  }
  var text = readTextFile(path);
  var cfg = JSON.parse(text);
  return sanitizeConfig(cfg);
}

function saveConfig(path, cfg) {
  cfg = sanitizeConfig(cfg);
  var text = JSON.stringify(cfg, null, 2);
  var ok = $(text).writeToFileAtomicallyEncodingError($(path), true, $.NSUTF8StringEncoding, null);
  if (!ok) {
    throw new Error("Could not save the configuration file.");
  }
}

function readTextFile(path) {
  var data = $.NSString.stringWithContentsOfFileEncodingError($(path), $.NSUTF8StringEncoding, null);
  if (!data) {
    throw new Error("Could not read file: " + path);
  }
  return ObjC.unwrap(data);
}

function readBinaryString(path) {
  var data = $.NSData.dataWithContentsOfFile($(path));
  if (!data) {
    throw new Error("Could not read file: " + path);
  }
  var str = $.NSString.alloc.initWithDataEncoding(data, $.NSISOLatin1StringEncoding);
  if (!str) {
    throw new Error("Could not decode file bytes: " + path);
  }
  return ObjC.unwrap(str);
}

function sanitizeConfig(cfg) {
  var out = clone(defaultConfig);
  if (cfg && typeof cfg === 'object') {
    try {
      if (cfg.baseMIDINote != null) out.baseMIDINote = clampBaseNote(cfg.baseMIDINote);
      if (cfg.keyboardProfile != null) out.keyboardProfile = normalizeKeyboardProfile(cfg.keyboardProfile);
      if (cfg.keyLayout != null) out.keyLayout = String(cfg.keyLayout);
      if (cfg.startDelaySeconds != null) out.startDelaySeconds = Number(cfg.startDelaySeconds);
      if (cfg.speed != null) out.speed = Number(cfg.speed);
      if (cfg.noteRecognitionMode != null) out.noteRecognitionMode = normalizeNoteRecognitionMode(cfg.noteRecognitionMode);
      if (cfg.mappingModel != null) out.mappingModel = String(cfg.mappingModel);
      if (cfg.keySendMethod != null) out.keySendMethod = normalizeKeySendMethod(cfg.keySendMethod);
      if (cfg.keyboardMode != null) out.keyboardMode = normalizeKeyboardMode(cfg.keyboardMode);
      if (cfg.extendedModifier != null) out.extendedModifier = normalizeExtendedModifier(cfg.extendedModifier);
      if (cfg.uiLanguage != null) out.uiLanguage = normalizeUILanguage(cfg.uiLanguage);
      if (cfg.openLiveLogWindow != null) out.openLiveLogWindow = !!cfg.openLiveLogWindow;
      if (cfg.liveKeys != null) out.liveKeys = !!cfg.liveKeys;
      if (cfg.windowTopLeft && isFinite(Number(cfg.windowTopLeft.x)) && isFinite(Number(cfg.windowTopLeft.y))) {
        out.windowTopLeft = { x: Math.round(Number(cfg.windowTopLeft.x)), y: Math.round(Number(cfg.windowTopLeft.y)) };
      }
    } catch (_) {
      // Fall back to defaults where needed.
    }
  }

  out.baseMIDINote = clampBaseNote(out.baseMIDINote);
  out.keyLayout = normalizeLayout(out.keyLayout).join('');
  if (!out.keyLayout) out.keyLayout = defaultConfig.keyLayout;
  if (cfg == null || cfg.keyboardProfile == null) {
    out.keyboardProfile = inferKeyboardProfileFromLayout(out.keyLayout);
  }
  out.keyboardProfile = normalizeKeyboardProfile(out.keyboardProfile);
  if ((cfg == null || cfg.mappingModel == null) && out.keyboardProfile === "custom") {
    var inferredProfile = inferKeyboardProfileFromLayout(out.keyLayout);
    if (inferredProfile !== "custom") out.keyboardProfile = inferredProfile;
  }
  if (out.startDelaySeconds < 0) out.startDelaySeconds = 0;
  if (out.startDelaySeconds > 30) out.startDelaySeconds = 30;
  if (!(out.speed > 0)) out.speed = 1;
  if (out.speed < SPEED_MIN) out.speed = SPEED_MIN;
  if (out.speed > SPEED_MAX) out.speed = SPEED_MAX;
  out.noteRecognitionMode = normalizeNoteRecognitionMode(out.noteRecognitionMode);
  out.keySendMethod = normalizeKeySendMethod(out.keySendMethod);
  out.keyboardMode = normalizeKeyboardMode(out.keyboardMode);
  out.extendedModifier = normalizeExtendedModifier(out.extendedModifier);
  out.uiLanguage = normalizeUILanguage(out.uiLanguage);
  out.openLiveLogWindow = !!out.openLiveLogWindow;
  out.liveKeys = !!out.liveKeys;
  // Legacy custom layouts have no 88-key extension.
  if (out.keyboardProfile === "custom") out.keyboardMode = "classic";
  if (!out.mappingModel) out.mappingModel = "max61";
  if ((cfg == null || cfg.mappingModel == null) && out.keyboardProfile !== "custom" && out.baseMIDINote === 48) {
    out.baseMIDINote = 36;
  }
  return out;
}



function normalizeNoteRecognitionMode(value) {
  var text = trim(value == null ? "" : String(value)).toLowerCase();
  if (text === "smart" || text === "bestfit" || text === "best-fit" || text === "coverage" || text === "approx" || text === "approximate") {
    return "smart";
  }
  if (text === "exact" || text === "perfect" || text === "precise" || text === "strict") {
    return "perfect";
  }
  return "perfect";
}



function normalizeKeySendMethod(value) {
  var text = trim(value == null ? "" : String(value)).toLowerCase();
  if (text === "quartz" || text === "cg" || text === "cgevent" || text === "fast") return "quartz";
  if (text === "accessibility" || text === "ax" || text === "axui" || text === "compatible") return "accessibility";
  return "auto";
}

function normalizeKeyboardMode(value) {
  var text = trim(value == null ? "" : String(value)).toLowerCase();
  if (text === "extended" || text === "88" || text === "max88" || text === "full" || text === "mode2" || text === "2") {
    return "extended";
  }
  return "classic";
}

function keyboardModeLabel(mode) {
  return normalizeKeyboardMode(mode) === "extended" ? "Extended 88 keys (A0-C8, dotted keys with Ctrl)" : "Classic 61 keys (C2-C7)";
}

function normalizeExtendedModifier(value) {
  var text = trim(value == null ? "" : String(value)).toLowerCase();
  if (text === "alt" || text === "option" || text === "opt") return "alt";
  return "ctrl";
}

function extendedModifierKeyCode(value) {
  return EXTENDED_MODIFIER_KEYCODES[normalizeExtendedModifier(value)];
}

function normalizeUILanguage(value) {
  var text = trim(value == null ? "" : String(value)).toLowerCase();
  if (text === "fr" || text.indexOf("fr-") === 0 || text === "french" || text === "français" || text === "francais") return "fr";
  if (text === "en" || text.indexOf("en-") === 0 || text === "english") return "en";
  return "auto";
}

function keyboardRangeWord(profile) {
  return (profile && profile.anchorIndex > 0) ? "88-key" : "61-key";
}

function keyMapDescription(profile) {
  if (!profile || !profile.builtIn) return "Legacy custom layout (" + ((profile && profile.steps) ? profile.steps.length : 0) + " keys)";
  if (profile.anchorIndex > 0) {
    return "Extended 88-key Roblox map (61 standard keys + 15 low and 12 high dotted keys with " + (profile.modifierName || "Ctrl") + ")";
  }
  return "Standard 61-key Roblox map (36 white, 25 black on Shift)";
}

function keySendMethodLabel(mode) {
  var m = normalizeKeySendMethod(mode);
  if (m === "quartz") return "Quartz (fast)";
  if (m === "accessibility") return "Accessibility (compatible)";
  return "Automatic (Quartz, falling back to Accessibility)";
}

function noteRecognitionModeLabel(mode) {
  return normalizeNoteRecognitionMode(mode) === "smart" ? "Smart Best Fit" : "Perfect Mapping";
}



// `profileOrLength` is the keyboard profile (preferred) or a plain key count.
// The saved base is always the note of key "1"; on the extended piano that key
// sits 15 steps into the layout, so the maths below works in "first key of the
// layout" space and converts back at the end.
function analyzeNotes(notes, profileOrLength, preferredBase, recognitionMode) {
  var isProfile = !!(profileOrLength && profileOrLength.steps);
  var layoutLength = isProfile ? profileOrLength.steps.length : Math.max(1, Math.round(Number(profileOrLength) || 1));
  var anchor = isProfile ? (profileOrLength.anchorIndex || 0) : 0;
  var counts = [];
  for (var i = 0; i < 128; i++) counts[i] = 0;

  var total = 0;
  var unique = 0;
  var minNote = 127;
  var maxNote = 0;
  var sum = 0;
  recognitionMode = normalizeNoteRecognitionMode(recognitionMode);

  for (var ni = 0; ni < notes.length; ni++) {
    var note = notes[ni].note;
    if (note < 0 || note > 127) continue;
    if (counts[note] === 0) unique++;
    counts[note] += 1;
    total += 1;
    sum += note;
    if (note < minNote) minNote = note;
    if (note > maxNote) maxNote = note;
  }

  if (total === 0) {
    minNote = 0;
    maxNote = 0;
  }

  var mean = total > 0 ? (sum / total) : 0;
  var savedBase = clampBaseNote(preferredBase);
  var detected = detectBaseNote(counts, total, unique, mean, layoutLength, savedBase - anchor, recognitionMode);

  return {
    counts: counts,
    totalNotes: total,
    uniqueNotes: unique,
    minNote: minNote,
    maxNote: maxNote,
    meanNote: mean,
    savedBase: savedBase,
    anchorIndex: anchor,
    layoutLength: layoutLength,
    instrumentLow: savedBase - anchor,
    instrumentHigh: savedBase - anchor + layoutLength - 1,
    detectedBase: detected.base + anchor,
    detectedMapped: detected.mapped,
    detectedPenalty: detected.penalty,
    detectedMode: detected.mode,
    detectedShift: detected.shift,
    noteRecognitionMode: recognitionMode
  };
}



function detectBaseNote(counts, totalNotes, uniqueNotes, meanNote, layoutLength, preferredBase, recognitionMode) {
  var effectiveLength = Math.max(1, Math.min(128, layoutLength));
  var maxBase = 127 - effectiveLength + 1;
  var preferredRaw = clamp(Math.round(preferredBase || 0), 0, 127);
  recognitionMode = normalizeNoteRecognitionMode(recognitionMode);
  if (recognitionMode === "perfect") {
    var perfectCandidate = evaluateBaseCandidate(counts, preferredRaw, effectiveLength, preferredRaw, preferredRaw);
    perfectCandidate.mode = "perfect";
    perfectCandidate.shift = 0;
    perfectCandidate.stickyKeptSavedBase = true;
    return perfectCandidate;
  }
  var preferred = preferredRaw > maxBase ? maxBase : preferredRaw;
  var preferredPitchClass = ((preferredRaw % 12) + 12) % 12;
  var targetBase = clamp(Math.round(meanNote - (effectiveLength - 1) / 2), 0, maxBase);

  var preferredCandidate = evaluateBaseCandidate(counts, preferred, effectiveLength, targetBase, preferred);
  if (preferredCandidate && preferredCandidate.mapped === (totalNotes || 0)) {
    preferredCandidate.mode = "octave-safe";
    preferredCandidate.shift = preferredCandidate.base - preferredRaw;
    preferredCandidate.stickyKeptSavedBase = true;
    return preferredCandidate;
  }

  var octaveCandidates = [];
  for (var base = preferredPitchClass; base <= maxBase; base += 12) {
    octaveCandidates.push(base);
  }

  var bestOctaveSafe = chooseBestBaseCandidate(counts, octaveCandidates, effectiveLength, targetBase, preferred);
  if (bestOctaveSafe) {
    if (
      preferredCandidate &&
      bestOctaveSafe.base !== preferredCandidate.base &&
      shouldKeepPreferredBase(preferredCandidate, bestOctaveSafe, totalNotes, uniqueNotes)
    ) {
      preferredCandidate.mode = "octave-safe";
      preferredCandidate.shift = preferredCandidate.base - preferredRaw;
      preferredCandidate.stickyKeptSavedBase = true;
      return preferredCandidate;
    }
    bestOctaveSafe.mode = "octave-safe";
    bestOctaveSafe.shift = bestOctaveSafe.base - preferredRaw;
    bestOctaveSafe.stickyKeptSavedBase = (bestOctaveSafe.base === preferredCandidate.base);
    return bestOctaveSafe;
  }

  var allCandidates = [];
  for (var b = 0; b <= maxBase; b++) {
    allCandidates.push(b);
  }
  var bestAny = chooseBestBaseCandidate(counts, allCandidates, effectiveLength, targetBase, preferred);
  if (!bestAny) {
    return { base: clampBaseNote(preferredBase), mapped: totalNotes || 0, penalty: 0, mode: "chromatic", shift: 0, stickyKeptSavedBase: true };
  }
  bestAny.mode = "chromatic";
  bestAny.shift = bestAny.base - preferredRaw;
  bestAny.stickyKeptSavedBase = (bestAny.base === preferred);
  return bestAny;
}



function shouldKeepPreferredBase(preferredCandidate, bestCandidate, totalNotes, uniqueNotes) {
  if (!preferredCandidate || !bestCandidate) return false;
  if (preferredCandidate.base === bestCandidate.base) return true;

  var totalEvents = Math.max(0, totalNotes || 0);
  var totalUnique = Math.max(0, uniqueNotes || 0);
  var preferredCoverage = totalEvents > 0 ? (preferredCandidate.mapped / totalEvents) : 1;
  var preferredUniqueCoverage = totalUnique > 0 ? (preferredCandidate.mappedUnique / totalUnique) : 1;
  var eventImprovement = bestCandidate.mapped - preferredCandidate.mapped;
  var uniqueImprovement = bestCandidate.mappedUnique - preferredCandidate.mappedUnique;
  var smallEventGain = Math.max(4, Math.ceil(totalEvents * 0.01));

  return (
    preferredCoverage >= 0.99 &&
    preferredUniqueCoverage >= 0.96 &&
    eventImprovement <= smallEventGain &&
    uniqueImprovement <= 1
  );
}

function evaluateBaseCandidate(counts, base, effectiveLength, targetBase, preferredBase) {
  var upper = base + effectiveLength - 1;
  var mapped = 0;
  var mappedUnique = 0;
  var penalty = 0;

  for (var note = 0; note < 128; note++) {
    var count = counts[note] || 0;
    if (!count) continue;
    if (note < base) {
      penalty += (base - note) * count;
    } else if (note > upper) {
      penalty += (note - upper) * count;
    } else {
      mapped += count;
      mappedUnique += 1;
    }
  }

  return {
    base: base,
    mapped: mapped,
    mappedUnique: mappedUnique,
    penalty: penalty,
    centerDelta: Math.abs(base - targetBase),
    preferredDelta: Math.abs(base - preferredBase),
    octaveDelta: Math.abs(base - preferredBase) / 12.0
  };
}

function chooseBestBaseCandidate(counts, candidateBases, effectiveLength, targetBase, preferredBase) {
  var best = null;
  for (var i = 0; i < candidateBases.length; i++) {
    var candidate = evaluateBaseCandidate(counts, candidateBases[i], effectiveLength, targetBase, preferredBase);

    if (
      best == null ||
      candidate.mappedUnique > best.mappedUnique ||
      (candidate.mappedUnique === best.mappedUnique && candidate.mapped > best.mapped) ||
      (candidate.mappedUnique === best.mappedUnique && candidate.mapped === best.mapped && candidate.penalty < best.penalty) ||
      (candidate.mappedUnique === best.mappedUnique && candidate.mapped === best.mapped && candidate.penalty === best.penalty && candidate.preferredDelta < best.preferredDelta) ||
      (candidate.mappedUnique === best.mappedUnique && candidate.mapped === best.mapped && candidate.penalty === best.penalty && candidate.preferredDelta === best.preferredDelta && candidate.centerDelta < best.centerDelta) ||
      (candidate.mappedUnique === best.mappedUnique && candidate.mapped === best.mapped && candidate.penalty === best.penalty && candidate.preferredDelta === best.preferredDelta && candidate.centerDelta === best.centerDelta && candidate.base < best.base)
    ) {
      best = candidate;
    }
  }
  return best;
}

function buildSchedule(notes, tempos, division, cfg, profile) {
  if (tempos.length === 0 || tempos[0].tick !== 0) {
    tempos = [{ tick: 0, microPerQN: 500000 }].concat(tempos);
  }
  tempos = mergeTempoChanges(tempos);
  annotateTempoSeconds(tempos, division);

  profile = resolveKeyboardProfile(cfg, profile);
  var steps = profile.steps || [];
  var anchor = profile.anchorIndex || 0;
  var speed = cfg.speed > 0 ? cfg.speed : 1;
  var savedBase = cfg.savedBaseMIDINote == null ? cfg.baseMIDINote : cfg.savedBaseMIDINote;
  // The bases are the note of key "1"; the first key of the layout sits
  // `anchor` semitones below it on the extended piano.
  var runBase0 = cfg.baseMIDINote - anchor;
  var savedBase0 = savedBase - anchor;
  var modifierKeyCode = extendedModifierKeyCode(cfg.extendedModifier);
  var schedule = {
    startDelay: cfg.startDelaySeconds,
    speed: speed,
    baseMIDINote: cfg.baseMIDINote,
    savedBaseMIDINote: savedBase,
    noteRecognitionMode: normalizeNoteRecognitionMode(cfg.noteRecognitionMode),
    keySendMethod: normalizeKeySendMethod(cfg.keySendMethod),
    keyboardProfile: profile.id,
    keyboardProfileLabel: keyboardProfileLabel(profile),
    keyboardMode: profile.mode || "classic",
    modifierKeyCode: modifierKeyCode,
    instrumentLow: savedBase0,
    instrumentHigh: savedBase0 + steps.length - 1,
    events: []
  };
  var mapped = 0;
  var skippedLow = 0;
  var skippedHigh = 0;
  var maxT = 0;

  for (var i = 0; i < notes.length; i++) {
    var n = notes[i];
    var idx = n.note - runBase0;
    if (idx < 0) {
      skippedLow++;
      continue;
    }
    if (idx >= steps.length) {
      skippedHigh++;
      continue;
    }
    var step = steps[idx];
    if (!step || !isFiniteNumber(step.code)) {
      skippedHigh++;
      continue;
    }
    var seconds = tickToSeconds(n.tick, tempos, division) / speed;
    if (seconds < 0) seconds = 0;
    // How long the note is actually held, in seconds (respecting tempo changes
    // across the note and the speed multiplier). 0 means the MIDI gave us no
    // note-off, so the engine will fall back to a default hold.
    var durSeconds = 0;
    if (n.durTicks > 0) {
      durSeconds = (tickToSeconds(n.tick + n.durTicks, tempos, division) - tickToSeconds(n.tick, tempos, division)) / speed;
      if (!(durSeconds > 0)) durSeconds = 0;
    }
    schedule.events.push({
      t: seconds,
      dur: durSeconds,
      k: step.label,
      keyCode: step.code,
      keyShift: !!step.shift,
      keyCtrl: !!step.ctrl,
      keyLabel: stepDisplayLabel(step),
      sourceMIDINote: n.note,
      playedMIDINote: savedBase0 + idx,
      stepIndex: idx
    });
    mapped++;
    if (seconds > maxT) maxT = seconds;
  }

  return {
    schedule: schedule,
    mapped: mapped,
    skipped: skippedLow + skippedHigh,
    skippedLow: skippedLow,
    skippedHigh: skippedHigh,
    duration: maxT
  };
}



function buildNoteMappingPreview(notes, profile, savedBase, runBase, limit) {
  if (!notes || !notes.length || !profile || !profile.steps || !profile.steps.length) return "";
  var steps = profile.steps;
  var anchor = profile.anchorIndex || 0;
  savedBase = clampBaseNote(savedBase);
  runBase = Math.round(Number(runBase) || 0);
  limit = Math.max(1, Math.min(10, Math.round(Number(limit) || 6)));

  var items = [];
  var seen = {};
  for (var i = 0; i < notes.length && items.length < limit; i++) {
    var midiNote = Math.round(Number(notes[i].note));
    if (!isFinite(midiNote)) continue;
    var idx = midiNote - (runBase - anchor);
    if (idx < 0 || idx >= steps.length) continue;
    var step = steps[idx];
    if (!step) continue;
    var playedNote = (savedBase - anchor) + idx;
    var keyLabel = formatPreviewKeyLabel(stepDisplayLabel(step));
    var text = noteName(midiNote) + " → " + keyLabel + " → " + noteName(playedNote);
    if (seen[text]) continue;
    seen[text] = true;
    items.push(text);
  }

  return items.join(" | ");
}



function formatPreviewKeyLabel(ch) {
  if (ch == null) return "[?]";
  ch = String(ch);
  if (ch === " ") return "[Space]";
  if (ch === "	") return "[Tab]";
  return "[" + ch + "]";
}


function maxWhiteSemitoneOffsetForIndex(index) {
  var degree = index % 7;
  var octave = Math.floor(index / 7);
  var scale = [0, 2, 4, 5, 7, 9, 11];
  return octave * 12 + scale[degree];
}

function maxWhiteHasBlackAfter(index) {
  var degree = index % 7;
  if (index >= MAX_WHITE_KEYCODES.length - 1) return false;
  return degree !== 2 && degree !== 6;
}

function maxShiftLabelForWhite(whiteLabel, index, topRowShiftLabels) {
  if (index < 10 && topRowShiftLabels && index < topRowShiftLabels.length) {
    return String(topRowShiftLabels[index]);
  }
  return String(whiteLabel).toUpperCase();
}

// Builds the key map of a built-in piano. `steps` lists every playable note in
// semitone order; `anchorIndex` is the index of key "1" (the note the saved
// base refers to): 0 on the classic piano, 15 on the extended one where the
// Ctrl low keys come first. Every step knows its key code, which modifiers it
// needs (Shift for classic black keys, Ctrl for the extended keys), its label
// and which zone it belongs to ("low", "main" or "high").
function makeMaxKeyboardProfile(id, label, whiteLabels, topRowShiftLabels, mode, lowLabels, highLabels, modifier) {
  mode = normalizeKeyboardMode(mode);
  var extended = (mode === "extended");
  var modifierName = normalizeExtendedModifier(modifier) === "alt" ? "Option" : "Ctrl";
  var steps = [];

  if (extended) {
    for (var li = 0; li < EXTENDED_LOW_KEYCODES.length; li++) {
      var lowLabel = String(lowLabels[li]);
      steps.push({
        code: EXTENDED_LOW_KEYCODES[li],
        shift: false,
        ctrl: true,
        label: lowLabel,
        identity: "ctrl+" + lowLabel,
        modifierName: modifierName,
        midiOffset: li - EXTENDED_LOW_COUNT,
        isBlack: EXTENDED_LOW_IS_BLACK[li],
        zone: "low"
      });
    }
  }

  for (var i = 0; i < MAX_WHITE_KEYCODES.length && i < whiteLabels.length; i++) {
    var whiteLabel = String(whiteLabels[i]);
    var code = MAX_WHITE_KEYCODES[i];
    var whiteOffset = maxWhiteSemitoneOffsetForIndex(i);

    steps.push({
      code: code,
      shift: false,
      ctrl: false,
      label: whiteLabel,
      identity: whiteLabel,
      midiOffset: whiteOffset,
      isBlack: false,
      zone: "main"
    });

    if (maxWhiteHasBlackAfter(i)) {
      var blackLabel = maxShiftLabelForWhite(whiteLabel, i, topRowShiftLabels);
      steps.push({
        code: code,
        shift: true,
        ctrl: false,
        label: blackLabel,
        identity: blackLabel,
        midiOffset: whiteOffset + 1,
        isBlack: true,
        zone: "main"
      });
    }
  }

  if (extended) {
    for (var hi = 0; hi < EXTENDED_HIGH_KEYCODES.length; hi++) {
      var highLabel = String(highLabels[hi]);
      steps.push({
        code: EXTENDED_HIGH_KEYCODES[hi],
        shift: false,
        ctrl: true,
        label: highLabel,
        identity: "ctrl+" + highLabel,
        modifierName: modifierName,
        midiOffset: CLASSIC_KEY_COUNT + hi,
        isBlack: EXTENDED_HIGH_IS_BLACK[hi],
        zone: "high"
      });
    }
  }

  return {
    id: id,
    label: label + (extended ? " (Roblox 88-key extended)" : " (Roblox/MAX 61-key)"),
    builtIn: true,
    model: extended ? "max88" : "max61",
    mode: mode,
    modifierName: modifierName,
    anchorIndex: extended ? EXTENDED_LOW_COUNT : 0,
    steps: steps,
    layoutString: whiteLabels.join('')
  };
}

function builtInKeyboardProfile(id, mode, modifier) {
  id = normalizeKeyboardProfile(id);
  if (id === "azerty") {
    return makeMaxKeyboardProfile("azerty", "French AZERTY", AZERTY_PROFILE_LABELS, AZERTY_TOP_ROW_SHIFT_LABELS, mode, AZERTY_EXTENDED_LOW_LABELS, AZERTY_EXTENDED_HIGH_LABELS, modifier);
  }
  return makeMaxKeyboardProfile("us", "US QWERTY", US_PROFILE_LABELS, US_TOP_ROW_SHIFT_LABELS, mode, US_EXTENDED_LOW_LABELS, US_EXTENDED_HIGH_LABELS, modifier);
}

function makeCustomKeyboardProfile(layoutString) {
  var chars = normalizeLayout(layoutString);
  var steps = [];
  for (var i = 0; i < chars.length; i++) {
    var ch = chars[i];
    var spec = layoutCharSpec(ch);
    steps.push(spec ? {
      code: spec.code,
      shift: !!spec.shift,
      ctrl: false,
      label: ch,
      identity: ch,
      zone: "main"
    } : {
      code: null,
      shift: false,
      ctrl: false,
      label: ch,
      identity: ch,
      zone: "main"
    });
  }
  return {
    id: "custom",
    label: "Legacy Custom",
    builtIn: false,
    mode: "classic",
    anchorIndex: 0,
    steps: steps,
    layoutString: chars.join('')
  };
}

function normalizeKeyboardProfile(value) {
  var text = trim(value == null ? "" : String(value)).toLowerCase();
  if (text === "azerty" || text === "fr" || text === "fr-azerty" || text === "french" || text === "french-azerty") {
    return "azerty";
  }
  if (text === "custom" || text === "legacy" || text === "legacy-custom") {
    return "custom";
  }
  return "us";
}

function inferKeyboardProfileFromLayout(layoutString) {
  var normalized = normalizeLayout(layoutString).join('');
  if (normalized === LEGACY_AZERTY_LAYOUT || normalized === AZERTY_PROFILE_LABELS.join('')) return "azerty";
  if (normalized === LEGACY_US_LAYOUT || normalized === US_PROFILE_LABELS.join('')) return "us";
  return "custom";
}

function resolveKeyboardProfile(cfg, existingProfile) {
  if (existingProfile && existingProfile.steps) return existingProfile;
  cfg = sanitizeConfig(cfg || {});
  var id = normalizeKeyboardProfile(cfg.keyboardProfile == null ? inferKeyboardProfileFromLayout(cfg.keyLayout) : cfg.keyboardProfile);
  if (id === "custom") {
    return makeCustomKeyboardProfile(cfg.keyLayout);
  }
  return builtInKeyboardProfile(id, cfg.keyboardMode, cfg.extendedModifier);
}

function keyboardProfileLabel(profileOrId) {
  if (profileOrId && profileOrId.label) return String(profileOrId.label);
  var id = normalizeKeyboardProfile(profileOrId);
  if (id === "custom") return "Legacy Custom";
  return builtInKeyboardProfile(id).label;
}



function chooseKeyboardProfile(currentProfile, currentLayout) {
  currentProfile = normalizeKeyboardProfile(currentProfile == null ? inferKeyboardProfileFromLayout(currentLayout) : currentProfile);

  while (true) {
    var category = showDialog(
      APP_NAME,
      [
        "Choose the keyboard profile used for the exact Roblox/MAX note map.",
        "",
        "US QWERTY and French AZERTY are the built-in 61-key MAX profiles. They use the standard white-keys-from-1-to-m map, with black keys on the corresponding Shifted keys.",
        "",
        "Legacy Custom keeps the older free-form character layout for unusual piano experiences."
      ].join("\n"),
      ["Cancel", "Legacy Custom", "Built-in Profile"],
      currentProfile === "custom" ? "Legacy Custom" : "Built-in Profile",
      "Cancel",
      "note"
    );
    if (category === "Cancel") throw canceledError();
    if (category === "Legacy Custom") {
      var layoutAns = promptForText(
        "Legacy custom layout",
        "Enter the keyboard characters used for ascending notes, one character per semitone. Example: 1234567890qwertyuiopasdfghjklzxcvbnm,./\n\nFor the most reliable exact Roblox/MAX mapping, prefer the built-in US QWERTY or French AZERTY profiles instead of this legacy custom mode.",
        currentLayout || defaultConfig.keyLayout
      );
      if (normalizeLayout(layoutAns).length === 0) {
        throw new Error("The layout cannot be empty.");
      }
      return {
        keyboardProfile: "custom",
        keyLayout: normalizeLayout(layoutAns).join('')
      };
    }

    var builtIn = showDialog(
      APP_NAME,
      [
        "Choose the built-in keyboard profile.",
        "",
        "US QWERTY: 1234567890 / qwertyuiop / asdfghjkl / zxcvbnm,./",
        "French AZERTY: &é\"'(-è_çà / azertyuiop / qsdfghjkl / wxcvbn,;:!",
        "",
        "These built-in profiles are the recommended precise mappings."
      ].join("\n"),
      ["Back", "French AZERTY", "US QWERTY"],
      currentProfile === "azerty" ? "French AZERTY" : "US QWERTY",
      "Back",
      "note"
    );
    if (builtIn === "Back") {
      continue;
    }
    if (builtIn === "French AZERTY") {
      return {
        keyboardProfile: "azerty",
        keyLayout: AZERTY_PROFILE_LABELS.join('')
      };
    }
    return {
      keyboardProfile: "us",
      keyLayout: US_PROFILE_LABELS.join('')
    };
  }
}

function frontmostApplicationInfo() {
  try {
    var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (front) {
      var name = unwrapMaybe(front.localizedName);
      var bundleId = unwrapMaybe(front.bundleIdentifier);
      var path = '';
      var pid = 0;
      try {
        pid = Number(front.processIdentifier);
      } catch (_) {
        try {
          pid = parseInt(String(front.processIdentifier), 10);
        } catch (_) {}
      }
      try {
        if (front.executableURL) path = unwrapMaybe(front.executableURL.path);
      } catch (_) {}
      return {
        name: String(name || ''),
        bundleIdentifier: String(bundleId || ''),
        path: String(path || ''),
        pid: pid > 0 ? pid : 0
      };
    }
  } catch (e) {
    // Fall through to System Events.
  }

  try {
    var se = Application('System Events');
    var procs = se.applicationProcesses.whose({ frontmost: true })();
    if (procs && procs.length > 0) {
      var pid2 = 0;
      try {
        pid2 = Number(procs[0].unixId());
      } catch (_) {
        try {
          pid2 = parseInt(String(procs[0].unixId()), 10);
        } catch (_) {}
      }
      return { name: String(procs[0].name()), bundleIdentifier: '', path: '', pid: pid2 > 0 ? pid2 : 0 };
    }
  } catch (e2) {
    // Ignore and return empty info.
  }

  return { name: '', bundleIdentifier: '', path: '', pid: 0 };
}

function applicationInfoForPid(pid) {
  pid = Math.round(Number(pid));
  if (!(pid > 0)) return { name: '', bundleIdentifier: '', path: '', pid: 0 };
  try {
    var running = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    if (running) {
      var name = unwrapMaybe(running.localizedName);
      var bundleId = unwrapMaybe(running.bundleIdentifier);
      var path = '';
      try {
        if (running.executableURL) path = unwrapMaybe(running.executableURL.path);
      } catch (_) {}
      return {
        name: String(name || ''),
        bundleIdentifier: String(bundleId || ''),
        path: String(path || ''),
        pid: pid
      };
    }
  } catch (e) {
    // Ignore and fall back.
  }
  return { name: '', bundleIdentifier: '', path: '', pid: pid };
}

function currentProcessId() {
  try {
    return Math.round(Number($.NSProcessInfo.processInfo.processIdentifier));
  } catch (e) {
    return 0;
  }
}

function currentOperatingSystemVersionText() {
  try {
    var s = unwrapMaybe($.NSProcessInfo.processInfo.operatingSystemVersionString);
    if (s) return String(s);
  } catch (e) {
    // Ignore.
  }
  return "";
}

function accessibilityTrustedValue() {
  try {
    if ($.AXIsProcessTrusted) {
      return Boolean($.AXIsProcessTrusted());
    }
  } catch (e) {
    // Ignore.
  }
  return null;
}

function describeAccessibilityTrustStatus() {
  var value = accessibilityTrustedValue();
  if (value === null) return 'unavailable';
  return value ? 'true' : 'false';
}

function currentAppBundlePath() {
  var execPath = currentExecutablePath();
  if (!execPath) return "";
  var marker = "/Contents/MacOS/";
  var idx = execPath.lastIndexOf(marker);
  if (idx >= 0) {
    return execPath.slice(0, idx);
  }
  return "";
}

function describeApplicationInfo(info) {
  info = info || {};
  var parts = [];
  if (info.name) parts.push("name=" + String(info.name));
  if (info.bundleIdentifier) parts.push("bundle=" + String(info.bundleIdentifier));
  if (info.path) parts.push("path=" + String(info.path));
  if (info.pid) parts.push("pid=" + String(info.pid));
  return parts.length > 0 ? parts.join(", ") : "(unknown application)";
}

function isOwnApplicationInfo(info) {
  if (!info) return false;

  var name = String(info.name || "").toLowerCase();
  var bundleId = String(info.bundleIdentifier || "").toLowerCase();
  var path = String(info.path || "").toLowerCase();
  var haystack = name + "\n" + bundleId + "\n" + path;

  if (haystack.indexOf("roblox midi piano player") >= 0) return true;
  if (haystack.indexOf("midi piano player") >= 0) return true;

  var ownExec = String(currentExecutablePath() || "").toLowerCase();
  if (ownExec && path && path === ownExec) return true;

  var ownBundle = String(currentAppBundlePath() || "").toLowerCase();
  if (ownBundle && path && path.indexOf(ownBundle) === 0) return true;

  return false;
}

function isRobloxApplicationInfo(info) {
  if (!info) return false;
  if (isOwnApplicationInfo(info)) return false;

  var name = String(info.name || "").toLowerCase();
  var bundleId = String(info.bundleIdentifier || "").toLowerCase();
  var path = String(info.path || "").toLowerCase();
  var haystack = name + "\n" + bundleId + "\n" + path;

  if (bundleId.indexOf("roblox") >= 0) return true;
  if (path.indexOf("/roblox") >= 0) return true;
  if (name === "roblox" || name.indexOf("roblox player") >= 0 || name.indexOf("robloxstudio") >= 0 || name.indexOf("roblox studio") >= 0) return true;
  if (haystack.indexOf("roblox midi piano player") >= 0) return false;
  if (haystack.indexOf("roblox") >= 0 && haystack.indexOf("midi piano player") < 0) return true;
  return false;
}

function isRobloxFrontmost() {
  return isRobloxApplicationInfo(frontmostApplicationInfo());
}

function mergeTempoChanges(list) {
  var copy = list.slice().sort(function(a, b) {
    if (a.tick === b.tick) return a.microPerQN - b.microPerQN;
    return a.tick - b.tick;
  });
  var out = [];
  for (var i = 0; i < copy.length; i++) {
    if (out.length > 0 && out[out.length - 1].tick === copy[i].tick) {
      out[out.length - 1] = copy[i];
    } else {
      out.push({ tick: copy[i].tick, microPerQN: copy[i].microPerQN, secondsAt: 0 });
    }
  }
  return out;
}

function annotateTempoSeconds(tempos, division) {
  if (tempos.length === 0) return;
  tempos[0].secondsAt = 0;
  for (var i = 1; i < tempos.length; i++) {
    var prev = tempos[i - 1];
    var dticks = tempos[i].tick - prev.tick;
    var dsec = dticks * prev.microPerQN / 1000000.0 / division;
    tempos[i].secondsAt = prev.secondsAt + dsec;
  }
}

function tickToSeconds(tick, tempos, division) {
  if (tempos.length === 0) {
    return tick * 500000.0 / 1000000.0 / division;
  }
  var idx = 0;
  for (var i = 0; i < tempos.length; i++) {
    if (tempos[i].tick > tick) break;
    idx = i;
  }
  var tc = tempos[idx];
  var dticks = tick - tc.tick;
  return tc.secondsAt + dticks * tc.microPerQN / 1000000.0 / division;
}

function describeSemitoneShift(delta) {
  delta = Math.round(Number(delta) || 0);
  if (delta === 0) return "0 semitones (same key)";
  var sign = delta > 0 ? "+" : "";
  var parts = [sign + delta + " semitones"];
  var absDelta = Math.abs(delta);
  if ((absDelta % 12) === 0) {
    var octaves = absDelta / 12;
    parts.push(octaves + " octave" + (octaves === 1 ? "" : "s"));
  }
  return parts.join(" / ");
}

function noteName(midi) {
  var names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  if (midi < 0 || midi > 127) return "MIDI " + midi;
  var octave = Math.floor(midi / 12) - 1;
  return names[midi % 12] + octave;
}

function noteLabel(midi) {
  return noteName(midi) + " (" + midi + ")";
}

function parseMIDINoteInput(text) {
  text = trim(text);
  if (!text) return null;
  if (/^-?\d+$/.test(text)) {
    return clampBaseNote(parseInt(text, 10));
  }

  var m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(text);
  if (!m) return null;

  var baseMap = {
    C: 0,
    D: 2,
    E: 4,
    F: 5,
    G: 7,
    A: 9,
    B: 11
  };
  var letter = m[1].toUpperCase();
  var accidental = m[2] || '';
  var octave = parseInt(m[3], 10);
  var semitone = baseMap[letter];
  if (accidental === '#') semitone += 1;
  if (accidental === 'b') semitone -= 1;
  var midi = (octave + 1) * 12 + semitone;
  return clampBaseNote(midi);
}

function clampBaseNote(v) {
  v = Math.round(Number(v));
  if (!isFinite(v)) v = defaultConfig.baseMIDINote;
  return clamp(v, 0, 127);
}

function parseMIDIFile(path) {
  var bin = readBinaryString(path);
  var pos = 0;

  function ensure(n) {
    if (pos + n > bin.length) throw new Error("Unexpected end of MIDI file.");
  }

  function readBytes(n) {
    ensure(n);
    var out = [];
    for (var i = 0; i < n; i++) out.push(bin.charCodeAt(pos + i) & 0xFF);
    pos += n;
    return out;
  }

  function readU16() {
    var b = readBytes(2);
    return (b[0] << 8) | b[1];
  }

  function readU32() {
    var b = readBytes(4);
    return ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
  }

  function readASCII(n) {
    var b = readBytes(n);
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  if (readASCII(4) !== 'MThd') {
    throw new Error('Not a standard MIDI file.');
  }
  var hdrLen = readU32();
  ensure(hdrLen);
  var hdrStart = pos;
  var format = readU16();
  var tracks = readU16();
  var division = readU16();
  pos = hdrStart + hdrLen;

  if (format > 2) throw new Error('Unsupported MIDI format ' + format + '.');
  if (division & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported in this build.');

  var notes = [];
  var tempos = [];

  for (var ti = 0; ti < tracks; ti++) {
    if (readASCII(4) !== 'MTrk') {
      throw new Error('Invalid MIDI track header.');
    }
    var trackLen = readU32();
    ensure(trackLen);
    var track = bin.slice(pos, pos + trackLen);
    pos += trackLen;
    var parsed = parseTrack(track);
    notes = notes.concat(parsed.notes);
    tempos = tempos.concat(parsed.tempos);
  }

  // Drum tracks (MIDI channel 10) hold percussion sounds, not pitches: on the
  // piano they would come out as stray notes. They are left out, unless the
  // file has nothing else (some files put a melody on channel 10).
  var drumNotes = 0;
  var melodic = notes.filter(function(n) { return n.channel !== 9; });
  if (melodic.length > 0 && melodic.length < notes.length) {
    drumNotes = notes.length - melodic.length;
    notes = melodic;
  }

  notes.sort(function(a, b) {
    if (a.tick === b.tick) return a.note - b.note;
    return a.tick - b.tick;
  });
  tempos.sort(function(a, b) { return a.tick - b.tick; });

  return { notes: notes, tempos: tempos, division: division, drumNotes: drumNotes };
}

function parseTrack(track) {
  var pos = 0;
  var absTick = 0;
  var runningStatus = 0;
  var notes = [];
  var tempos = [];
  // Pair each note-on with its note-off so we know how long the note lasts.
  // active[(channel<<8)|note] -> QUEUE of open note-ons awaiting a note-off.
  // A queue (not a single slot) matters because the same pitch is often struck
  // again before the previous one is released. With a single slot the second
  // note-on overwrote the first, so the next note-off closed the wrong note and
  // produced a nonsense length, which made those notes come out clipped.
  var active = {};

  while (pos < track.length) {
    var vlq = readVLQ(track, pos);
    absTick += vlq.value;
    pos = vlq.nextPos;

    if (pos >= track.length) break;

    var status = track.charCodeAt(pos) & 0xFF;
    if (status < 0x80) {
      if (runningStatus === 0) throw new Error('Invalid running status in MIDI track.');
      status = runningStatus;
    } else {
      pos += 1;
      if (status < 0xF0) runningStatus = status;
      else runningStatus = 0;
    }

    if (status === 0xFF) {
      if (pos >= track.length) throw new Error('Truncated meta event.');
      var metaType = track.charCodeAt(pos) & 0xFF;
      pos += 1;
      var metaLen = readVLQ(track, pos);
      pos = metaLen.nextPos;
      if (pos + metaLen.value > track.length) throw new Error('Truncated meta event payload.');
      if (metaType === 0x51 && metaLen.value === 3) {
        var b0 = track.charCodeAt(pos) & 0xFF;
        var b1 = track.charCodeAt(pos + 1) & 0xFF;
        var b2 = track.charCodeAt(pos + 2) & 0xFF;
        tempos.push({ tick: absTick, microPerQN: (b0 << 16) | (b1 << 8) | b2 });
      }
      pos += metaLen.value;
      if (metaType === 0x2F) break;
    } else if (status === 0xF0 || status === 0xF7) {
      var syxLen = readVLQ(track, pos);
      pos = syxLen.nextPos + syxLen.value;
      if (pos > track.length) throw new Error('Truncated sysex event.');
    } else {
      var eventType = status & 0xF0;
      if (eventType === 0x80 || eventType === 0x90 || eventType === 0xA0 || eventType === 0xB0 || eventType === 0xE0) {
        if (pos + 2 > track.length) throw new Error('Truncated MIDI channel event.');
        var d1 = track.charCodeAt(pos) & 0xFF;
        var d2 = track.charCodeAt(pos + 1) & 0xFF;
        pos += 2;
        var channel = status & 0x0F;
        var slot = (channel << 8) | d1;
        if (eventType === 0x90 && d2 > 0) {
          var noteObj = { tick: absTick, note: d1, durTicks: 0, channel: channel };
          notes.push(noteObj);
          if (!active[slot]) active[slot] = [];
          active[slot].push(noteObj);              // queue it until a note-off arrives
        } else if (eventType === 0x80 || (eventType === 0x90 && d2 === 0)) {
          // Note-off (either a real 0x80, or a 0x90 with velocity 0). Close the
          // OLDEST still-open note on this pitch, which is the one it belongs to.
          var queue = active[slot];
          if (queue && queue.length > 0) {
            var openNote = queue.shift();
            var held = absTick - openNote.tick;
            if (held > 0) openNote.durTicks = held;
          }
        }
      } else if (eventType === 0xC0 || eventType === 0xD0) {
        if (pos + 1 > track.length) throw new Error('Truncated MIDI channel event.');
        pos += 1;
      } else {
        throw new Error('Unsupported MIDI status byte 0x' + status.toString(16).toUpperCase());
      }
    }
  }

  return { notes: notes, tempos: tempos };
}

function readVLQ(str, pos) {
  var value = 0;
  for (var i = 0; i < 4; i++) {
    if (pos + i >= str.length) throw new Error('Invalid variable-length quantity.');
    var byte = str.charCodeAt(pos + i) & 0xFF;
    value = (value << 7) | (byte & 0x7F);
    if ((byte & 0x80) === 0) {
      return { value: value, nextPos: pos + i + 1 };
    }
  }
  throw new Error('Invalid variable-length quantity.');
}

function nowSeconds() {
  return Number($.NSDate.date.timeIntervalSince1970);
}

function sleepSeconds(seconds) {
  if (seconds > 0) $.NSThread.sleepForTimeInterval(seconds);
}

function basename(path) {
  return String(path).split('/').pop();
}

function normalizeLayout(s) {
  s = String(s || '');
  var out = [];
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch === '\n' || ch === '\r' || ch === '\t' || ch === ' ') continue;
    out.push(ch);
  }
  return out;
}

function trimFloat(v) {
  var s = Number(v).toFixed(2);
  s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s || '0';
}

function formatNumber(v, digits) {
  return Number(v).toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function trim(s) {
  return String(s).replace(/^\s+|\s+$/g, '');
}

function clamp(v, lo, hi) {
  v = Number(v);
  if (!isFinite(v)) v = lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function isFiniteNumber(v) {
  return typeof v === 'number' && isFinite(v);
}

function shellQuote(s) {
  s = String(s);
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function canceledError() {
  var e = new Error('User canceled.');
  e.code = -128;
  return e;
}

function isCanceledError(e) {
  if (!e) return false;
  var msg = messageOf(e);
  return e.code === -128 || msg.indexOf('User canceled') >= 0 || msg.indexOf('(-128)') >= 0;
}

function messageOf(e) {
  try {
    if (e.message) return String(e.message);
  } catch (_) {}
  return String(e);
}

function unwrapMaybe(value) {
  try {
    if (value == null) return '';
    return ObjC.unwrap(value);
  } catch (e) {
    try {
      return String(value);
    } catch (_) {
      return '';
    }
  }
}


// =============================================================================
// One-window native UI (v2.0.0)
// =============================================================================
// The app used to be a chain of small dialogs: Play / More / Tools, then a
// six-step settings wizard, then a wall-of-text summary. It is now ONE window:
//   * pick a song (button or drag & drop) and see it laid out on a picture of
//     the Roblox piano — green keys are the ones the song uses;
//   * switch between Mode 1 (the classic 61-key piano) and Mode 2 (the full
//     88-key piano, whose extra keys are played with Ctrl held down);
//   * change settings in place — they are saved as you go;
//   * arm playback and follow it live (armed / playing / finished), with Stop.
// Everything is built with AppKit through the JXA bridge; there is no nib.
// The old dialog flow still exists (--dialogs) and is the fallback if the
// window cannot be created for any reason.

var UI = null;
var UI_TIMER_SECONDS = 0.25;
var UI_WIDTH = 920;
var UI_MARGIN = 24;
var UI_CONTENT_WIDTH = UI_WIDTH - 2 * UI_MARGIN;
var UI_KEYBOARD_HEIGHT = 142;
var UI_RECENT_STATUS_SECONDS = 900;   // show "finished"/"stopped" from the last 15 minutes only
var UI_ROBLOX_LOOKUP_SECONDS = 1.5;   // how often to look for Roblox while it is not found
var UI_TAG = {
  language: 1, chooseMidi: 2, transpose: 3, mode: 4, layout: 5, precision: 6, sending: 7,
  modifier: 8, speed: 9, delay: 10, base: 11, resetBase: 12, liveLog: 13, arm: 14, stop: 15,
  openLog: 16, openFolder: 17, about: 18, pause: 19, speedButtons: 20, slower: 21, faster: 22,
  normalSpeed: 23, liveKeys: 24, access: 25, website: 26, helpManual: 27, helpStart: 28,
  helpTrouble: 29, helpIssue: 30, demoBase: 100
};

// The demo songs bundled in Contents/Resources/demo (build.sh copies them
// from docs/demo, where tools/genmidi.py writes them).
var DEMO_SONGS = [
  { file: "ode-to-joy.mid", en: "Ode to Joy (Beethoven)", fr: "Ode à la joie (Beethoven)" },
  { file: "fur-elise.mid", en: "Für Elise (Beethoven)", fr: "Lettre à Élise (Beethoven)" },
  { file: "full-range-arpeggios.mid", en: "Full-range arpeggios (Mode 2)", fr: "Arpèges sur tout le clavier (Mode 2)" }
];
var DOCS_URL = APP_REPO_URL + "/blob/main/docs/";

// Key codes the live keys may pass on to Roblox besides the piano's own keys:
// Space (the sustain pedal of many Roblox pianos). Everything else — Escape,
// Return, Tab, "/" (Roblox's chat key), arrows, function keys — stays here.
var LIVE_EXTRA_KEYCODES = [49];
var LIVE_MODIFIER_KEYCODES = { shift: 56, ctrl: 59, alt: 58 };
var NS_FLAG_SHIFT = 1 << 17;
var NS_FLAG_CONTROL = 1 << 18;
var NS_FLAG_OPTION = 1 << 19;
var NS_FLAG_COMMAND = 1 << 20;

var UI_STRINGS = {
  en: {
    subtitle: "Plays MIDI files on a Roblox piano — and lets you play it live from this window.",
    langEnglish: "English",
    langFrench: "Français",
    sectionSong: "1 · SONG",
    sectionPiano: "2 · ROBLOX PIANO",
    sectionSettings: "3 · SETTINGS  ·  saved automatically",
    chooseMidi: "Choose MIDI file…",
    chooseMidiPrompt: "Choose a MIDI file to play on the Roblox piano",
    openButton: "Open",
    dropHint: "…or drop a .mid file anywhere on this window.",
    transposeLabel: "Transpose this song:",
    transposeNone: "0 · none",
    transposeItem: "{sign}{n} semitones",
    noSong: "No song loaded yet.",
    noSongInfo: "Pick a MIDI file to see how it fits on the piano — or try one from File › Demo Songs.",
    songInfo: "{notes} notes · {span} · about {duration} at {speed}× · starts {delay} s after your click",
    songInfoDrums: " · {n} drum hits left out",
    mode1: "Mode 1 · Classic piano (61 keys)",
    mode2: "Mode 2 · Extended piano (88 keys)",
    mode1Help: "Standard Roblox piano, C2 to C7: white keys 1 … m, black keys with Shift.",
    mode2Help: "Full 88-key piano, A0 to C8: adds 15 low keys ({mod} + {low}) and 12 high keys ({mod} + {high}) — the keys drawn with a dot in the game.",
    coverageNone: "Load a song to see which keys it uses.",
    coverage: "{mapped} of {total} notes playable ({pct}%)",
    coverageSkipped: " · skipped: {low} below the piano, {high} above it",
    coverageMode2Gain: " · Mode 2 would play {gain} more",
    coverageMode1Same: " · Mode 1 would play the same notes",
    coverageMode1Loss: " · Mode 1 would lose {loss}",
    legend: "Green = keys this song uses · Orange = used keys that are off in this mode · Dot above a key = hold {mod} · Blue = pressed now",
    liveKeys: "Live keys — what you press or click here is played in Roblox too",
    liveConnected: "● Connected to Roblox",
    liveNoRoblox: "○ Roblox is not open",
    liveNeedsAccess: "⚠ Allow Accessibility first",
    liveOff: "Off",
    kbZoneLow: "{from}–{to} · {mod}",
    kbZoneMain: "{from}–{to} · 61 standard keys",
    kbZoneHigh: "{from}–{to} · {mod}",
    kbZoneOff: " · off",
    kbCustom: "Legacy custom layout with {n} keys — the piano picture only exists for the built-in layouts.",
    kbSkippedLow: "◀ {n} notes below",
    kbSkippedHigh: "{n} notes above ▶",
    kbSkippedLowOne: "◀ 1 note below",
    kbSkippedHighOne: "1 note above ▶",
    layoutLabel: "Keyboard layout:",
    layoutUs: "US QWERTY",
    layoutFr: "French AZERTY",
    layoutCustom: "Legacy custom…",
    customLayoutTitle: "Legacy custom layout",
    customLayoutPrompt: "Enter the keys for ascending notes, one character per semitone. Only characters of a US keyboard can be sent.",
    precisionLabel: "Note mapping:",
    precisionPerfect: "Perfect — exact notes only",
    precisionSmart: "Smart best fit — may transpose",
    precisionHelp: "Perfect plays every note exactly where it is written and skips notes outside the piano. Smart best fit may shift the whole song to fit more notes in.",
    sendingLabel: "Key sending:",
    sendAuto: "Automatic (Quartz, then Accessibility)",
    sendQuartz: "Quartz — fast",
    sendAx: "Accessibility — compatible",
    sendingHelp: "Quartz sends a key in about 2 ms, so chords land together. Accessibility is slower but may help if a Roblox update ever stops Quartz. Automatic uses Quartz and switches by itself if it fails.",
    modifierLabel: "Extended keys held with:",
    modCtrl: "Control (standard)",
    modAlt: "Option / Alt",
    speedLabel: "Speed:",
    delayLabel: "Delay after click:",
    delayUnit: "seconds",
    baseLabel: "Note of key 1:",
    resetBase: "Reset to C2",
    baseInfo: "MIDI {n}",
    liveLog: "Also open the live log (Terminal)",
    arm: "Arm playback",
    armHelp: "Then click the Roblox piano window once. While it plays you can pause, slow down or speed up from here — playback keeps going even if you close this window.",
    stop: "Stop",
    pause: "Pause",
    resume: "Resume",
    speedCaption: "Speed",
    accessButton: "Allow…",
    openLog: "Open log",
    openFolder: "Config folder",
    about: "About",
    statusIdle: "Ready.",
    statusIdleDetail: "Load a song, choose the piano mode, then arm playback.",
    statusLaunching: "Starting the background player…",
    statusLaunchingDetail: "This takes a moment.",
    statusWaiting: "Armed — click the Roblox piano window once.",
    statusWaitingDetail: "Waiting to play “{song}”. You can switch to other apps afterwards.",
    statusDelay: "Roblox detected — starting in a moment.",
    statusDelayDetail: "“{song}”",
    statusPlaying: "Playing “{song}”",
    statusPlayingDetail: "{pos} / {dur} · {speed}× · {done} of {total} notes · via {sender}",
    statusPaused: "Paused — “{song}”",
    statusPausedDetail: "{pos} / {dur} · press Resume to carry on from here",
    statusNeedsAccess: "macOS has not allowed this app to send keys yet",
    statusNeedsAccessDetail: "Click Allow…, then switch the app on in the Accessibility settings.",
    statusFinished: "Finished “{song}”.",
    statusFinishedDetail: "Load another song, or arm the same one again.",
    statusStopped: "Stopped.",
    statusStoppedDetail: "“{song}” was stopped.",
    statusError: "Playback error",
    statusErrorDetail: "{detail}",
    senderQuartz: "Quartz",
    senderAx: "Accessibility",
    errTitle: "Something went wrong",
    errNoSong: "Choose a MIDI file first.",
    errActive: "A playback is already active. Stop it first.",
    errNoNotesFit: "None of the song's notes fit the current piano range. Try Mode 2 or Smart best fit.",
    errDelay: "The delay must be a number of seconds between 0 and 30.",
    errBase: "Type a MIDI number like 36 or a note name like C2.",
    errBaseExtended: "In Mode 2 the note of key 1 must be at least {name} (MIDI {min}), so that the 15 low keys exist. It was set to that.",
    errArmed: "Playback could not be armed.",
    errLayoutEmpty: "The layout cannot be empty.",
    errMidiEmpty: "This MIDI file has no notes to play.",
    errMidiTiming: "This MIDI file uses a timing format the app cannot read.",
    stopNotDead: "A stop was requested, but the background player (PID {pid}) has not exited yet. If notes keep playing, quit Roblox to be sure.",
    menuFile: "File",
    menuOpen: "Open MIDI…",
    menuClose: "Close Window",
    menuEdit: "Edit",
    menuUndo: "Undo",
    menuRedo: "Redo",
    menuCut: "Cut",
    menuCopy: "Copy",
    menuPaste: "Paste",
    menuSelectAll: "Select All",
    menuWindow: "Window",
    menuMinimize: "Minimize",
    menuPlayback: "Playback",
    menuPause: "Pause / Resume",
    menuStop: "Stop",
    menuFaster: "Faster",
    menuSlower: "Slower",
    menuNormalSpeed: "Normal Speed",
    menuLiveKeys: "Live Keys",
    menuDemos: "Demo Songs",
    menuHelp: "Help",
    menuManual: "Roblox MIDI Piano Player Help",
    menuGettingStarted: "Getting Started",
    menuTroubleshooting: "Troubleshooting",
    menuReportIssue: "Report a Problem…",
    cancel: "Cancel",
    save: "Save",
    menuAbout: "About Roblox MIDI Piano Player",
    menuQuit: "Quit Roblox MIDI Piano Player",
    aboutTitle: "Roblox MIDI Piano Player {version}",
    aboutText: [
      "Loads a MIDI file and plays it on a Roblox piano by sending timed keystrokes straight to the Roblox process — so it keeps playing while you use other apps.",
      "",
      "Mode 1 is the classic 61-key Roblox piano (C2–C7): white keys 1 … m, black keys on Shift.",
      "Mode 2 is the full 88-key piano (A0–C8) found in pianos such as Talent Show: the 15 lowest and 12 highest notes are the dotted keys, played with Ctrl held down.",
      "",
      "Live keys: while this window is in front, the piano keys you press — or click on the piano picture — are pressed in Roblox too.",
      "While a song plays, − and + change the speed on the fly and Pause holds it where it is.",
      "",
      "Perfect mapping keeps every note exactly where it is written; notes outside the piano are skipped, never moved. Smart best fit may transpose to fit more of the song.",
      "",
      "macOS must allow this app under Privacy & Security → Accessibility so it can send keys.",
      "Settings, logs and the playback state live in the config folder.",
      "",
      "Free and open source. Not affiliated with Roblox Corporation."
    ].join("\n"),
    aboutWebsite: "Open the GitHub page",
    fileLoaded: "Loaded “{name}”."
  },
  fr: {
    subtitle: "Joue des fichiers MIDI sur un piano Roblox — et te laisse en jouer en direct depuis cette fenêtre.",
    langEnglish: "English",
    langFrench: "Français",
    sectionSong: "1 · MORCEAU",
    sectionPiano: "2 · PIANO ROBLOX",
    sectionSettings: "3 · RÉGLAGES  ·  enregistrés automatiquement",
    chooseMidi: "Choisir un fichier MIDI…",
    chooseMidiPrompt: "Choisis un fichier MIDI à jouer sur le piano Roblox",
    openButton: "Ouvrir",
    dropHint: "…ou dépose un fichier .mid n'importe où sur cette fenêtre.",
    transposeLabel: "Transposer ce morceau :",
    transposeNone: "0 · aucune",
    transposeItem: "{sign}{n} demi-tons",
    noSong: "Aucun morceau chargé pour l'instant.",
    noSongInfo: "Choisis un fichier MIDI pour voir comment il se place sur le piano — ou essaie Fichier › Morceaux de démo.",
    songInfo: "{notes} notes · {span} · environ {duration} à {speed}× · démarre {delay} s après ton clic",
    songInfoDrums: " · {n} coups de batterie ignorés",
    mode1: "Mode 1 · Piano classique (61 touches)",
    mode2: "Mode 2 · Piano étendu (88 touches)",
    mode1Help: "Piano Roblox standard, de C2 à C7 : touches blanches 1 … m, touches noires avec Maj.",
    mode2Help: "Piano complet 88 touches, de A0 à C8 : ajoute 15 touches graves ({mod} + {low}) et 12 touches aiguës ({mod} + {high}) — les touches à point dans le jeu.",
    coverageNone: "Charge un morceau pour voir les touches qu'il utilise.",
    coverage: "{mapped} notes jouables sur {total} ({pct} %)",
    coverageSkipped: " · ignorées : {low} sous le piano, {high} au-dessus",
    coverageMode2Gain: " · le Mode 2 en jouerait {gain} de plus",
    coverageMode1Same: " · le Mode 1 jouerait les mêmes notes",
    coverageMode1Loss: " · le Mode 1 en perdrait {loss}",
    legend: "Vert = touches utilisées par ce morceau · Orange = utilisées mais inactives dans ce mode · Point au-dessus = maintenir {mod} · Bleu = appuyée",
    liveKeys: "Touches en direct — ce que tu appuies ou cliques ici est joué dans Roblox aussi",
    liveConnected: "● Connecté à Roblox",
    liveNoRoblox: "○ Roblox n'est pas ouvert",
    liveNeedsAccess: "⚠ Autorise d'abord l'accessibilité",
    liveOff: "Désactivé",
    kbZoneLow: "{from}–{to} · {mod}",
    kbZoneMain: "{from}–{to} · 61 touches standard",
    kbZoneHigh: "{from}–{to} · {mod}",
    kbZoneOff: " · inactif",
    kbCustom: "Disposition personnalisée de {n} touches — l'image du piano n'existe que pour les dispositions intégrées.",
    kbSkippedLow: "◀ {n} notes en dessous",
    kbSkippedHigh: "{n} notes au-dessus ▶",
    kbSkippedLowOne: "◀ 1 note en dessous",
    kbSkippedHighOne: "1 note au-dessus ▶",
    layoutLabel: "Disposition du clavier :",
    layoutUs: "US QWERTY",
    layoutFr: "Français AZERTY",
    layoutCustom: "Personnalisée (ancien)…",
    customLayoutTitle: "Disposition personnalisée",
    customLayoutPrompt: "Entre les touches des notes montantes, un caractère par demi-ton. Seuls les caractères d'un clavier US peuvent être envoyés.",
    precisionLabel: "Correspondance des notes :",
    precisionPerfect: "Parfaite — notes exactes",
    precisionSmart: "Meilleur ajustement — peut transposer",
    precisionHelp: "Parfaite joue chaque note exactement où elle est écrite et ignore celles hors du piano. Le meilleur ajustement peut décaler tout le morceau pour faire tenir plus de notes.",
    sendingLabel: "Envoi des touches :",
    sendAuto: "Automatique (Quartz d'abord)",
    sendQuartz: "Quartz — rapide",
    sendAx: "Accessibilité — compatible",
    sendingHelp: "Quartz envoie une touche en 2 ms environ, donc les accords tombent ensemble. Accessibilité est plus lente mais peut aider si une mise à jour de Roblox bloque Quartz. Automatique utilise Quartz et change tout seul en cas d'échec.",
    modifierLabel: "Touches étendues avec :",
    modCtrl: "Contrôle (standard)",
    modAlt: "Option / Alt",
    speedLabel: "Vitesse :",
    delayLabel: "Délai après le clic :",
    delayUnit: "secondes",
    baseLabel: "Note de la touche 1 :",
    resetBase: "Remettre C2",
    baseInfo: "MIDI {n}",
    liveLog: "Aussi le journal en direct (Terminal)",
    arm: "Armer la lecture",
    armHelp: "Puis clique une fois sur la fenêtre du piano Roblox. Pendant la lecture, tu peux mettre en pause, ralentir ou accélérer d'ici — la lecture continue même si tu fermes cette fenêtre.",
    stop: "Arrêter",
    pause: "Pause",
    resume: "Reprendre",
    speedCaption: "Vitesse",
    accessButton: "Autoriser…",
    openLog: "Journal",
    openFolder: "Dossier de config",
    about: "À propos",
    statusIdle: "Prêt.",
    statusIdleDetail: "Charge un morceau, choisis le mode du piano, puis arme la lecture.",
    statusLaunching: "Démarrage du lecteur en arrière-plan…",
    statusLaunchingDetail: "Ça prend un instant.",
    statusWaiting: "Armé — clique une fois sur la fenêtre du piano Roblox.",
    statusWaitingDetail: "En attente pour jouer « {song} ». Tu pourras ensuite passer à d'autres apps.",
    statusDelay: "Roblox détecté — ça démarre dans un instant.",
    statusDelayDetail: "« {song} »",
    statusPlaying: "Lecture de « {song} »",
    statusPlayingDetail: "{pos} / {dur} · {speed}× · {done} notes sur {total} · via {sender}",
    statusPaused: "En pause — « {song} »",
    statusPausedDetail: "{pos} / {dur} · appuie sur Reprendre pour continuer d'ici",
    statusNeedsAccess: "macOS n'autorise pas encore cette app à envoyer des touches",
    statusNeedsAccessDetail: "Clique sur Autoriser…, puis active l'app dans les réglages Accessibilité.",
    statusFinished: "« {song} » terminé.",
    statusFinishedDetail: "Charge un autre morceau, ou arme de nouveau le même.",
    statusStopped: "Arrêté.",
    statusStoppedDetail: "« {song} » a été arrêté.",
    statusError: "Erreur de lecture",
    statusErrorDetail: "{detail}",
    senderQuartz: "Quartz",
    senderAx: "Accessibilité",
    errTitle: "Un problème est survenu",
    errNoSong: "Choisis d'abord un fichier MIDI.",
    errActive: "Une lecture est déjà en cours. Arrête-la d'abord.",
    errNoNotesFit: "Aucune note du morceau ne tient dans la plage du piano actuel. Essaie le Mode 2 ou le meilleur ajustement.",
    errDelay: "Le délai doit être un nombre de secondes entre 0 et 30.",
    errBase: "Tape un numéro MIDI comme 36 ou un nom de note comme C2.",
    errBaseExtended: "En Mode 2, la note de la touche 1 doit être au moins {name} (MIDI {min}) pour que les 15 touches graves existent. Elle a été mise à cette valeur.",
    errArmed: "La lecture n'a pas pu être armée.",
    errLayoutEmpty: "La disposition ne peut pas être vide.",
    errMidiEmpty: "Ce fichier MIDI ne contient aucune note à jouer.",
    errMidiTiming: "Ce fichier MIDI utilise un format de temps que l'app ne sait pas lire.",
    stopNotDead: "L'arrêt a été demandé, mais le lecteur en arrière-plan (PID {pid}) n'a pas encore quitté. Si des notes continuent, quitte Roblox pour être sûr.",
    menuFile: "Fichier",
    menuOpen: "Ouvrir un MIDI…",
    menuClose: "Fermer la fenêtre",
    menuEdit: "Édition",
    menuUndo: "Annuler",
    menuRedo: "Rétablir",
    menuCut: "Couper",
    menuCopy: "Copier",
    menuPaste: "Coller",
    menuSelectAll: "Tout sélectionner",
    menuWindow: "Fenêtre",
    menuMinimize: "Placer dans le Dock",
    menuPlayback: "Lecture",
    menuPause: "Pause / Reprendre",
    menuStop: "Arrêter",
    menuFaster: "Plus vite",
    menuSlower: "Moins vite",
    menuNormalSpeed: "Vitesse normale",
    menuLiveKeys: "Touches en direct",
    menuDemos: "Morceaux de démo",
    menuHelp: "Aide",
    menuManual: "Aide de Roblox MIDI Piano Player",
    menuGettingStarted: "Bien démarrer",
    menuTroubleshooting: "Dépannage",
    menuReportIssue: "Signaler un problème…",
    cancel: "Annuler",
    save: "Enregistrer",
    menuAbout: "À propos de Roblox MIDI Piano Player",
    menuQuit: "Quitter Roblox MIDI Piano Player",
    aboutTitle: "Roblox MIDI Piano Player {version}",
    aboutText: [
      "Charge un fichier MIDI et le joue sur un piano Roblox en envoyant les touches directement au processus Roblox — la lecture continue pendant que tu utilises d'autres apps.",
      "",
      "Le Mode 1 est le piano Roblox classique à 61 touches (C2–C7) : touches blanches 1 … m, noires avec Maj.",
      "Le Mode 2 est le piano complet à 88 touches (A0–C8) de pianos comme Talent Show : les 15 notes les plus graves et les 12 plus aiguës sont les touches à point, jouées avec Ctrl maintenu.",
      "",
      "Touches en direct : quand cette fenêtre est devant, les touches du piano que tu appuies — ou que tu cliques sur l'image du piano — sont aussi appuyées dans Roblox.",
      "Pendant la lecture, − et + changent la vitesse en direct et Pause arrête le morceau là où il en est.",
      "",
      "La correspondance parfaite garde chaque note exactement où elle est écrite ; les notes hors du piano sont ignorées, jamais déplacées. Le meilleur ajustement peut transposer pour faire tenir plus de notes.",
      "",
      "macOS doit autoriser cette app dans Confidentialité et sécurité → Accessibilité pour qu'elle puisse envoyer des touches.",
      "Les réglages, journaux et l'état de lecture sont dans le dossier de config.",
      "",
      "Libre et open source. Sans lien avec Roblox Corporation."
    ].join("\n"),
    aboutWebsite: "Ouvrir la page GitHub",
    fileLoaded: "« {name} » chargé."
  }
};

function uiEffectiveLanguage() {
  var pref = normalizeUILanguage(UI && UI.cfg ? UI.cfg.uiLanguage : "auto");
  if (pref === "auto") {
    try {
      var first = String(unwrapMaybe($.NSLocale.preferredLanguages.objectAtIndex(0)) || "").toLowerCase();
      if (first.indexOf("fr") === 0) return "fr";
    } catch (_) {
      // Fall through to English.
    }
    return "en";
  }
  return pref;
}

function T(key, vars) {
  var lang = uiEffectiveLanguage();
  var table = UI_STRINGS[lang] || UI_STRINGS.en;
  var text = table[key] != null ? table[key] : (UI_STRINGS.en[key] != null ? UI_STRINGS.en[key] : key);
  text = String(text);
  if (vars) {
    for (var k in vars) {
      if (vars.hasOwnProperty(k)) text = text.split("{" + k + "}").join(String(vars[k]));
    }
  }
  return text;
}

function formatClock(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds) || 0));
  var m = Math.floor(seconds / 60);
  var s = seconds % 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}

function modifierDisplayName(cfg) {
  return normalizeExtendedModifier(cfg && cfg.extendedModifier) === "alt" ? "Option" : "Ctrl";
}

// --- ObjC classes ------------------------------------------------------------
function uiRegisterClasses() {
  if (!$.RMPPController) {
    ObjC.registerSubclass({
      name: 'RMPPController',
      superclass: 'NSObject',
      methods: {
        'uiAction:': {
          types: ['void', ['id']],
          implementation: function(sender) { uiDispatchAction(sender); }
        },
        'uiTimer:': {
          types: ['void', ['id']],
          implementation: function(timer) { uiSafely(uiOnTimer, true); }
        },
        'applicationShouldTerminateAfterLastWindowClosed:': {
          types: ['BOOL', ['id']],
          implementation: function(sender) { return true; }
        },
        'applicationShouldTerminate:': {
          types: ['unsigned long', ['id']],
          implementation: function(sender) {
            try { liveReleaseAll(); } catch (_) {}
            try { uiRememberWindowPosition(); } catch (_) {}
            try { if (UI && UI.timer) UI.timer.invalidate; } catch (_) {}
            return 1; // NSTerminateNow
          }
        },
        // A key held down in the window never gets its key-up once the window
        // loses focus, so everything still pressed in Roblox is let go here.
        // Ends text editing so keys go back to the piano (see uiEndEditingSoon).
        'uiEndEditing:': {
          types: ['void', ['id']],
          implementation: function(field) {
            try { uiEndEditingOf(field); } catch (_) {}
          }
        },
        'uiMenuWillTrack:': {
          types: ['void', ['id']],
          implementation: function(note) { uiSafely(liveReleaseAll, true); }
        },
        'windowDidResignKey:': {
          types: ['void', ['id']],
          implementation: function(note) { uiSafely(liveReleaseAll, true); }
        },
        'windowWillClose:': {
          types: ['void', ['id']],
          implementation: function(note) {
            uiSafely(liveReleaseAll, true);
            uiSafely(uiRememberWindowPosition, true);
          }
        },
        'application:openFile:': {
          types: ['BOOL', ['id', 'id']],
          implementation: function(sender, path) {
            // AppKit also hands us every path found on the command line while
            // it finishes launching — including main.js itself. Only real MIDI
            // files count, and nothing may block (no alert) before launch is
            // complete, or the window never appears.
            var p = String(unwrapMaybe(path) || "");
            var lower = p.toLowerCase();
            if (!(lower.slice(-4) === ".mid" || lower.slice(-5) === ".midi")) return false;
            var ok = false;
            uiSafely(function() { uiLoadSong(p); ok = true; }, !(UI && UI.launched));
            return ok;
          }
        },
        'applicationDidFinishLaunching:': {
          types: ['void', ['id']],
          implementation: function(note) {
            if (!UI) return;
            UI.launched = true;
            uiWriteWindowInfo("launched");
          }
        }
      }
    });
  }
  // The main window sees every key event first, so live keys can pass the
  // piano keys on to Roblox whatever control happens to have the focus — but
  // never while a text field is being edited, and never with Command held.
  if (!$.RMPPWindow) {
    ObjC.registerSubclass({
      name: 'RMPPWindow',
      superclass: 'NSWindow',
      methods: {
        'sendEvent:': {
          types: ['void', ['id']],
          implementation: function(event) {
            var handled = false;
            try { handled = liveHandleKeyEvent(event); } catch (e) {
              try { appendPlaybackLog(UI ? UI.supportDir : "", "Live keys error: " + messageOf(e)); } catch (_) {}
            }
            if (!handled) ObjC.super(this).sendEvent(event);
          }
        }
      }
    });
  }
  // The piano picture: press a key with the mouse and it is pressed in Roblox;
  // drag across the keys for a glissando.
  if (!$.RMPPPianoView) {
    ObjC.registerSubclass({
      name: 'RMPPPianoView',
      superclass: 'NSImageView',
      methods: {
        'mouseDown:': {
          types: ['void', ['id']],
          implementation: function(event) { uiSafely(function() { liveMouse(event, "down"); }, true); }
        },
        'mouseDragged:': {
          types: ['void', ['id']],
          implementation: function(event) { uiSafely(function() { liveMouse(event, "drag"); }, true); }
        },
        'mouseUp:': {
          types: ['void', ['id']],
          implementation: function(event) { uiSafely(function() { liveMouse(event, "up"); }, true); }
        },
        'acceptsFirstMouse:': {
          types: ['BOOL', ['id']],
          implementation: function(event) { return true; }
        }
      }
    });
  }
  if (!$.RMPPDropView) {
    ObjC.registerSubclass({
      name: 'RMPPDropView',
      superclass: 'NSView',
      methods: {
        'draggingEntered:': {
          types: ['unsigned long', ['id']],
          implementation: function(info) { return uiDropPathFromInfo(info) ? 1 : 0; } // NSDragOperationCopy
        },
        'draggingUpdated:': {
          types: ['unsigned long', ['id']],
          implementation: function(info) { return uiDropPathFromInfo(info) ? 1 : 0; }
        },
        'performDragOperation:': {
          types: ['BOOL', ['id']],
          implementation: function(info) {
            var path = uiDropPathFromInfo(info);
            if (!path) return false;
            uiSafely(function() { uiLoadSong(path); });
            return true;
          }
        }
      }
    });
  }
}

function uiDropPathFromInfo(info) {
  try {
    var pb = info.draggingPasteboard;
    var path = "";
    try {
      var urlText = unwrapMaybe(pb.stringForType($.NSPasteboardTypeFileURL));
      if (urlText) {
        var url = $.NSURL.URLWithString($(String(urlText)));
        if (url && !url.isNil()) path = String(unwrapMaybe(url.path) || "");
      }
    } catch (_) {}
    if (!path) {
      try {
        var list = pb.propertyListForType($("NSFilenamesPboardType"));
        if (list && !list.isNil() && Number(list.count) > 0) path = String(unwrapMaybe(list.objectAtIndex(0)) || "");
      } catch (_) {}
    }
    if (!path) return "";
    var lower = path.toLowerCase();
    if (lower.slice(-4) === ".mid" || lower.slice(-5) === ".midi") return path;
    return "";
  } catch (e) {
    return "";
  }
}

// --- Entry point -------------------------------------------------------------
function mainWindowUI(options) {
  options = options || {};
  var supportDir = ensureSupportDir();
  var configPath = supportDir + "/config.json";
  var cfg = sanitizeConfig(loadConfig(configPath));

  uiRegisterClasses();
  try { $.NSProcessInfo.processInfo.setProcessName($(APP_NAME)); } catch (_) {}
  var nsApp = $.NSApplication.sharedApplication;
  nsApp.setActivationPolicy($.NSApplicationActivationPolicyRegular);

  UI = {
    supportDir: supportDir,
    configPath: configPath,
    cfg: cfg,
    song: null,
    transpose: 0,
    playback: null,
    statusKey: "",
    busy: false,
    paused: false,          // the pause requested from this window for `controlJobId`
    controlJobId: "",
    trusted: accessibilityTrustedValue(),
    ticks: 0,
    kb: null,               // the piano picture's model and geometry, for clicks and highlights
    highlights: {},         // key index -> overlay view, while a key is pressed
    w: {},
    nsApp: nsApp,
    controller: null,
    window: null,
    timer: null,
    selfTest: options.selfTest || null,
    launched: false
  };
  liveReset();
  uiCleanupStaleJobs();
  UI.controller = $.RMPPController.alloc.init;
  nsApp.setDelegate(UI.controller);
  // An open menu (menu bar or pop-up) takes the key-ups, so live keys let go first.
  try {
    $.NSNotificationCenter.defaultCenter.addObserverSelectorNameObject(UI.controller, 'uiMenuWillTrack:', $("NSMenuDidBeginTrackingNotification"), $());
  } catch (_) {}
  uiInstallDockIcon();
  uiBuildMenu();
  uiBuildWindow();
  uiApplyStrings();
  uiRefreshSong();
  uiRefreshPlayback();
  uiRefreshLiveStatus(true);

  // Reopen where the window was last time (the first time: centred).
  if (UI.selfTest || !uiRestoreWindowPosition()) UI.window.center;
  UI.window.makeKeyAndOrderFront(null);
  // AppKit would put the cursor in the first text field, and the piano keys
  // would then type into it instead of playing: start with no field focused.
  UI.window.makeFirstResponder($());
  if (UI.selfTest) {
    // The self test must stay visible to screencapture whatever the person is
    // doing: shown on the Space in use (even over a full-screen app), floating,
    // and without taking the focus away from them.
    UI.window.setCollectionBehavior((1 << 0) | (1 << 8));   // can join all Spaces | full-screen auxiliary
    UI.window.setLevel(3);                                   // floating
    UI.window.orderFrontRegardless;
  } else {
    nsApp.activateIgnoringOtherApps(true);
  }
  UI.timer = $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(UI_TIMER_SECONDS, UI.controller, 'uiTimer:', null, true);
  uiWriteWindowInfo("shown");

  if (options.midiPath) {
    uiSafely(function() { uiLoadSong(String(options.midiPath)); });
  }
  if (UI.selfTest) {
    return uiRunSelfTest();
  }
  nsApp.run;
}

// A small diagnostic file: which window is ours and whether it is visible.
// Lets a script (or a future debugging session) capture the window from the
// outside with `screencapture -l <windowNumber>`.
function uiWriteWindowInfo(stage) {
  try {
    var f = UI.window.frame;
    writeJSONFile(UI.supportDir + "/ui_window.json", {
      stage: stage,
      pid: currentProcessId(),
      windowNumber: Number(UI.window.windowNumber),
      visible: !!UI.window.isVisible,
      frame: { x: Number(f.origin.x), y: Number(f.origin.y), width: Number(f.size.width), height: Number(f.size.height) },
      updatedAt: nowSeconds()
    });
  } catch (_) {
    // Diagnostics only.
  }
}

// The window's top-left corner is kept in config.json. It is only reused when
// it is still on one of the screens (a display may have been unplugged).
function uiRestoreWindowPosition() {
  var tl = UI.cfg.windowTopLeft;
  if (!tl) return false;
  try {
    var screens = $.NSScreen.screens;
    for (var i = 0; i < Number(screens.count); i++) {
      var f = screens.objectAtIndex(i).visibleFrame;
      var x0 = Number(f.origin.x), y0 = Number(f.origin.y);
      var x1 = x0 + Number(f.size.width), y1 = y0 + Number(f.size.height);
      if (tl.x >= x0 - 40 && tl.x <= x1 - 120 && tl.y >= y0 + 120 && tl.y <= y1 + 1) {
        UI.window.setFrameTopLeftPoint($.NSMakePoint(tl.x, tl.y));
        return true;
      }
    }
  } catch (_) {
    // Fall back to centring.
  }
  return false;
}

function uiRememberWindowPosition() {
  if (!UI || !UI.window || UI.selfTest) return;
  var f = UI.window.frame;
  var tl = { x: Math.round(Number(f.origin.x)), y: Math.round(Number(f.origin.y) + Number(f.size.height)) };
  if (UI.cfg.windowTopLeft && UI.cfg.windowTopLeft.x === tl.x && UI.cfg.windowTopLeft.y === tl.y) return;
  UI.cfg.windowTopLeft = tl;
  uiSaveConfig();
}

// A worker that crashed long ago can leave its job file behind. With nothing
// playing, job files older than STALE_JOB_SECONDS are removed.
function uiCleanupStaleJobs() {
  try {
    if (getPlaybackStatus(UI.supportDir).active) return;
    var fm = $.NSFileManager.defaultManager;
    var names = fm.contentsOfDirectoryAtPathError($(UI.supportDir), null);
    if (!names || names.isNil()) return;
    var now = nowSeconds();
    var removed = 0;
    for (var i = 0; i < Number(names.count); i++) {
      var name = String(unwrapMaybe(names.objectAtIndex(i)) || "");
      if (name.indexOf(PLAYBACK_JOB_PREFIX) !== 0 || name.slice(-5) !== ".json") continue;
      var path = UI.supportDir + "/" + name;
      var attrs = fm.attributesOfItemAtPathError($(path), null);
      if (!attrs || attrs.isNil()) continue;
      var modified = Number(attrs.fileModificationDate.timeIntervalSince1970);
      if (isFinite(modified) && now - modified > STALE_JOB_SECONDS) {
        removeFileIfExists(path);
        removed++;
      }
    }
    if (removed > 0) appendPlaybackLog(UI.supportDir, "Removed " + removed + " leftover playback job file" + (removed === 1 ? "" : "s") + ".");
  } catch (_) {
    // Housekeeping only.
  }
}

function uiInstallDockIcon() {
  try {
    var main = currentMainScriptPath();
    if (!main) return;
    var dir = main.slice(0, main.lastIndexOf("/"));
    var icns = dir + "/AppIcon.icns";
    if (!$.NSFileManager.defaultManager.fileExistsAtPath($(icns))) return;
    var img = $.NSImage.alloc.initWithContentsOfFile($(icns));
    if (img && !img.isNil()) UI.nsApp.setApplicationIconImage(img);
  } catch (_) {
    // The Dock icon is cosmetic.
  }
}

// --- Menu bar ----------------------------------------------------------------
function uiMenuItem(title, selector, key, tag) {
  var item = $.NSMenuItem.alloc.initWithTitleActionKeyEquivalent($(String(title)), selector, $(String(key || "")));
  if (tag) {
    item.setTarget(UI.controller);
    item.setTag(tag);
  }
  return item;
}

function uiBuildMenu() {
  var menubar = $.NSMenu.alloc.init;

  var appItem = $.NSMenuItem.alloc.init;
  menubar.addItem(appItem);
  var appMenu = $.NSMenu.alloc.init;
  appMenu.addItem(uiMenuItem(T("menuAbout"), 'uiAction:', "", UI_TAG.about));
  appMenu.addItem($.NSMenuItem.separatorItem);
  appMenu.addItem(uiMenuItem(T("menuQuit"), 'terminate:', "q"));
  appItem.setSubmenu(appMenu);

  var fileItem = $.NSMenuItem.alloc.init;
  menubar.addItem(fileItem);
  var fileMenu = $.NSMenu.alloc.initWithTitle($(T("menuFile")));
  fileMenu.addItem(uiMenuItem(T("menuOpen"), 'uiAction:', "o", UI_TAG.chooseMidi));
  if (demoSongPath(0)) {
    var demoItem = $.NSMenuItem.alloc.init;
    demoItem.setTitle($(T("menuDemos")));
    var demoMenu = $.NSMenu.alloc.initWithTitle($(T("menuDemos")));
    for (var d = 0; d < DEMO_SONGS.length; d++) {
      demoMenu.addItem(uiMenuItem(demoSongTitle(d), 'uiAction:', "", UI_TAG.demoBase + d));
    }
    demoItem.setSubmenu(demoMenu);
    fileMenu.addItem(demoItem);
  }
  fileMenu.addItem($.NSMenuItem.separatorItem);
  fileMenu.addItem(uiMenuItem(T("menuClose"), 'performClose:', "w"));
  fileItem.setSubmenu(fileMenu);

  var editItem = $.NSMenuItem.alloc.init;
  menubar.addItem(editItem);
  var editMenu = $.NSMenu.alloc.initWithTitle($(T("menuEdit")));
  editMenu.addItem(uiMenuItem(T("menuUndo"), 'undo:', "z"));
  editMenu.addItem(uiMenuItem(T("menuRedo"), 'redo:', "Z"));
  editMenu.addItem($.NSMenuItem.separatorItem);
  editMenu.addItem(uiMenuItem(T("menuCut"), 'cut:', "x"));
  editMenu.addItem(uiMenuItem(T("menuCopy"), 'copy:', "c"));
  editMenu.addItem(uiMenuItem(T("menuPaste"), 'paste:', "v"));
  editMenu.addItem(uiMenuItem(T("menuSelectAll"), 'selectAll:', "a"));
  editItem.setSubmenu(editMenu);

  var playbackItem = $.NSMenuItem.alloc.init;
  menubar.addItem(playbackItem);
  var playbackMenu = $.NSMenu.alloc.initWithTitle($(T("menuPlayback")));
  playbackMenu.addItem(uiMenuItem(T("menuPause"), 'uiAction:', "p", UI_TAG.pause));
  playbackMenu.addItem(uiMenuItem(T("menuStop"), 'uiAction:', ".", UI_TAG.stop));
  playbackMenu.addItem($.NSMenuItem.separatorItem);
  playbackMenu.addItem(uiMenuItem(T("menuFaster"), 'uiAction:', "=", UI_TAG.faster));
  playbackMenu.addItem(uiMenuItem(T("menuSlower"), 'uiAction:', "-", UI_TAG.slower));
  playbackMenu.addItem(uiMenuItem(T("menuNormalSpeed"), 'uiAction:', "0", UI_TAG.normalSpeed));
  playbackMenu.addItem($.NSMenuItem.separatorItem);
  UI.menuLiveKeys = uiMenuItem(T("menuLiveKeys"), 'uiAction:', "l", UI_TAG.liveKeys);
  UI.menuLiveKeys.setState(UI.cfg.liveKeys ? 1 : 0);
  playbackMenu.addItem(UI.menuLiveKeys);
  playbackItem.setSubmenu(playbackMenu);

  var windowItem = $.NSMenuItem.alloc.init;
  menubar.addItem(windowItem);
  var windowMenu = $.NSMenu.alloc.initWithTitle($(T("menuWindow")));
  windowMenu.addItem(uiMenuItem(T("menuMinimize"), 'performMiniaturize:', "m"));
  windowItem.setSubmenu(windowMenu);

  // Help opens the documentation on GitHub (the only network use, and only on request).
  var helpItem = $.NSMenuItem.alloc.init;
  menubar.addItem(helpItem);
  var helpMenu = $.NSMenu.alloc.initWithTitle($(T("menuHelp")));
  helpMenu.addItem(uiMenuItem(T("menuManual"), 'uiAction:', "?", UI_TAG.helpManual));
  helpMenu.addItem(uiMenuItem(T("menuGettingStarted"), 'uiAction:', "", UI_TAG.helpStart));
  helpMenu.addItem(uiMenuItem(T("menuTroubleshooting"), 'uiAction:', "", UI_TAG.helpTrouble));
  helpMenu.addItem($.NSMenuItem.separatorItem);
  helpMenu.addItem(uiMenuItem(T("menuReportIssue"), 'uiAction:', "", UI_TAG.helpIssue));
  helpItem.setSubmenu(helpMenu);

  UI.nsApp.setMainMenu(menubar);
  try { UI.nsApp.setWindowsMenu(windowMenu); } catch (_) {}
  try { UI.nsApp.setHelpMenu(helpMenu); } catch (_) {}
}

// Where a bundled demo song is, or "" when it is missing (running from source).
function demoSongPath(index) {
  var song = DEMO_SONGS[index];
  var main = currentMainScriptPath();
  if (!song || !main) return "";
  var path = main.slice(0, main.lastIndexOf("/")) + "/demo/" + song.file;
  return $.NSFileManager.defaultManager.fileExistsAtPath($(path)) ? path : "";
}

function demoSongTitle(index) {
  var song = DEMO_SONGS[index];
  return uiEffectiveLanguage() === "fr" ? song.fr : song.en;
}

function uiOpenURL(url) {
  app.doShellScript('/usr/bin/open ' + shellQuote(url));
}

// --- Widget factories ----------------------------------------------------------
function uiMakeLabel(opts) {
  opts = opts || {};
  var f = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, 0, 10, 10));
  f.setStringValue($(""));
  f.setBezeled(false);
  f.setDrawsBackground(false);
  f.setEditable(false);
  f.setSelectable(!!opts.selectable);
  var size = opts.size || 13;
  if (opts.bold) f.setFont($.NSFont.boldSystemFontOfSize(size));
  else if (opts.mono) f.setFont($.NSFont.monospacedDigitSystemFontOfSizeWeight(size, 0));
  else f.setFont($.NSFont.systemFontOfSize(size));
  if (opts.secondary) f.setTextColor($.NSColor.secondaryLabelColor);
  if (opts.color) f.setTextColor(opts.color);
  if (opts.align === "right") f.setAlignment($.NSTextAlignmentRight);
  if (opts.align === "center") f.setAlignment($.NSTextAlignmentCenter);
  if (opts.wrap) {
    f.cell.setWraps(true);
    f.cell.setUsesSingleLineMode(false);
    f.setLineBreakMode($.NSLineBreakByWordWrapping);
  } else {
    f.setLineBreakMode($.NSLineBreakByTruncatingTail);
  }
  return f;
}

function uiMakeButton(tag, opts) {
  opts = opts || {};
  var b = $.NSButton.alloc.initWithFrame($.NSMakeRect(0, 0, 10, 10));
  b.setTitle($(""));
  b.setBezelStyle($.NSBezelStyleRounded);
  if (opts.checkbox) b.setButtonType($.NSButtonTypeSwitch);
  b.setTarget(UI.controller);
  b.setAction('uiAction:');
  b.setTag(tag);
  if (opts.isDefault) b.setKeyEquivalent($("\r"));
  return b;
}

function uiMakePopup(tag) {
  var p = $.NSPopUpButton.alloc.initWithFramePullsDown($.NSMakeRect(0, 0, 10, 10), false);
  p.setTarget(UI.controller);
  p.setAction('uiAction:');
  p.setTag(tag);
  return p;
}

function uiSetPopupItems(popup, titles, selectedIndex) {
  popup.removeAllItems;
  popup.addItemsWithTitles($(titles));
  var idx = clamp(Math.round(Number(selectedIndex) || 0), 0, Math.max(0, titles.length - 1));
  popup.selectItemAtIndex(idx);
}

function uiMakeField(tag) {
  var f = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, 0, 10, 10));
  f.setStringValue($(""));
  f.setTarget(UI.controller);
  f.setAction('uiAction:');
  f.setTag(tag);
  f.cell.setSendsActionOnEndEditing(true);
  f.setAlignment($.NSTextAlignmentCenter);
  return f;
}

function uiMakeSeparator() {
  var box = $.NSBox.alloc.initWithFrame($.NSMakeRect(0, 0, 10, 1));
  box.setBoxType($.NSBoxSeparator);
  return box;
}

function uiMakeCard() {
  var box = $.NSBox.alloc.initWithFrame($.NSMakeRect(0, 0, 10, 10));
  box.setBoxType($.NSBoxCustom);
  box.setTitlePosition($.NSNoTitle);
  box.setBorderWidth(1);
  box.setCornerRadius(10);
  box.setBorderColor($.NSColor.separatorColor);
  box.setFillColor($.NSColor.colorWithCalibratedWhiteAlpha(0.5, 0.07));
  box.setContentViewMargins($.NSMakeSize(0, 0));
  return box;
}

function uiMakeProgress() {
  var p = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(0, 0, 10, 10));
  p.setStyle($.NSProgressIndicatorStyleBar);
  p.setIndeterminate(false);
  p.setMinValue(0);
  p.setMaxValue(1);
  p.setDoubleValue(0);
  p.setHidden(true);
  return p;
}

function uiMakeSegmented() {
  var seg = $.NSSegmentedControl.alloc.initWithFrame($.NSMakeRect(0, 0, 10, 10));
  seg.setSegmentCount(2);
  try { seg.setSegmentDistribution($.NSSegmentDistributionFillEqually); } catch (_) {}
  seg.setTarget(UI.controller);
  seg.setAction('uiAction:');
  seg.setTag(UI_TAG.mode);
  return seg;
}

function uiMakeSlider(tag, min, max) {
  var s = $.NSSlider.alloc.initWithFrame($.NSMakeRect(0, 0, 10, 10));
  s.setMinValue(min);
  s.setMaxValue(max);
  s.setContinuous(true);
  s.setTarget(UI.controller);
  s.setAction('uiAction:');
  s.setTag(tag);
  return s;
}

function uiMakeImageView(viewClass) {
  var v = (viewClass || $.NSImageView).alloc.initWithFrame($.NSMakeRect(0, 0, 10, 10));
  v.setImageScaling($.NSImageScaleNone);
  v.setImageFrameStyle($.NSImageFrameNone);
  return v;
}

// [ − | 1.00× | + ]: momentary segments. The middle one shows the speed and
// puts it back to 1× when clicked.
function uiMakeSpeedButtons() {
  var seg = $.NSSegmentedControl.alloc.initWithFrame($.NSMakeRect(0, 0, 10, 10));
  seg.setSegmentCount(3);
  try { seg.setTrackingMode($.NSSegmentSwitchTrackingMomentary); } catch (_) { seg.setTrackingMode(2); }
  seg.setWidthForSegment(34, 0);
  seg.setWidthForSegment(62, 1);
  seg.setWidthForSegment(34, 2);
  seg.setLabelForSegment($("−"), 0);
  seg.setLabelForSegment($("+"), 2);
  try { seg.setFont($.NSFont.monospacedDigitSystemFontOfSizeWeight(13, 0)); } catch (_) {}
  seg.setTarget(UI.controller);
  seg.setAction('uiAction:');
  seg.setTag(UI_TAG.speedButtons);
  return seg;
}

// --- Window layout -------------------------------------------------------------
function uiBuildWindow() {
  var w = UI.w;
  var pending = [];
  function add(view, x, yTop, width, height) {
    pending.push({ v: view, x: x, y: yTop, w: width, h: height });
    return view;
  }

  var M = UI_MARGIN;
  var CW = UI_CONTENT_WIDTH;
  var R = UI_WIDTH - M;
  var y = 16;

  // Title row, with the utility buttons and the language menu on the right.
  w.title = add(uiMakeLabel({ bold: true, size: 20 }), M, y, 380, 26);
  w.language = add(uiMakePopup(UI_TAG.language), R - 130, y + 2, 130, 26);
  w.about = add(uiMakeButton(UI_TAG.about), R - 130 - 6 - 92, y, 92, 30);
  w.openFolder = add(uiMakeButton(UI_TAG.openFolder), R - 130 - 6 - 92 - 6 - 140, y, 140, 30);
  w.openLog = add(uiMakeButton(UI_TAG.openLog), R - 130 - 6 - 92 - 6 - 140 - 6 - 100, y, 100, 30);
  y += 28;
  w.subtitle = add(uiMakeLabel({ secondary: true, size: 12 }), M, y, 720, 18);
  y += 28;

  // Status card: what is happening on the left; the speed (− 1.00× +), Pause
  // and Stop on the right. The speed works before and during playback.
  var cardH = 78;
  var rightW = 352;
  var rx = R - 14 - rightW;
  var textW = rx - (M + 36) - 12;
  w.card = add(uiMakeCard(), M, y, CW, cardH);
  w.statusDot = add(uiMakeLabel({ size: 15 }), M + 14, y + 12, 20, 22);
  w.statusText = add(uiMakeLabel({ bold: true, size: 13 }), M + 36, y + 13, textW, 20);
  w.statusDetail = add(uiMakeLabel({ secondary: true, size: 11 }), M + 36, y + 35, textW, 16);
  w.progress = add(uiMakeProgress(), M + 37, y + 57, textW - 1, 12);
  w.speedCaption = add(uiMakeLabel({ secondary: true, size: 10, align: "center" }), rx, y + 9, 134, 14);
  w.speedButtons = add(uiMakeSpeedButtons(), rx, y + 26, 134, 28);
  w.pause = add(uiMakeButton(UI_TAG.pause), rx + 134 + 12, y + 24, 100, 32);
  w.access = add(uiMakeButton(UI_TAG.access), rx + 134 + 12, y + 24, 100, 32);
  w.stop = add(uiMakeButton(UI_TAG.stop), rx + 134 + 12 + 100 + 6, y + 24, 100, 32);
  y += cardH + 16;

  // 1 · Song.
  w.sectionSong = add(uiMakeLabel({ bold: true, size: 11, secondary: true }), M, y, 500, 16);
  y += 18;
  add(uiMakeSeparator(), M, y, CW, 1);
  y += 9;
  w.chooseMidi = add(uiMakeButton(UI_TAG.chooseMidi), M - 6, y, 220, 32);
  w.dropHint = add(uiMakeLabel({ secondary: true, size: 11 }), M + 220, y + 8, 340, 16);
  w.transposeLabel = add(uiMakeLabel({ secondary: true, size: 12, align: "right" }), R - 344, y + 7, 200, 18);
  w.transpose = add(uiMakePopup(UI_TAG.transpose), R - 140, y + 3, 140, 26);
  y += 38;
  w.songName = add(uiMakeLabel({ bold: true, size: 13 }), M, y, CW, 20);
  y += 21;
  w.songInfo = add(uiMakeLabel({ secondary: true, size: 12 }), M, y, CW, 18);
  y += 26;

  // 2 · Roblox piano.
  w.sectionPiano = add(uiMakeLabel({ bold: true, size: 11, secondary: true }), M, y, 500, 16);
  y += 18;
  add(uiMakeSeparator(), M, y, CW, 1);
  y += 9;
  w.mode = add(uiMakeSegmented(), M, y, CW, 30);
  y += 35;
  w.modeHelp = add(uiMakeLabel({ secondary: true, size: 11 }), M, y, CW, 16);
  y += 20;
  w.keyboard = add(uiMakeImageView($.RMPPPianoView), M, y, CW, UI_KEYBOARD_HEIGHT);
  y += UI_KEYBOARD_HEIGHT + 7;
  w.coverage = add(uiMakeLabel({ bold: true, size: 12 }), M, y, CW, 18);
  y += 19;
  w.legend = add(uiMakeLabel({ secondary: true, size: 10 }), M, y, CW, 14);
  y += 20;
  w.liveKeys = add(uiMakeButton(UI_TAG.liveKeys, { checkbox: true }), M - 2, y, 560, 20);
  w.liveStatus = add(uiMakeLabel({ size: 11, align: "right" }), R - 300, y + 2, 300, 16);
  y += 28;

  // 3 · Settings.
  w.sectionSettings = add(uiMakeLabel({ bold: true, size: 11, secondary: true }), M, y, 600, 16);
  y += 18;
  add(uiMakeSeparator(), M, y, CW, 1);
  y += 10;
  var rowH = 33;
  var labelW = 170;
  var ctlX = M + labelW + 8;
  var ctlW = 268;
  var l2 = 486;
  var l2W = 150;
  var c2 = l2 + l2W + 8;   // 644
  var c2W = R - c2;        // 252

  // Row 1: keyboard layout / speed.
  w.layoutLabel = add(uiMakeLabel({ secondary: true, size: 12, align: "right" }), M, y + 6, labelW, 18);
  w.layout = add(uiMakePopup(UI_TAG.layout), ctlX, y + 2, ctlW, 26);
  w.speedLabel = add(uiMakeLabel({ secondary: true, size: 12, align: "right" }), l2, y + 6, l2W, 18);
  w.speed = add(uiMakeSlider(UI_TAG.speed, 0.25, 2.0), c2, y + 3, c2W - 60, 22);
  w.speedValue = add(uiMakeLabel({ mono: true, size: 12, align: "right" }), R - 56, y + 6, 56, 18);
  y += rowH;

  // Row 2: note mapping / delay.
  w.precisionLabel = add(uiMakeLabel({ secondary: true, size: 12, align: "right" }), M, y + 6, labelW, 18);
  w.precision = add(uiMakePopup(UI_TAG.precision), ctlX, y + 2, ctlW, 26);
  w.delayLabel = add(uiMakeLabel({ secondary: true, size: 12, align: "right" }), l2, y + 6, l2W, 18);
  w.delay = add(uiMakeField(UI_TAG.delay), c2, y + 2, 68, 24);
  w.delayUnit = add(uiMakeLabel({ secondary: true, size: 12 }), c2 + 76, y + 6, 120, 18);
  y += rowH;

  // Row 3: key sending / note of key 1.
  w.sendingLabel = add(uiMakeLabel({ secondary: true, size: 12, align: "right" }), M, y + 6, labelW, 18);
  w.sending = add(uiMakePopup(UI_TAG.sending), ctlX, y + 2, ctlW, 26);
  w.baseLabel = add(uiMakeLabel({ secondary: true, size: 12, align: "right" }), l2, y + 6, l2W, 18);
  w.base = add(uiMakeField(UI_TAG.base), c2, y + 2, 68, 24);
  w.baseInfo = add(uiMakeLabel({ secondary: true, size: 11 }), c2 + 76, y + 6, 66, 18);
  w.resetBase = add(uiMakeButton(UI_TAG.resetBase), c2 + 138, y, c2W - 138, 28);
  y += rowH;

  // Row 4: extended modifier / live log.
  w.modifierLabel = add(uiMakeLabel({ secondary: true, size: 12, align: "right" }), M, y + 6, labelW, 18);
  w.modifier = add(uiMakePopup(UI_TAG.modifier), ctlX, y + 2, ctlW, 26);
  w.liveLog = add(uiMakeButton(UI_TAG.liveLog, { checkbox: true }), c2, y + 4, c2W, 22);
  y += rowH + 8;

  // Actions.
  w.arm = add(uiMakeButton(UI_TAG.arm, { isDefault: true }), M - 6, y, 230, 36);
  w.armHelp = add(uiMakeLabel({ secondary: true, size: 11, wrap: true }), M + 232, y + 1, CW - 232, 34);
  y += 36 + M;

  var H = y;
  var mask = $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskClosable | $.NSWindowStyleMaskMiniaturizable;
  var win = $.RMPPWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, UI_WIDTH, H), mask, $.NSBackingStoreBuffered, false);
  win.setTitle($(APP_NAME));
  win.setReleasedWhenClosed(false);
  win.setDelegate(UI.controller);
  var root = $.RMPPDropView.alloc.initWithFrame($.NSMakeRect(0, 0, UI_WIDTH, H));
  try { root.registerForDraggedTypes($([$.NSPasteboardTypeFileURL, $("NSFilenamesPboardType")])); } catch (_) {}
  win.setContentView(root);
  for (var i = 0; i < pending.length; i++) {
    var p = pending[i];
    p.v.setFrame($.NSMakeRect(p.x, H - p.y - p.h, p.w, p.h));
    root.addSubview(p.v);
  }
  UI.window = win;
  UI.root = root;
  UI.windowHeight = H;
}

// --- Strings / static state ----------------------------------------------------
function uiApplyStrings() {
  var w = UI.w;
  var cfg = UI.cfg;
  var mod = modifierDisplayName(cfg);
  w.title.setStringValue($(APP_NAME + "  ·  v" + APP_VERSION));
  w.subtitle.setStringValue($(T("subtitle")));
  uiSetPopupItems(w.language, [T("langEnglish"), T("langFrench")], uiEffectiveLanguage() === "fr" ? 1 : 0);
  w.sectionSong.setStringValue($(T("sectionSong")));
  w.chooseMidi.setTitle($(T("chooseMidi")));
  w.dropHint.setStringValue($(T("dropHint")));
  w.transposeLabel.setStringValue($(T("transposeLabel")));
  var transposeTitles = [];
  for (var t = -12; t <= 12; t++) {
    transposeTitles.push(t === 0 ? T("transposeNone") : T("transposeItem", { sign: t > 0 ? "+" : "−", n: Math.abs(t) }));
  }
  uiSetPopupItems(w.transpose, transposeTitles, UI.transpose + 12);
  w.sectionPiano.setStringValue($(T("sectionPiano")));
  w.mode.setLabelForSegment($(T("mode1")), 0);
  w.mode.setLabelForSegment($(T("mode2")), 1);
  w.mode.setSelectedSegment(normalizeKeyboardMode(cfg.keyboardMode) === "extended" ? 1 : 0);
  // The dotted keys as they are labelled on this keyboard layout (1 … t, or & … t on AZERTY).
  var isAzerty = normalizeKeyboardProfile(cfg.keyboardProfile) === "azerty";
  var lowLabels = isAzerty ? AZERTY_EXTENDED_LOW_LABELS : US_EXTENDED_LOW_LABELS;
  var highLabels = isAzerty ? AZERTY_EXTENDED_HIGH_LABELS : US_EXTENDED_HIGH_LABELS;
  w.modeHelp.setStringValue($(normalizeKeyboardMode(cfg.keyboardMode) === "extended"
    ? T("mode2Help", { mod: mod, low: lowLabels[0] + " … " + lowLabels[lowLabels.length - 1], high: highLabels[0] + " … " + highLabels[highLabels.length - 1] })
    : T("mode1Help")));
  w.legend.setStringValue($(T("legend", { mod: mod })));
  w.sectionSettings.setStringValue($(T("sectionSettings")));
  w.layoutLabel.setStringValue($(T("layoutLabel")));
  var profileId = normalizeKeyboardProfile(cfg.keyboardProfile);
  uiSetPopupItems(w.layout, [T("layoutUs"), T("layoutFr"), T("layoutCustom")], profileId === "azerty" ? 1 : (profileId === "custom" ? 2 : 0));
  w.precisionLabel.setStringValue($(T("precisionLabel")));
  uiSetPopupItems(w.precision, [T("precisionPerfect"), T("precisionSmart")], normalizeNoteRecognitionMode(cfg.noteRecognitionMode) === "smart" ? 1 : 0);
  w.precision.setToolTip($(T("precisionHelp")));
  w.sendingLabel.setStringValue($(T("sendingLabel")));
  var send = normalizeKeySendMethod(cfg.keySendMethod);
  uiSetPopupItems(w.sending, [T("sendAuto"), T("sendQuartz"), T("sendAx")], send === "quartz" ? 1 : (send === "accessibility" ? 2 : 0));
  w.sending.setToolTip($(T("sendingHelp")));
  w.modifierLabel.setStringValue($(T("modifierLabel")));
  uiSetPopupItems(w.modifier, [T("modCtrl"), T("modAlt")], normalizeExtendedModifier(cfg.extendedModifier) === "alt" ? 1 : 0);
  w.speedLabel.setStringValue($(T("speedLabel")));
  w.delayLabel.setStringValue($(T("delayLabel")));
  w.delay.setStringValue($(trimFloat(cfg.startDelaySeconds)));
  w.delayUnit.setStringValue($(T("delayUnit")));
  w.baseLabel.setStringValue($(T("baseLabel")));
  w.base.setStringValue($(noteName(cfg.baseMIDINote)));
  w.baseInfo.setStringValue($(T("baseInfo", { n: cfg.baseMIDINote })));
  w.resetBase.setTitle($(T("resetBase")));
  w.liveLog.setTitle($(T("liveLog")));
  w.liveLog.setState(cfg.openLiveLogWindow ? 1 : 0);
  w.liveKeys.setTitle($(T("liveKeys")));
  w.liveKeys.setState(cfg.liveKeys ? 1 : 0);
  w.arm.setTitle($(T("arm")));
  w.armHelp.setStringValue($(T("armHelp")));
  w.stop.setTitle($(T("stop")));
  w.speedCaption.setStringValue($(T("speedCaption")));
  w.access.setTitle($(T("accessButton")));
  uiShowSpeed();
  uiUpdatePauseButton();
  w.openLog.setTitle($(T("openLog")));
  w.openFolder.setTitle($(T("openFolder")));
  w.about.setTitle($(T("about")));
}

// --- Song model ----------------------------------------------------------------
function uiChooseMidiPath() {
  var panel = $.NSOpenPanel.openPanel;
  panel.setCanChooseFiles(true);
  panel.setCanChooseDirectories(false);
  panel.setAllowsMultipleSelection(false);
  panel.setAllowedFileTypes($(["mid", "midi", "smf"]));
  panel.setMessage($(T("chooseMidiPrompt")));
  panel.setPrompt($(T("openButton")));
  if (Number(panel.runModal) !== 1) return "";
  var urls = panel.URLs;
  if (!urls || Number(urls.count) < 1) return "";
  return String(unwrapMaybe(urls.objectAtIndex(0).path) || "");
}

// `displayName` replaces the file name in the window and the notifications;
// `demoIndex` marks a demo song, whose title follows the window's language.
function uiLoadSong(path, displayName, demoIndex) {
  path = String(path || "");
  if (!path) return;
  var parsed;
  try {
    parsed = parseMIDIFile(path);
  } catch (e) {
    var msg = messageOf(e);
    if (msg.indexOf("SMPTE") >= 0) throw new Error(T("errMidiTiming"));
    throw new Error(basename(path) + "\n\n" + msg);
  }
  if (parsed.division <= 0) throw new Error(T("errMidiTiming"));
  if (parsed.notes.length === 0) throw new Error(T("errMidiEmpty"));
  UI.transpose = 0;
  uiSetPopupItems(UI.w.transpose, uiPopupTitles(UI.w.transpose), 12);
  UI.song = { path: path, name: displayName ? String(displayName) : basename(path), parsed: parsed, demoIndex: demoIndex };
  uiRefreshSong();
  try { appendPlaybackLog(UI.supportDir, "Window: loaded " + basename(path) + " (" + parsed.notes.length + " notes)."); } catch (_) {}
}

function uiPopupTitles(popup) {
  var out = [];
  try {
    var n = Number(popup.numberOfItems);
    for (var i = 0; i < n; i++) out.push(String(unwrapMaybe(popup.itemTitleAtIndex(i))));
  } catch (_) {}
  return out;
}

// Effective config for the piano currently selected. In Mode 2 the note of
// key 1 must leave room for the 15 keys below it.
function uiEffectiveConfig(cfg, mode) {
  var out = clone(cfg);
  out.keyboardMode = normalizeKeyboardMode(mode == null ? cfg.keyboardMode : mode);
  if (out.keyboardMode === "extended" && out.baseMIDINote < EXTENDED_LOW_COUNT) out.baseMIDINote = EXTENDED_LOW_COUNT;
  return out;
}

function uiComputeFit(parsed, cfg, mode, transpose) {
  var effective = uiEffectiveConfig(cfg, mode);
  var profile = resolveKeyboardProfile(effective);
  var analysis = analyzeNotes(parsed.notes, profile, effective.baseMIDINote, effective.noteRecognitionMode);
  var runBase = analysis.detectedBase - Math.round(Number(transpose) || 0);
  var playbackCfg = clone(effective);
  playbackCfg.baseMIDINote = runBase;
  playbackCfg.savedBaseMIDINote = analysis.savedBase;
  playbackCfg.noteRecognitionMode = analysis.noteRecognitionMode;
  playbackCfg.keyboardProfile = profile.id;
  playbackCfg.keyLayout = profile.layoutString;
  var built = buildSchedule(parsed.notes, parsed.tempos, parsed.division, playbackCfg, profile);
  return { profile: profile, analysis: analysis, runBase: runBase, playbackCfg: playbackCfg, built: built };
}

function uiRecomputeSong() {
  if (!UI.song) return;
  var cfg = UI.cfg;
  var fit = uiComputeFit(UI.song.parsed, cfg, cfg.keyboardMode, UI.transpose);
  UI.song.fit = fit;
  UI.song.alt = null;
  if (fit.profile.builtIn) {
    var otherMode = normalizeKeyboardMode(cfg.keyboardMode) === "extended" ? "classic" : "extended";
    try { UI.song.alt = uiComputeFit(UI.song.parsed, cfg, otherMode, UI.transpose); } catch (_) { UI.song.alt = null; }
  }
}

function uiRefreshSong() {
  uiRecomputeSong();
  uiRenderSongInfo();
  uiRenderKeyboard();
  uiRenderCoverage();
  uiUpdateButtons();
}

function uiRenderSongInfo() {
  var w = UI.w;
  if (!UI.song) {
    w.songName.setStringValue($(T("noSong")));
    w.songInfo.setStringValue($(T("noSongInfo")));
    return;
  }
  var fit = UI.song.fit;
  // The schedule was built at fit's speed; the length at the current speed
  // follows from it without rebuilding (the slider can move many times).
  var builtSpeed = fit.playbackCfg.speed > 0 ? fit.playbackCfg.speed : 1;
  var length = scheduleLengthSeconds(fit.built.schedule) * builtSpeed / UI.cfg.speed;
  w.songName.setStringValue($(UI.song.name));
  var drums = UI.song.parsed.drumNotes > 0 ? T("songInfoDrums", { n: UI.song.parsed.drumNotes }) : "";
  w.songInfo.setStringValue($(T("songInfo", {
    notes: fit.analysis.totalNotes,
    span: noteName(fit.analysis.minNote) + " → " + noteName(fit.analysis.maxNote),
    duration: formatClock(length),
    speed: Number(UI.cfg.speed).toFixed(2),
    delay: formatNumber(UI.cfg.startDelaySeconds, 2)
  }) + drums));
}

function uiRenderCoverage() {
  var w = UI.w;
  if (!UI.song) {
    w.coverage.setStringValue($(T("coverageNone")));
    w.coverage.setTextColor($.NSColor.secondaryLabelColor);
    return;
  }
  var fit = UI.song.fit;
  var built = fit.built;
  var total = fit.analysis.totalNotes;
  var pct = total > 0 ? (built.mapped * 100.0 / total) : 0;
  var text = T("coverage", { mapped: built.mapped, total: total, pct: formatNumber(pct, 1) });
  if (built.skipped > 0) {
    text += T("coverageSkipped", { low: built.skippedLow, high: built.skippedHigh });
  }
  var extended = normalizeKeyboardMode(UI.cfg.keyboardMode) === "extended";
  if (UI.song.alt) {
    var altMapped = UI.song.alt.built.mapped;
    if (!extended && altMapped > built.mapped) text += T("coverageMode2Gain", { gain: altMapped - built.mapped });
    else if (extended && altMapped < built.mapped) text += T("coverageMode1Loss", { loss: built.mapped - altMapped });
    else if (extended && altMapped === built.mapped) text += T("coverageMode1Same");
  }
  w.coverage.setStringValue($(text));
  w.coverage.setTextColor(built.skipped === 0 ? $.NSColor.systemGreenColor : (pct >= 90 ? $.NSColor.labelColor : $.NSColor.systemOrangeColor));
}

function uiUpdateButtons() {
  var w = UI.w;
  var active = !!(UI.playback && UI.playback.active);
  w.arm.setEnabled(!!UI.song && !active && !UI.busy);
  w.stop.setEnabled(active);
  w.mode.setEnabled(!UI.busy);
  w.transpose.setEnabled(!!UI.song);
  uiUpdatePauseButton();
}

// Pause is only offered once the song is really playing. In its place, the
// "Allow…" button appears while macOS has not granted Accessibility yet and
// nothing is playing.
function uiUpdatePauseButton() {
  var w = UI.w;
  if (!w.pause) return;
  var st = UI.playback && UI.playback.state ? UI.playback.state : {};
  var active = !!(UI.playback && UI.playback.active);
  var playing = active && String(st.status || "") === "playing";
  var showAccess = !active && UI.trusted === false;
  w.access.setHidden(!showAccess);
  w.pause.setHidden(showAccess);
  w.pause.setTitle($(UI.paused && active ? T("resume") : T("pause")));
  w.pause.setEnabled(playing || (active && UI.paused));
}

// Shows the speed everywhere it appears: the − 1.00× + buttons and the slider.
function uiShowSpeed() {
  var w = UI.w;
  var text = formatSpeed(UI.cfg.speed);
  w.speedButtons.setLabelForSegment($(text), 1);
  w.speed.setDoubleValue(UI.cfg.speed);
  w.speedValue.setStringValue($(text));
}

function formatSpeed(speed) {
  return Number(speed).toFixed(2) + "×";
}

// --- Piano picture -------------------------------------------------------------
// The picture always shows all 88 keys of the extended piano for the current
// layout, so switching modes only changes which zones are lit. A key is green
// when the song uses it, orange when the song uses it but the key is off in
// the current mode (those notes are skipped), and dimmed when off.
function uiKeyboardModel() {
  var cfg = UI.cfg;
  var extended = normalizeKeyboardMode(cfg.keyboardMode) === "extended";
  var effective = uiEffectiveConfig(cfg, "extended");
  var full = resolveKeyboardProfile(effective);
  if (!full.builtIn) return null;
  var savedBase = UI.song && UI.song.fit ? UI.song.fit.analysis.savedBase : effective.baseMIDINote;
  var runBase = UI.song && UI.song.fit ? UI.song.fit.runBase : effective.baseMIDINote;
  if (savedBase < EXTENDED_LOW_COUNT) savedBase = EXTENDED_LOW_COUNT;
  var counts = UI.song && UI.song.fit ? UI.song.fit.analysis.counts : null;
  var keys = [];
  for (var i = 0; i < full.steps.length; i++) {
    var st = full.steps[i];
    var active = extended || st.zone === "main";
    var sourceNote = runBase - EXTENDED_LOW_COUNT + i;   // the MIDI note that lands on this key
    var used = (counts && sourceNote >= 0 && sourceNote < 128) ? counts[sourceNote] : 0;
    keys.push({
      label: st.label,
      code: st.code,
      shift: !!st.shift,
      isBlack: !!st.isBlack,
      ctrl: !!st.ctrl,
      zone: st.zone,
      active: active,
      used: used,
      midi: savedBase - EXTENDED_LOW_COUNT + i
    });
  }
  var built = UI.song && UI.song.fit ? UI.song.fit.built : null;
  return {
    keys: keys,
    extended: extended,
    mod: modifierDisplayName(cfg),
    skippedLow: built ? built.skippedLow : 0,
    skippedHigh: built ? built.skippedHigh : 0
  };
}

function uiRenderKeyboard() {
  var model = uiKeyboardModel();
  var img;
  // A new picture means new key positions: let go of anything held on the old one.
  liveReleaseMouseKey();
  uiClearKeyHighlights();
  if (!model) {
    UI.kb = null;
    img = renderPianoPlaceholder(UI_CONTENT_WIDTH, UI_KEYBOARD_HEIGHT, T("kbCustom", { n: resolveKeyboardProfile(UI.cfg).steps.length }));
  } else {
    img = renderPianoPicture(model, UI_CONTENT_WIDTH, UI_KEYBOARD_HEIGHT);
    UI.kb = { model: model, geometry: model.geometry };
  }
  UI.w.keyboard.setImage(img);
  uiComputeLiveCodes();
}

function pictureBegin(W, H) {
  var scale = 2;
  var rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, W * scale, H * scale, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0);
  rep.setSize($.NSMakeSize(W, H));
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  return rep;
}

function pictureEnd(rep, W, H) {
  $.NSGraphicsContext.restoreGraphicsState;
  var img = $.NSImage.alloc.initWithSize($.NSMakeSize(W, H));
  img.addRepresentation(rep);
  return img;
}

function pictureColor(r, g, b, a) {
  return $.NSColor.colorWithCalibratedRedGreenBlueAlpha(r, g, b, a == null ? 1 : a);
}

function pictureText(text, x, y, font, color, align) {
  var attrs = $.NSMutableDictionary.alloc.init;
  attrs.setObjectForKey(font, $.NSFontAttributeName);
  attrs.setObjectForKey(color, $.NSForegroundColorAttributeName);
  var s = $(String(text));
  var size = s.sizeWithAttributes(attrs);
  var width = Number(size.width);
  var px = x;
  if (align === "center") px = x - width / 2;
  else if (align === "right") px = x - width;
  s.drawAtPointWithAttributes($.NSMakePoint(px, y), attrs);
  return width;
}

function pictureRoundedRect(x, y, w, h, radius, color) {
  color.setFill;
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(x, y, w, h), radius, radius).fill;
}

function pictureDot(cx, cy, r, color) {
  color.setFill;
  $.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(cx - r, cy - r, 2 * r, 2 * r)).fill;
}

function renderPianoPlaceholder(W, H, message) {
  var rep = pictureBegin(W, H);
  try {
    pictureRoundedRect(0, 0, W, H, 8, pictureColor(0.13, 0.13, 0.145));
    pictureText(message, W / 2, H / 2 - 7, $.NSFont.systemFontOfSize(12), pictureColor(0.75, 0.75, 0.78), "center");
  } catch (e) {
    try { appendPlaybackLog(UI ? UI.supportDir : "", "Piano placeholder drawing failed: " + messageOf(e)); } catch (_) {}
  }
  return pictureEnd(rep, W, H);
}

// Where every key of the piano picture sits, in picture points (origin at the
// bottom left). Sets x and w on each key and returns the vertical bands; the
// same numbers draw the picture and tell which key a click landed on.
function pianoLayout(model, W, H) {
  var keys = model.keys;
  var padX = 6;
  var captionH = 20;
  var footerH = 16;
  var keysBottom = footerH;
  var keysTop = H - captionH;
  var keysH = keysTop - keysBottom;
  var nWhite = 0;
  for (var c = 0; c < keys.length; c++) if (!keys[c].isBlack) nWhite++;
  var ww = (W - 2 * padX) / nWhite;
  var bw = ww * 0.62;
  var whiteIndex = 0;
  for (var g = 0; g < keys.length; g++) {
    var k = keys[g];
    if (!k.isBlack) {
      k.x = padX + whiteIndex * ww;
      k.w = ww;
      whiteIndex++;
    } else {
      k.x = padX + whiteIndex * ww - bw / 2;
      k.w = bw;
    }
  }
  return {
    padX: padX,
    keysBottom: keysBottom,
    keysTop: keysTop,
    keysH: keysH,
    blackBottom: keysBottom + keysH * 0.40,
    whiteWidth: ww
  };
}

function renderPianoPicture(model, W, H) {
  var rep = pictureBegin(W, H);
  try {
    var keys = model.keys;
    pictureRoundedRect(0, 0, W, H, 8, pictureColor(0.13, 0.13, 0.145));

    var geo = pianoLayout(model, W, H);
    model.geometry = geo;
    var padX = geo.padX;
    var keysBottom = geo.keysBottom;
    var keysTop = geo.keysTop;
    var keysH = geo.keysH;
    var ww = geo.whiteWidth;

    var white = pictureColor(0.965, 0.965, 0.965);
    var whiteOff = pictureColor(0.56, 0.56, 0.585);
    var black = pictureColor(0.10, 0.10, 0.11);
    var blackOff = pictureColor(0.30, 0.30, 0.33);
    var green = pictureColor(0.36, 0.85, 0.36);
    var greenDark = pictureColor(0.13, 0.52, 0.18);
    var orange = pictureColor(1.0, 0.62, 0.25);
    var orangeDark = pictureColor(0.78, 0.40, 0.08);
    var outline = pictureColor(0.06, 0.06, 0.07);
    var whiteLabel = pictureColor(0.36, 0.36, 0.40);
    var whiteLabelLit = pictureColor(0.12, 0.25, 0.12);
    var blackLabel = pictureColor(0.86, 0.86, 0.90);
    var blackLabelLit = pictureColor(0.12, 0.20, 0.12);
    var captionOn = pictureColor(0.76, 0.76, 0.80);
    var captionOff = pictureColor(0.47, 0.47, 0.50);
    var fontWhite = $.NSFont.monospacedSystemFontOfSizeWeight(ww >= 15 ? 9 : 8, 0);
    var fontBlack = $.NSFont.monospacedSystemFontOfSizeWeight(7.5, 0);
    var fontCaption = $.NSFont.systemFontOfSize(9.5);
    var fontFooter = $.NSFont.boldSystemFontOfSize(9.5);

    // White keys first, then black keys on top.
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.isBlack) continue;
      var fill = !key.active ? (key.used ? orange : whiteOff) : (key.used ? green : white);
      pictureRoundedRect(key.x + 0.75, keysBottom, key.w - 1.5, keysH, 2, fill);
      var labelColor = key.used ? whiteLabelLit : whiteLabel;
      var cx = key.x + key.w / 2;
      pictureText(key.label, cx, keysBottom + 4, fontWhite, labelColor, "center");
      if (key.ctrl) pictureDot(cx, keysBottom + 17.5, 1.5, labelColor);
    }
    for (var j = 0; j < keys.length; j++) {
      var bk = keys[j];
      if (!bk.isBlack) continue;
      var bfill = !bk.active ? (bk.used ? orangeDark : blackOff) : (bk.used ? greenDark : black);
      var by = keysBottom + keysH * 0.40;
      var bh = keysH * 0.60;
      pictureRoundedRect(bk.x, by, bk.w, bh, 1.5, bfill);
      var bpath = $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(bk.x + 0.4, by + 0.4, bk.w - 0.8, bh - 0.8), 1.5, 1.5);
      bpath.setLineWidth(0.8);
      outline.setStroke;
      bpath.stroke;
      var bcx = bk.x + bk.w / 2;
      var blc = bk.used ? pictureColor(0.92, 1.0, 0.92) : blackLabel;
      pictureText(bk.label, bcx, by + 3, fontBlack, blc, "center");
      if (bk.ctrl) pictureDot(bcx, by + 14.5, 1.3, blc);
    }

    // Zone captions along the top.
    var zones = [
      { id: "low", key: "kbZoneLow" },
      { id: "main", key: "kbZoneMain" },
      { id: "high", key: "kbZoneHigh" }
    ];
    for (var z = 0; z < zones.length; z++) {
      var first = null, last = null;
      for (var q = 0; q < keys.length; q++) {
        if (keys[q].zone !== zones[z].id) continue;
        if (!first) first = keys[q];
        last = keys[q];
      }
      if (!first) continue;
      var zoneActive = model.extended || zones[z].id === "main";
      var color = zoneActive ? captionOn : captionOff;
      var x0 = first.x;
      var x1 = last.x + last.w;
      var lineY = keysTop + 3;
      color.setFill;
      $.NSBezierPath.fillRect($.NSMakeRect(x0 + 1, lineY, x1 - x0 - 2, 1));
      var text = T(zones[z].key, { from: noteName(first.midi), to: noteName(last.midi), mod: model.mod }) + (zoneActive ? "" : T("kbZoneOff"));
      var tx = zones[z].id === "high" ? x1 - 1 : x0 + 1;
      pictureText(text, tx, lineY + 4, fontCaption, color, zones[z].id === "high" ? "right" : "left");
    }

    // Skipped-note markers in the footer.
    if (model.skippedLow > 0) {
      pictureText(T(model.skippedLow === 1 ? "kbSkippedLowOne" : "kbSkippedLow", { n: model.skippedLow }), padX + 2, 2, fontFooter, orange, "left");
    }
    if (model.skippedHigh > 0) {
      pictureText(T(model.skippedHigh === 1 ? "kbSkippedHighOne" : "kbSkippedHigh", { n: model.skippedHigh }), W - padX - 2, 2, fontFooter, orange, "right");
    }
  } catch (e) {
    try { appendPlaybackLog(UI ? UI.supportDir : "", "Piano picture drawing failed: " + messageOf(e)); } catch (_) {}
  }
  return pictureEnd(rep, W, H);
}

// --- Live keys -------------------------------------------------------------------
// While the window is in front, the piano keys pressed on the keyboard are
// pressed in Roblox too, and so are the keys clicked on the piano picture.
// Events go straight to the Roblox process with the sender chosen in Settings
// (Quartz or Accessibility), which works with Roblox in the background. Every
// key sent down is tracked, so nothing can stay stuck in Roblox: all of it is
// let go when the window loses focus, when live keys are turned off and when
// the app quits.
var LIVE = null;

function liveReset() {
  LIVE = {
    pid: 0,
    sender: null,
    lastLookup: -100,
    modifiers: { shift: false, ctrl: false, alt: false },   // as last sent to Roblox
    down: {},              // key code -> piano-picture key index (-1 if none), keyboard keys held
    mouseIndex: -1,        // piano-picture key held with the mouse
    mouseCode: 0,
    testSender: null       // the self test records key events here instead
  };
}

// The sender for the running Roblox, looked up again when Roblox quits or
// starts (at most every UI_ROBLOX_LOOKUP_SECONDS unless forced).
function liveSender(force) {
  if (LIVE.testSender) return LIVE.testSender;
  if (LIVE.sender && LIVE.pid > 0 && isProcessAlive(LIVE.pid)) return LIVE.sender;
  if (LIVE.sender) {
    try { LIVE.sender.close(); } catch (_) {}
    LIVE.sender = null;
    LIVE.pid = 0;
    LIVE.modifiers = { shift: false, ctrl: false, alt: false };
  }
  var now = nowSeconds();
  if (!force && now - LIVE.lastLookup < UI_ROBLOX_LOOKUP_SECONDS) return null;
  LIVE.lastLookup = now;
  var target = findRobloxPlayerProcess();
  if (!target || !(target.pid > 0)) return null;
  try {
    LIVE.sender = createDirectKeySender(target.pid, "", UI.cfg.keySendMethod);
    LIVE.pid = target.pid;
    appendPlaybackLog(UI.supportDir, "Live keys: connected to " + describeApplicationInfo(target) + " (" + (LIVE.sender.mode === "cg" ? "Quartz" : "Accessibility") + ").");
  } catch (e) {
    LIVE.sender = null;
    LIVE.pid = 0;
    appendPlaybackLog(UI.supportDir, "Live keys: could not connect to Roblox. " + messageOf(e));
  }
  return LIVE.sender;
}

function liveDisconnect() {
  liveReleaseAll();
  if (LIVE.sender) {
    try { LIVE.sender.close(); } catch (_) {}
  }
  LIVE.sender = null;
  LIVE.pid = 0;
  LIVE.lastLookup = -100;
}

// Returns whether the event reached a sender (false while Roblox is closed).
function liveSend(code, isDown) {
  var sender = liveSender(false);
  if (!sender) return false;
  sender.postKeyCode(code, isDown, "");
  return true;
}

// Brings Shift / Ctrl / Option in Roblox to `want`, letting go before
// pressing so there is never an extra modifier down.
function liveSyncModifiers(want) {
  var names = ["shift", "ctrl", "alt"];
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    if (LIVE.modifiers[n] && !want[n]) {
      LIVE.modifiers[n] = false;
      liveSend(LIVE_MODIFIER_KEYCODES[n], false);
    }
  }
  for (var j = 0; j < names.length; j++) {
    var m = names[j];
    if (!LIVE.modifiers[m] && want[m] && liveSend(LIVE_MODIFIER_KEYCODES[m], true)) {
      LIVE.modifiers[m] = true;
      sleepSeconds(SHIFT_SETTLE_SECONDS);
    }
  }
}

function liveModifiersFromFlags(flags) {
  return { shift: !!(flags & NS_FLAG_SHIFT), ctrl: !!(flags & NS_FLAG_CONTROL), alt: !!(flags & NS_FLAG_OPTION) };
}

function liveIsEditingText() {
  try {
    var responder = UI.window.firstResponder;
    return !!(responder && !responder.isNil() && responder.isKindOfClass($.NSText));
  } catch (_) {
    return false;
  }
}

// The keys live keys may send: every key of the current piano, plus Space.
function uiComputeLiveCodes() {
  var codes = {};
  try {
    var steps = resolveKeyboardProfile(uiEffectiveConfig(UI.cfg)).steps;
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] && isFiniteNumber(steps[i].code)) codes[steps[i].code] = true;
    }
  } catch (_) {
    // No piano keys then; Space still works.
  }
  for (var e = 0; e < LIVE_EXTRA_KEYCODES.length; e++) codes[LIVE_EXTRA_KEYCODES[e]] = true;
  UI.liveCodes = codes;
}

// The key of the piano picture that a key code + modifiers plays, or -1.
function liveModelIndexFor(code, want) {
  if (!UI.kb || !UI.kb.model) return -1;
  var useAlt = normalizeExtendedModifier(UI.cfg.extendedModifier) === "alt";
  var extended = useAlt ? !!want.alt : !!want.ctrl;
  var keys = UI.kb.model.keys;
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (k.active && k.code === code && !!k.shift === !!want.shift && !!k.ctrl === extended) return i;
  }
  return -1;
}

// Called by the window for every event (RMPPWindow). Returns true when the
// event was a piano key that has been passed on to Roblox.
function liveHandleKeyEvent(event) {
  if (!UI || !LIVE || !UI.cfg.liveKeys) return false;
  var type = Number(event.type);
  if (type !== 10 && type !== 11 && type !== 12) return false;   // key down, key up, modifiers changed
  var flags = Number(event.modifierFlags);

  if (type === 12) {
    // While Command is down AppKit does not hand the window any key-up, so a
    // piano key let go meanwhile would stay down in Roblox: let go of every
    // live key as soon as Command is pressed (⌘P, ⌘=, … still work).
    if (flags & NS_FLAG_COMMAND) {
      liveReleaseAll();
      return false;
    }
    // A modifier let go on the keyboard is let go in Roblox too. Modifiers are
    // only ever pressed in Roblox together with a piano key (below).
    var held = liveModifiersFromFlags(flags);
    liveSyncModifiers({
      shift: LIVE.modifiers.shift && held.shift,
      ctrl: LIVE.modifiers.ctrl && held.ctrl,
      alt: LIVE.modifiers.alt && held.alt
    });
    return false;
  }

  var code = Number(event.keyCode);
  if (type === 11) {
    if (LIVE.down[code] == null) return false;
    var heldIndex = LIVE.down[code];
    delete LIVE.down[code];
    liveSend(code, false);
    if (heldIndex >= 0) uiSetKeyHighlight(heldIndex, false);
    return true;
  }

  // Key down. Command shortcuts, text fields and keys that are not piano keys
  // (Escape, Return, Tab, arrows, "/" …) keep their normal meaning here.
  if (flags & NS_FLAG_COMMAND) return false;
  if (!UI.liveCodes || !UI.liveCodes[code]) return false;
  if (liveIsEditingText()) return false;
  if (event.isARepeat) return true;   // held down: Roblox already has it
  var want = liveModifiersFromFlags(flags);
  liveSyncModifiers(want);
  if (LIVE.down[code] != null) {
    liveSend(code, false);            // struck again without a key-up: retrigger
    if (LIVE.down[code] >= 0) uiSetKeyHighlight(LIVE.down[code], false);
  }
  liveSend(code, true);
  var index = liveModelIndexFor(code, want);
  LIVE.down[code] = index;
  if (index >= 0) uiSetKeyHighlight(index, true);
  return true;
}

// Mouse on the piano picture (RMPPPianoView): press, glide, let go.
function liveMouse(event, phase) {
  if (!UI || !LIVE) return;
  if (phase === "up") {
    LIVE.mouseActive = false;
    liveReleaseMouseKey();
    return;
  }
  if (phase === "down") {
    LIVE.mouseActive = false;
    if (liveIsEditingText()) {
      // This click only finishes the text field. Ending the edit can show an
      // alert (a wrong value), and an alert swallows the mouse-up, so nothing
      // may be pressed by this click.
      UI.window.makeFirstResponder($());
      return;
    }
    LIVE.mouseActive = true;
  } else if (!LIVE.mouseActive) {
    return;
  }
  if (!UI.cfg.liveKeys || !UI.kb) return;
  // The view sits straight in the window's content view, so its frame gives
  // the offset from window coordinates to picture coordinates.
  var loc = event.locationInWindow;
  var frame = UI.w.keyboard.frame;
  var index = uiPianoKeyAt(Number(loc.x) - Number(frame.origin.x), Number(loc.y) - Number(frame.origin.y));
  if (index === LIVE.mouseIndex) return;
  liveReleaseMouseKey();
  if (index < 0) return;
  var key = UI.kb.model.keys[index];
  if (!key || !key.active || !isFiniteNumber(key.code)) return;
  var useAlt = normalizeExtendedModifier(UI.cfg.extendedModifier) === "alt";
  liveSyncModifiers({ shift: !!key.shift, ctrl: !!key.ctrl && !useAlt, alt: !!key.ctrl && useAlt });
  liveSend(key.code, true);
  LIVE.mouseIndex = index;
  LIVE.mouseCode = key.code;
  uiSetKeyHighlight(index, true);
}

function liveReleaseMouseKey() {
  if (!LIVE || LIVE.mouseIndex < 0) return;
  var index = LIVE.mouseIndex;
  LIVE.mouseIndex = -1;
  liveSend(LIVE.mouseCode, false);
  // Keyboard keys still held keep their modifiers; otherwise all go up.
  if (Object.keys(LIVE.down).length === 0) liveSyncModifiers({ shift: false, ctrl: false, alt: false });
  uiSetKeyHighlight(index, false);
}

function liveReleaseAll() {
  if (!LIVE) return;
  for (var code in LIVE.down) {
    if (LIVE.down.hasOwnProperty(code)) {
      try { liveSend(Number(code), false); } catch (_) {}
    }
  }
  LIVE.down = {};
  if (LIVE.mouseIndex >= 0) {
    LIVE.mouseIndex = -1;
    try { liveSend(LIVE.mouseCode, false); } catch (_) {}
  }
  try { liveSyncModifiers({ shift: false, ctrl: false, alt: false }); } catch (_) {}
  LIVE.modifiers = { shift: false, ctrl: false, alt: false };
  if (UI) uiClearKeyHighlights();
}

// The status at the right of the live keys checkbox.
function uiRefreshLiveStatus(force) {
  if (!UI || !UI.w.liveStatus || !LIVE) return;
  var text, color;
  if (!UI.cfg.liveKeys) {
    text = T("liveOff");
    color = $.NSColor.secondaryLabelColor;
  } else if (UI.trusted === false && !LIVE.testSender) {
    text = T("liveNeedsAccess");
    color = $.NSColor.systemOrangeColor;
  } else if (liveSender(!!force)) {
    text = T("liveConnected");
    color = $.NSColor.systemGreenColor;
  } else {
    text = T("liveNoRoblox");
    color = $.NSColor.secondaryLabelColor;
  }
  if (!force && text === UI.liveStatusText) return;
  UI.liveStatusText = text;
  UI.w.liveStatus.setStringValue($(text));
  UI.w.liveStatus.setTextColor(color);
}

// Which key of the piano picture is at (x, y), in picture points; -1 if none.
// Black keys sit on top, so they are tried first in their band.
function uiPianoKeyAt(x, y) {
  if (!UI.kb || !UI.kb.geometry) return -1;
  var g = UI.kb.geometry;
  var keys = UI.kb.model.keys;
  if (y < g.keysBottom || y > g.keysTop) return -1;
  if (y >= g.blackBottom) {
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].isBlack && x >= keys[i].x && x <= keys[i].x + keys[i].w) return i;
    }
  }
  for (var j = 0; j < keys.length; j++) {
    if (!keys[j].isBlack && x >= keys[j].x && x < keys[j].x + keys[j].w) return j;
  }
  return -1;
}

// A pressed key turns blue: a small coloured box over it, inside the piano
// view (so a click on it still reaches the piano).
function uiSetKeyHighlight(index, on) {
  if (!UI || !UI.kb || !UI.kb.geometry) return;
  var existing = UI.highlights[index];
  if (!on) {
    if (existing) {
      existing.removeFromSuperview;
      delete UI.highlights[index];
    }
    return;
  }
  if (existing) return;
  var key = UI.kb.model.keys[index];
  if (!key || key.x == null) return;
  var g = UI.kb.geometry;
  var rect = key.isBlack
    ? $.NSMakeRect(key.x, g.blackBottom, key.w, g.keysTop - g.blackBottom)
    : $.NSMakeRect(key.x + 0.75, g.keysBottom, key.w - 1.5, g.blackBottom - g.keysBottom - 1);
  var box = $.NSBox.alloc.initWithFrame(rect);
  box.setBoxType($.NSBoxCustom);
  box.setTitlePosition($.NSNoTitle);
  box.setBorderWidth(0);
  box.setCornerRadius(2);
  box.setContentViewMargins($.NSMakeSize(0, 0));
  box.setFillColor($.NSColor.systemBlueColor.colorWithAlphaComponent(key.isBlack ? 0.95 : 0.75));
  UI.w.keyboard.addSubview(box);
  UI.highlights[index] = box;
}

function uiClearKeyHighlights() {
  if (!UI || !UI.highlights) return;
  for (var k in UI.highlights) {
    if (UI.highlights.hasOwnProperty(k)) {
      try { UI.highlights[k].removeFromSuperview; } catch (_) {}
    }
  }
  UI.highlights = {};
}

// --- Playback status -----------------------------------------------------------
function uiRefreshPlayback() {
  var pb = getPlaybackStatus(UI.supportDir);
  UI.playback = pb;
  var st = pb.state || {};
  var status = "idle";
  if (pb.active) {
    status = String(st.status || "launching");
    if (status !== "launching" && status !== "waiting" && status !== "delay" && status !== "playing") status = "launching";
  } else if (st.status === "error" || st.status === "finished" || st.status === "stopped") {
    var age = nowSeconds() - Number(st.updatedAt || 0);
    if (age <= UI_RECENT_STATUS_SECONDS) status = String(st.status);
  }
  if (UI.busy && status === "idle") status = "launching";

  // The pause belongs to one song: adopt the worker's state when a new song
  // shows up, forget it when nothing plays.
  if (pb.active) {
    var jobId = String(st.jobId || "");
    if (jobId && jobId !== UI.controlJobId) {
      UI.controlJobId = jobId;
      UI.paused = !!st.paused;
    }
  } else {
    UI.controlJobId = "";
    UI.paused = false;
  }

  var song = String(st.songName || "");
  var done = Number(st.progressEvents || 0);
  var total = Number(st.totalEvents || 0);
  var sender = st.senderMode === "ax" ? T("senderAx") : T("senderQuartz");
  var paused = status === "playing" && UI.paused;
  // The worker writes its position about once a second; in between, and
  // through long rests, the clock moves on from the last report.
  var duration = Number(st.durationSeconds || 0);
  var speed = Number(st.speed || UI.cfg.speed) || 1;
  var position = Number(st.positionSeconds || 0);
  if (status === "playing" && !paused && !st.paused && st.updatedAt) {
    position += Math.max(0, nowSeconds() - Number(st.updatedAt)) * speed;
  }
  position = clamp(position, 0, Math.max(0, duration));
  var trustBlocked = status === "idle" && UI.trusted === false;
  var key = [status, song, done, total, paused, Math.floor(position), speed.toFixed(2), trustBlocked, uiEffectiveLanguage()].join("|");
  if (key === UI.statusKey) return;
  UI.statusKey = key;

  var w = UI.w;
  var text, detail, dot;
  var clockVars = { pos: formatClock(position), dur: formatClock(duration), speed: speed.toFixed(2), done: done, total: total, sender: sender, song: song };
  if (status === "launching") { text = T("statusLaunching"); detail = T("statusLaunchingDetail"); dot = $.NSColor.systemOrangeColor; }
  else if (status === "waiting") { text = T("statusWaiting"); detail = T("statusWaitingDetail", { song: song }); dot = $.NSColor.systemOrangeColor; }
  else if (status === "delay") { text = T("statusDelay"); detail = T("statusDelayDetail", { song: song }); dot = $.NSColor.systemGreenColor; }
  else if (paused) { text = T("statusPaused", clockVars); detail = T("statusPausedDetail", clockVars); dot = $.NSColor.systemYellowColor; }
  else if (status === "playing") { text = T("statusPlaying", clockVars); detail = T("statusPlayingDetail", clockVars); dot = $.NSColor.systemGreenColor; }
  else if (status === "finished") { text = T("statusFinished", { song: song }); detail = T("statusFinishedDetail"); dot = $.NSColor.systemBlueColor; }
  else if (status === "stopped") { text = T("statusStopped"); detail = T("statusStoppedDetail", { song: song }); dot = $.NSColor.systemGrayColor; }
  else if (status === "error") { text = T("statusError"); detail = T("statusErrorDetail", { detail: shortText(st.detail || "", 160) }); dot = $.NSColor.systemRedColor; }
  else if (trustBlocked) { text = T("statusNeedsAccess"); detail = T("statusNeedsAccessDetail"); dot = $.NSColor.systemOrangeColor; }
  else { text = T("statusIdle"); detail = T("statusIdleDetail"); dot = $.NSColor.systemGrayColor; }

  w.statusDot.setStringValue($("●"));
  w.statusDot.setTextColor(dot);
  w.statusText.setStringValue($(text));
  w.statusDetail.setStringValue($(detail));
  w.statusDetail.setToolTip($(detail));

  if (status === "launching" || status === "waiting" || status === "delay") {
    w.progress.setHidden(false);
    w.progress.setIndeterminate(true);
    w.progress.startAnimation(null);
  } else if (status === "playing") {
    w.progress.stopAnimation(null);
    w.progress.setHidden(false);
    w.progress.setIndeterminate(false);
    if (duration > 0) {
      w.progress.setMaxValue(duration);
      w.progress.setDoubleValue(position);
    } else {
      w.progress.setMaxValue(Math.max(1, total));
      w.progress.setDoubleValue(Math.min(done, Math.max(1, total)));
    }
  } else {
    w.progress.stopAnimation(null);
    w.progress.setHidden(true);
  }
  uiUpdateButtons();
}

function uiOnTimer() {
  if (!UI || UI.busy) return;
  UI.ticks++;
  if ((UI.ticks % 8) === 0) {
    // The self test can stand in for a Mac without the permission.
    var trusted = UI.trustOverride != null ? UI.trustOverride : accessibilityTrustedValue();
    if (trusted !== UI.trusted) {
      UI.trusted = trusted;
      UI.statusKey = "";
    }
  }
  uiRefreshPlayback();
  if ((UI.ticks % 2) === 0) uiRefreshLiveStatus(false);
}

function uiPump(seconds) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(Math.max(0.01, Number(seconds) || 0.05)));
}

// --- Actions -------------------------------------------------------------------
function uiSafely(fn, silent) {
  try {
    fn();
  } catch (e) {
    if (isCanceledError(e)) return;
    try { appendPlaybackLog(UI ? UI.supportDir : "", "Window error: " + messageOf(e)); } catch (_) {}
    if (!silent) uiAlert(T("errTitle"), messageOf(e), "warning");
  }
}

function uiAlert(title, text, style) {
  var alert = $.NSAlert.alloc.init;
  alert.setMessageText($(String(title || APP_NAME)));
  alert.setInformativeText($(String(text || "")));
  alert.setAlertStyle(style === "critical" ? $.NSAlertStyleCritical : (style === "warning" ? $.NSAlertStyleWarning : $.NSAlertStyleInformational));
  alert.addButtonWithTitle($("OK"));
  if (UI && UI.selfTest) {
    try { appendPlaybackLog(UI.supportDir, "[ui-selftest] alert suppressed: " + String(title) + " — " + String(text)); } catch (_) {}
    return;
  }
  alert.runModal;
}

function uiSaveConfig() {
  UI.cfg = sanitizeConfig(UI.cfg);
  saveConfig(UI.configPath, UI.cfg);
}

function uiDispatchAction(sender) {
  var tag = 0;
  try { tag = Number(sender.tag); } catch (_) { tag = 0; }
  uiSafely(function() {
    if (tag === UI_TAG.language) uiOnLanguage();
    else if (tag === UI_TAG.chooseMidi) uiOnChooseMidi();
    else if (tag === UI_TAG.transpose) uiOnTranspose();
    else if (tag === UI_TAG.mode) uiOnMode();
    else if (tag === UI_TAG.layout) uiOnLayout();
    else if (tag === UI_TAG.precision) uiOnPrecision();
    else if (tag === UI_TAG.sending) uiOnSending();
    else if (tag === UI_TAG.modifier) uiOnModifier();
    else if (tag === UI_TAG.speed) uiOnSpeed();
    else if (tag === UI_TAG.delay) uiOnDelay();
    else if (tag === UI_TAG.base) uiOnBase();
    else if (tag === UI_TAG.resetBase) uiOnResetBase();
    else if (tag === UI_TAG.liveLog) uiOnLiveLog();
    else if (tag === UI_TAG.arm) uiOnArm();
    else if (tag === UI_TAG.stop) uiOnStop();
    else if (tag === UI_TAG.openLog) uiOnOpenLog();
    else if (tag === UI_TAG.openFolder) uiOnOpenFolder();
    else if (tag === UI_TAG.about) uiOnAbout();
    else if (tag === UI_TAG.pause) uiOnPause();
    else if (tag === UI_TAG.speedButtons) uiOnSpeedButtons();
    else if (tag === UI_TAG.slower) uiSetSpeed(UI.cfg.speed - SPEED_STEP);
    else if (tag === UI_TAG.faster) uiSetSpeed(UI.cfg.speed + SPEED_STEP);
    else if (tag === UI_TAG.normalSpeed) uiSetSpeed(1);
    else if (tag === UI_TAG.liveKeys) uiOnLiveKeys(sender);
    else if (tag === UI_TAG.access) uiOnAccess();
    else if (tag === UI_TAG.helpManual) uiOpenURL(DOCS_URL + "manual.md");
    else if (tag === UI_TAG.helpStart) uiOpenURL(DOCS_URL + "getting-started.md");
    else if (tag === UI_TAG.helpTrouble) uiOpenURL(DOCS_URL + "troubleshooting.md");
    else if (tag === UI_TAG.helpIssue) uiOpenURL(APP_REPO_URL + "/issues");
    else if (tag >= UI_TAG.demoBase && tag < UI_TAG.demoBase + DEMO_SONGS.length) uiOnDemo(tag - UI_TAG.demoBase);
  });
}

function uiOnDemo(index) {
  var path = demoSongPath(index);
  if (path) uiLoadSong(path, demoSongTitle(index), index);
}

function uiOnLanguage() {
  var idx = Number(UI.w.language.indexOfSelectedItem);
  UI.cfg.uiLanguage = idx === 1 ? "fr" : "en";
  uiSaveConfig();
  if (UI.song && UI.song.demoIndex != null) UI.song.name = demoSongTitle(UI.song.demoIndex);
  UI.statusKey = "";
  uiBuildMenu();
  uiApplyStrings();
  uiRefreshSong();
  uiRefreshPlayback();
}

function uiOnChooseMidi() {
  var path = uiChooseMidiPath();
  if (path) uiLoadSong(path);
}

function uiOnTranspose() {
  UI.transpose = clamp(Number(UI.w.transpose.indexOfSelectedItem) - 12, -12, 12);
  uiRefreshSong();
}

function uiOnMode() {
  var idx = Number(UI.w.mode.selectedSegment);
  UI.cfg.keyboardMode = idx === 1 ? "extended" : "classic";
  if (UI.cfg.keyboardMode === "extended" && UI.cfg.baseMIDINote < EXTENDED_LOW_COUNT) {
    UI.cfg.baseMIDINote = EXTENDED_LOW_COUNT;
    uiAlert(APP_NAME, T("errBaseExtended", { name: noteName(EXTENDED_LOW_COUNT), min: EXTENDED_LOW_COUNT }), "informational");
  }
  uiSaveConfig();
  uiApplyStrings();
  uiRefreshSong();
}

function uiOnLayout() {
  var idx = Number(UI.w.layout.indexOfSelectedItem);
  if (idx === 2) {
    var current = normalizeKeyboardProfile(UI.cfg.keyboardProfile) === "custom" ? UI.cfg.keyLayout : defaultConfig.keyLayout;
    var answer;
    try {
      answer = promptForText(T("customLayoutTitle"), T("customLayoutPrompt"), current, [T("cancel"), T("save")]);
    } catch (e) {
      uiApplyStrings();
      if (isCanceledError(e)) return;
      throw e;
    }
    var chars = normalizeLayout(answer);
    if (chars.length === 0) {
      uiApplyStrings();
      throw new Error(T("errLayoutEmpty"));
    }
    UI.cfg.keyboardProfile = "custom";
    UI.cfg.keyLayout = chars.join('');
    UI.cfg.keyboardMode = "classic";
  } else if (idx === 1) {
    UI.cfg.keyboardProfile = "azerty";
    UI.cfg.keyLayout = AZERTY_PROFILE_LABELS.join('');
  } else {
    UI.cfg.keyboardProfile = "us";
    UI.cfg.keyLayout = US_PROFILE_LABELS.join('');
  }
  uiSaveConfig();
  uiApplyStrings();
  uiRefreshSong();
}

function uiOnPrecision() {
  UI.cfg.noteRecognitionMode = Number(UI.w.precision.indexOfSelectedItem) === 1 ? "smart" : "perfect";
  uiSaveConfig();
  uiRefreshSong();
}

function uiOnSending() {
  var idx = Number(UI.w.sending.indexOfSelectedItem);
  UI.cfg.keySendMethod = idx === 1 ? "quartz" : (idx === 2 ? "accessibility" : "auto");
  uiSaveConfig();
  liveDisconnect();
  uiRefreshLiveStatus(true);
}

function uiOnModifier() {
  UI.cfg.extendedModifier = Number(UI.w.modifier.indexOfSelectedItem) === 1 ? "alt" : "ctrl";
  uiSaveConfig();
  uiApplyStrings();
  uiRefreshSong();
}

function uiOnSpeed() {
  uiSetSpeed(Number(UI.w.speed.doubleValue));
}

function uiOnSpeedButtons() {
  var segment = Number(UI.w.speedButtons.selectedSegment);
  if (segment === 0) uiSetSpeed(UI.cfg.speed - SPEED_STEP);
  else if (segment === 2) uiSetSpeed(UI.cfg.speed + SPEED_STEP);
  else uiSetSpeed(1);
}

// One place for every speed change (slider, − / +, menu): it is saved for
// the next songs and, when a song is playing, applied to it on the spot.
function uiSetSpeed(value) {
  var v = Math.round(Number(value) * 100) / 100;
  if (!isFinite(v)) return;
  v = clamp(v, SPEED_MIN, SPEED_MAX);
  UI.cfg.speed = v;
  uiSaveConfig();
  uiShowSpeed();
  if (UI.song && UI.song.fit) uiRenderSongInfo();
  uiPushLiveControl();
  UI.statusKey = "";
}

function uiOnPause() {
  var pb = getPlaybackStatus(UI.supportDir);
  UI.playback = pb;
  if (!pb.active) return;
  var st = pb.state || {};
  if (String(st.status || "") !== "playing" && !UI.paused) return;
  UI.controlJobId = String(st.jobId || "");
  UI.paused = !UI.paused;
  uiPushLiveControl();
  UI.statusKey = "";
  uiRefreshPlayback();
}

// Tells the playing song about the window's speed and pause (the worker polls
// the file, see CONTROL_POLL_SECONDS).
function uiPushLiveControl() {
  var pb = UI.playback;
  if (!pb || !pb.active || !pb.state || !pb.state.jobId) return;
  writePlaybackControl(UI.supportDir, {
    jobId: String(pb.state.jobId),
    speed: UI.cfg.speed,
    paused: !!UI.paused,
    updatedAt: nowSeconds()
  });
}

function uiOnLiveKeys(sender) {
  // The checkbox carries its new state; the menu item just toggles.
  var isCheckbox = false;
  try { isCheckbox = !!(sender && sender.isKindOfClass($.NSButton)); } catch (_) {}
  UI.cfg.liveKeys = isCheckbox ? Number(UI.w.liveKeys.state) === 1 : !UI.cfg.liveKeys;
  uiSaveConfig();
  if (!UI.cfg.liveKeys) liveReleaseAll();
  UI.w.liveKeys.setState(UI.cfg.liveKeys ? 1 : 0);
  if (UI.menuLiveKeys) UI.menuLiveKeys.setState(UI.cfg.liveKeys ? 1 : 0);
  uiRefreshLiveStatus(true);
}

// Asks macOS to list the app under Accessibility (the system shows its own
// prompt) and opens that settings page.
function uiOnAccess() {
  try {
    var options = $.NSDictionary.dictionaryWithObjectForKey($.NSNumber.numberWithBool(true), $("AXTrustedCheckOptionPrompt"));
    if ($.AXIsProcessTrustedWithOptions) $.AXIsProcessTrustedWithOptions(options);
  } catch (_) {
    // Opening the settings page below is enough on its own.
  }
  app.doShellScript('/usr/bin/open ' + shellQuote("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"));
}

function uiOnDelay() {
  var v = parseFloat(trim(String(unwrapMaybe(UI.w.delay.stringValue) || "")).replace(",", "."));
  if (!isFinite(v) || v < 0 || v > 30) {
    UI.w.delay.setStringValue($(trimFloat(UI.cfg.startDelaySeconds)));
    throw new Error(T("errDelay"));
  }
  UI.cfg.startDelaySeconds = v;
  uiSaveConfig();
  UI.w.delay.setStringValue($(trimFloat(UI.cfg.startDelaySeconds)));
  uiRenderSongInfo();
  uiEndEditingSoon(UI.w.delay);
}

// Called from a text field's action. When Return or Enter sent it, the field
// stays in editing mode and would keep catching the piano keys, so it lets go
// of the focus on the next run-loop turn. Tab or a click elsewhere already
// moved the focus where the user wanted it, so nothing is done then.
function uiEndEditingSoon(field) {
  try {
    var event = UI.nsApp.currentEvent;
    if (!event || event.isNil() || Number(event.type) !== 10) return;
    var code = Number(event.keyCode);
    if (code !== 36 && code !== 76) return;   // Return, keypad Enter
    UI.controller.performSelectorWithObjectAfterDelay('uiEndEditing:', field, 0);
  } catch (_) {}
}

// Drops the focus only if `field` is still the one being edited.
function uiEndEditingOf(field) {
  if (!UI || !UI.window || !field) return;
  var responder = UI.window.firstResponder;
  if (!responder || responder.isNil() || !responder.isKindOfClass($.NSText)) return;
  var owner = responder.delegate;
  if (owner && !owner.isNil() && owner.isEqual(field)) UI.window.makeFirstResponder($());
}

function uiOnBase() {
  var parsed = parseMIDINoteInput(trim(String(unwrapMaybe(UI.w.base.stringValue) || "")));
  if (parsed == null) {
    UI.w.base.setStringValue($(noteName(UI.cfg.baseMIDINote)));
    throw new Error(T("errBase"));
  }
  if (normalizeKeyboardMode(UI.cfg.keyboardMode) === "extended" && parsed < EXTENDED_LOW_COUNT) {
    parsed = EXTENDED_LOW_COUNT;
    uiAlert(APP_NAME, T("errBaseExtended", { name: noteName(EXTENDED_LOW_COUNT), min: EXTENDED_LOW_COUNT }), "informational");
  }
  UI.cfg.baseMIDINote = parsed;
  uiSaveConfig();
  UI.w.base.setStringValue($(noteName(UI.cfg.baseMIDINote)));
  UI.w.baseInfo.setStringValue($(T("baseInfo", { n: UI.cfg.baseMIDINote })));
  uiRefreshSong();
  uiEndEditingSoon(UI.w.base);
}

function uiOnResetBase() {
  UI.cfg.baseMIDINote = 36;
  uiSaveConfig();
  UI.w.base.setStringValue($(noteName(UI.cfg.baseMIDINote)));
  UI.w.baseInfo.setStringValue($(T("baseInfo", { n: UI.cfg.baseMIDINote })));
  uiRefreshSong();
}

function uiOnLiveLog() {
  UI.cfg.openLiveLogWindow = Number(UI.w.liveLog.state) === 1;
  uiSaveConfig();
}

function uiOnArm() {
  // Return in a text field presses the default button (this one) before the
  // field has handed over its value: commit it first.
  if (liveIsEditingText()) UI.window.makeFirstResponder($());
  if (!UI.song) throw new Error(T("errNoSong"));
  var pb = getPlaybackStatus(UI.supportDir);
  if (pb.active) throw new Error(T("errActive"));
  uiRecomputeSong();
  var fit = UI.song.fit;
  if (!fit || !fit.built || fit.built.schedule.events.length === 0) throw new Error(T("errNoNotesFit"));
  validateBackgroundLayout(fit.profile);

  UI.busy = true;
  UI.statusKey = "";
  UI.paused = false;
  uiRefreshPlayback();
  uiUpdateButtons();
  uiPump(0.05);
  try {
    var armed = armBackgroundPlayback(fit.built.schedule, UI.song.path, UI.supportDir, { language: uiEffectiveLanguage(), quiet: !!UI.selfTest, songName: UI.song.name });
    UI.controlJobId = armed.jobId;
    UI.paused = false;
    if (UI.cfg.openLiveLogWindow) openLiveLogWindow(UI.supportDir, UI.song.name);
    var ready = uiWaitForWorkerReady(UI.supportDir, armed.jobId, 6.0);
    if (ready && ready.status === "error") throw new Error(buildPlaybackLaunchFailureMessage(UI.supportDir, ready.detail || T("errArmed")));
    if (ready && ready.status === "stopped") throw new Error(buildPlaybackLaunchFailureMessage(UI.supportDir, ready.detail || T("errArmed")));
    if (!isPlaybackReadyState(ready)) {
      if (!isProcessAlive(armed.pid)) {
        var early = readPlaybackState(UI.supportDir);
        throw new Error(buildPlaybackLaunchFailureMessage(UI.supportDir, early && early.detail ? String(early.detail) : T("errArmed")));
      }
      throw new Error(buildPlaybackLaunchFailureMessage(UI.supportDir, T("errArmed")));
    }
    appendPlaybackLog(UI.supportDir, "Playback armed from the window; worker reached state " + String(ready.status || "(unknown)") + ".");
  } finally {
    UI.busy = false;
    UI.statusKey = "";
    uiRefreshPlayback();
    uiUpdateButtons();
  }
}

function uiWaitForWorkerReady(supportDir, jobId, timeoutSeconds) {
  var end = nowSeconds() + Math.max(0.25, Number(timeoutSeconds) || 0);
  var lastState = null;
  while (nowSeconds() < end) {
    var state = readPlaybackState(supportDir);
    if (state && (!jobId || String(state.jobId || "") === String(jobId))) {
      lastState = state;
      if (state.status === "waiting" || state.status === "delay" || state.status === "playing" || state.status === "error" || state.status === "stopped") {
        return state;
      }
    }
    uiPump(0.05);
  }
  return lastState;
}

function uiOnStop() {
  var result = stopPlaybackCore(UI.supportDir, true);
  UI.paused = false;
  UI.statusKey = "";
  uiRefreshPlayback();
  if (result.wasActive && !result.dead) {
    uiAlert(APP_NAME, T("stopNotDead", { pid: result.pid }), "warning");
  }
}

function uiOnOpenLog() {
  var path = playbackLogPath(UI.supportDir);
  if (!$.NSFileManager.defaultManager.fileExistsAtPath($(path))) writeTextFile(path, "");
  app.doShellScript('/usr/bin/open ' + shellQuote(path));
}

function uiOnOpenFolder() {
  app.doShellScript('/usr/bin/open ' + shellQuote(UI.supportDir));
}

function uiOnAbout() {
  var alert = $.NSAlert.alloc.init;
  alert.setMessageText($(T("aboutTitle", { version: "v" + APP_VERSION })));
  alert.setInformativeText($(T("aboutText")));
  alert.setAlertStyle($.NSAlertStyleInformational);
  alert.addButtonWithTitle($("OK"));
  alert.addButtonWithTitle($(T("aboutWebsite")));
  if (UI && UI.selfTest) return;
  if (Number(alert.runModal) === 1001) {   // NSAlertSecondButtonReturn
    uiOpenURL(APP_REPO_URL);
  }
}

// --- Self test (--ui-selftest <midi> <pngPrefix>) --------------------------------
// Builds the real window, loads a song, flips the mode and the language, and
// captures the window after each step, so the layout can be checked without a
// person clicking through it. Nothing is armed and the saved settings are put
// back afterwards.
function uiSelfTest(args) {
  var midi = args.length >= 1 ? String(args[0]) : "";
  var prefix = args.length >= 2 ? String(args[1]) : (ensureSupportDir() + "/ui_selftest");
  var arm = args.length >= 3 && String(args[2]).toLowerCase() === "arm";
  return mainWindowUI({ selfTest: { midi: midi, prefix: prefix, arm: arm } });
}

function uiCaptureWindow(path) {
  uiPump(0.35);
  var wid = Number(UI.window.windowNumber);
  var task = $.NSTask.alloc.init;
  task.setLaunchPath($('/usr/sbin/screencapture'));
  task.setArguments($(['-x', '-o', '-l', String(wid), path]));
  task.launch;
  task.waitUntilExit;
  return Number(task.terminationStatus) === 0;
}

function uiRunSelfTest() {
  var st = UI.selfTest;
  var originalCfg = clone(UI.cfg);
  var report = { steps: [] };
  function step(name, fn) {
    var entry = { name: name };
    try {
      fn();
      entry.captured = uiCaptureWindow(st.prefix + "_" + name + ".png");
      if (UI.song && UI.song.fit) {
        entry.mode = UI.cfg.keyboardMode;
        entry.mapped = UI.song.fit.built.mapped;
        entry.skippedLow = UI.song.fit.built.skippedLow;
        entry.skippedHigh = UI.song.fit.built.skippedHigh;
        entry.events = UI.song.fit.built.schedule.events.length;
        entry.coverage = String(unwrapMaybe(UI.w.coverage.stringValue));
      }
      entry.status = String(unwrapMaybe(UI.w.statusText.stringValue));
      entry.ok = true;
    } catch (e) {
      entry.ok = false;
      entry.error = messageOf(e);
    }
    report.steps.push(entry);
  }
  try {
    uiPump(0.4);
    step("01_initial", function() {});
    if (st.midi) {
      // A demo song shows its title, as when it is opened from File › Demo Songs.
      var demoIndex = null;
      for (var dm = 0; dm < DEMO_SONGS.length; dm++) {
        if (basename(st.midi) === DEMO_SONGS[dm].file) demoIndex = dm;
      }
      step("02_loaded", function() { uiLoadSong(st.midi, demoIndex != null ? demoSongTitle(demoIndex) : "", demoIndex); });
    }
    step("03_mode2", function() { UI.w.mode.setSelectedSegment(1); uiOnMode(); });
    step("04_mode1", function() { UI.w.mode.setSelectedSegment(0); uiOnMode(); });
    step("05_mode2_fr", function() { UI.w.mode.setSelectedSegment(1); uiOnMode(); UI.w.language.selectItemAtIndex(1); uiOnLanguage(); });
    step("06_transpose_plus12", function() { UI.w.transpose.selectItemAtIndex(24); uiOnTranspose(); });

    // Live keys, with a recorder in place of Roblox: real window events go
    // through RMPPWindow / RMPPPianoView exactly as typed or clicked ones do.
    var recorded = [];
    LIVE.testSender = {
      mode: "cg",
      postKeyCode: function(code, isDown) { recorded.push((isDown ? "+" : "-") + code); },
      close: function() {}
    };
    var wn = Number(UI.window.windowNumber);
    function keyEvent(type, code, flags, chars, repeat) {
      return $.NSEvent.keyEventWithTypeLocationModifierFlagsTimestampWindowNumberContextCharactersCharactersIgnoringModifiersIsARepeatKeyCode(
        type, $.NSMakePoint(0, 0), flags, 0, wn, $(), $(chars), $(chars), !!repeat, code);
    }
    function mouseOnKey(type, index) {
      var k = UI.kb.model.keys[index];
      var g = UI.kb.geometry;
      var f = UI.w.keyboard.frame;
      var x = Number(f.origin.x) + k.x + k.w / 2;
      var y = Number(f.origin.y) + (k.isBlack ? g.blackBottom + 6 : g.keysBottom + 8);
      return $.NSEvent.mouseEventWithTypeLocationModifierFlagsTimestampWindowNumberContextEventNumberClickCountPressure(
        type, $.NSMakePoint(x, y), 0, 0, wn, $(), 0, 1, 1);
    }
    function indexOfLabel(label) {
      for (var i = 0; i < UI.kb.model.keys.length; i++) if (UI.kb.model.keys[i].label === label && UI.kb.model.keys[i].zone === "main") return i;
      return -1;
    }
    step("07_live_keys", function() {
      UI.w.transpose.selectItemAtIndex(12); uiOnTranspose();
      UI.w.language.selectItemAtIndex(0); uiOnLanguage();
      UI.cfg.liveKeys = true;
      uiRefreshLiveStatus(true);
      // "1" on the keyboard, then Shift + "2" (a black key), held for the picture.
      UI.window.sendEvent(keyEvent(10, 18, 0, "1", false));
      UI.window.sendEvent(keyEvent(10, 18, 0, "1", true));                        // auto-repeat: ignored
      UI.window.sendEvent(keyEvent(12, 56, NS_FLAG_SHIFT, "", false));
      UI.window.sendEvent(keyEvent(10, 19, NS_FLAG_SHIFT, "@", false));
      // A white key in the middle clicked with the mouse, still held.
      UI.window.sendEvent(mouseOnKey(1, indexOfLabel("t")));
    });
    report.liveHeld = recorded.slice();
    report.liveHighlights = Object.keys(UI.highlights).length;
    step("08_live_released", function() {
      UI.window.sendEvent(mouseOnKey(6, indexOfLabel("y")));                         // glide to "y"
      UI.window.sendEvent(mouseOnKey(2, indexOfLabel("y")));
      UI.window.sendEvent(keyEvent(11, 19, NS_FLAG_SHIFT, "@", false));
      UI.window.sendEvent(keyEvent(12, 56, 0, "", false));
      UI.window.sendEvent(keyEvent(11, 18, 0, "1", false));
      UI.window.sendEvent(keyEvent(10, 44, 0, "/", false));                         // "/" opens Roblox chat: never sent
      UI.window.sendEvent(keyEvent(10, 15, NS_FLAG_COMMAND, "r", false));           // Command shortcuts: never sent
      UI.window.sendEvent(keyEvent(10, 15, 0, "r", false));                         // held when the window loses focus...
      liveReleaseAll();                                                            // ...is let go
      // While a text field is being edited, keys type into it instead.
      UI.window.makeFirstResponder(UI.w.delay);
      UI.window.sendEvent(keyEvent(10, 20, 0, "3", false));
      UI.window.sendEvent(keyEvent(11, 20, 0, "3", false));
      UI.window.makeFirstResponder($());
      uiPump(0.1);
    });
    report.liveAll = recorded.slice();
    report.delayAfterTyping = UI.cfg.startDelaySeconds;
    report.editingAfterCommit = liveIsEditingText();

    // Review fixes. (1) Command pressed while a piano key is held lets go of it.
    recorded.length = 0;
    UI.window.sendEvent(keyEvent(10, 18, 0, "1", false));
    UI.window.sendEvent(keyEvent(12, 55, NS_FLAG_COMMAND, "", false));
    report.commandReleases = recorded.slice();
    report.commandHighlights = Object.keys(UI.highlights).length;
    UI.window.sendEvent(keyEvent(12, 55, 0, "", false));
    // (2) A click that only ends a text field presses nothing, even when dragged.
    recorded.length = 0;
    UI.window.makeFirstResponder(UI.w.delay);
    UI.window.sendEvent(mouseOnKey(1, indexOfLabel("t")));
    UI.window.sendEvent(mouseOnKey(6, indexOfLabel("y")));
    UI.window.sendEvent(mouseOnKey(2, indexOfLabel("y")));
    report.commitClickSent = recorded.slice();
    UI.window.sendEvent(mouseOnKey(1, indexOfLabel("t")));
    UI.window.sendEvent(mouseOnKey(2, indexOfLabel("t")));
    report.nextClickSent = recorded.slice();
    // (3) Tab from one field to the next keeps the next one editing; ending
    // the editing of a field never touches another field.
    UI.window.makeFirstResponder(UI.w.delay);
    UI.window.sendEvent(keyEvent(10, 48, 0, "\t", false));
    uiPump(0.15);
    var fr = UI.window.firstResponder;
    report.tabEditsBase = !!(liveIsEditingText() && fr.delegate && fr.delegate.isEqual(UI.w.base));
    uiEndEditingOf(UI.w.delay);
    report.otherFieldUntouched = liveIsEditingText();
    uiEndEditingOf(UI.w.base);
    report.sameFieldEnded = !liveIsEditingText();
    report.liveHighlightsAfter = Object.keys(UI.highlights).length;
    step("09_speed_fr", function() {
      UI.w.language.selectItemAtIndex(1); uiOnLanguage();
      uiSetSpeed(1.25);
      uiSetSpeed(UI.cfg.speed + SPEED_STEP);
    });
    report.speedAfterButtons = UI.cfg.speed;
    report.speedLabel = String(unwrapMaybe(UI.w.speedButtons.labelForSegment(1)));
    LIVE.testSender = null;

    // The status card while a song plays, then paused: a stand-in state file
    // that points at this process, so nothing is launched or killed.
    var fakeJob = "selftest_" + Math.round(nowSeconds());
    var songSeconds = 214, songEvents = 103;
    if (UI.song && UI.song.fit) {
      songSeconds = scheduleLengthSeconds(UI.song.fit.built.schedule) * (UI.song.fit.playbackCfg.speed || 1);
      songEvents = UI.song.fit.built.schedule.events.length;
    }
    var fakeState = {
      jobId: fakeJob, pid: currentProcessId(), songName: UI.song ? UI.song.name : "song.mid", status: "playing", senderMode: "cg",
      progressEvents: Math.round(songEvents * 0.4), totalEvents: songEvents, positionSeconds: songSeconds * 0.4,
      durationSeconds: songSeconds, speed: UI.cfg.speed, paused: false, createdAt: nowSeconds(), updatedAt: nowSeconds()
    };
    savePlaybackState(UI.supportDir, fakeState);
    writePlaybackControl(UI.supportDir, { jobId: fakeJob, speed: UI.cfg.speed, paused: false, updatedAt: nowSeconds() });
    LIVE.testSender = { mode: "cg", postKeyCode: function() {}, close: function() {} };
    step("12_playing", function() {
      UI.cfg.startDelaySeconds = 0.5;
      UI.w.delay.setStringValue($("0.5"));
      UI.w.language.selectItemAtIndex(0); uiOnLanguage();
      UI.w.mode.setSelectedSegment(0); uiOnMode();
      fakeState.songName = UI.song ? UI.song.name : fakeState.songName;
      savePlaybackState(UI.supportDir, fakeState);
      UI.statusKey = "";
      uiRefreshPlayback();
      uiRefreshLiveStatus(true);
      // A C major chord held on the keyboard: t u o (C4 E4 G4 on the US layout).
      UI.window.sendEvent(keyEvent(10, 17, 0, "t", false));
      UI.window.sendEvent(keyEvent(10, 32, 0, "u", false));
      UI.window.sendEvent(keyEvent(10, 31, 0, "o", false));
    });
    liveReleaseAll();
    LIVE.testSender = null;
    report.playingDetail = String(unwrapMaybe(UI.w.statusDetail.stringValue));
    report.pauseEnabled = !!UI.w.pause.isEnabled;
    step("13_paused", function() {
      uiOnPause();
      fakeState.paused = true;
      fakeState.updatedAt = nowSeconds();
      savePlaybackState(UI.supportDir, fakeState);
      uiSetSpeed(0.9);
      UI.statusKey = "";
      uiRefreshPlayback();
    });
    report.pausedControl = readPlaybackControl(UI.supportDir);
    report.pausedButton = String(unwrapMaybe(UI.w.pause.title));
    report.pausedText = String(unwrapMaybe(UI.w.statusText.stringValue));
    step("13_paused_fr", function() {
      UI.w.language.selectItemAtIndex(1); uiOnLanguage();
      fakeState.songName = UI.song ? UI.song.name : fakeState.songName;
      savePlaybackState(UI.supportDir, fakeState);
      UI.statusKey = "";
      uiRefreshPlayback();
    });
    UI.w.language.selectItemAtIndex(0); uiOnLanguage();
    uiOnPause();
    report.resumedControl = readPlaybackControl(UI.supportDir);
    removeFileIfExists(playbackStatePath(UI.supportDir));
    removeFileIfExists(playbackControlPath(UI.supportDir));
    UI.statusKey = "";
    uiRefreshPlayback();

    // The live keys switch (checkbox, then menu) and the "Allow…" button.
    var toggled = [];
    LIVE.testSender = { mode: "cg", postKeyCode: function(code, isDown) { toggled.push((isDown ? "+" : "-") + code); }, close: function() {} };
    UI.w.liveKeys.setState(0);
    uiDispatchAction(UI.w.liveKeys);
    report.liveOffConfig = UI.cfg.liveKeys;
    report.liveOffMenuState = Number(UI.menuLiveKeys.state);
    UI.window.sendEvent(keyEvent(10, 18, 0, "1", false));
    UI.window.sendEvent(keyEvent(11, 18, 0, "1", false));
    report.liveOffSent = toggled.length;
    uiDispatchAction(UI.menuLiveKeys);
    report.liveOnAgainConfig = UI.cfg.liveKeys;
    report.liveOnAgainCheckbox = Number(UI.w.liveKeys.state);
    UI.window.sendEvent(keyEvent(10, 18, 0, "1", false));
    UI.window.sendEvent(keyEvent(11, 18, 0, "1", false));
    report.liveOnAgainSent = toggled.slice();
    LIVE.testSender = null;
    var realTrust = UI.trusted;
    step("14_needs_access", function() {
      UI.trustOverride = false;
      UI.trusted = false;
      UI.statusKey = "";
      uiRefreshPlayback();
      uiRefreshLiveStatus(true);
    });
    report.accessShown = !UI.w.access.isHidden && !!UI.w.pause.isHidden;
    report.accessText = String(unwrapMaybe(UI.w.statusText.stringValue));
    UI.trustOverride = null;
    UI.trusted = realTrust;
    UI.statusKey = "";
    uiRefreshPlayback();
    uiRefreshLiveStatus(true);

    if (st.arm) {
      // Arm for real (the worker only sends keys once Roblox is the front
      // window, so with Roblox closed nothing is played), change the speed
      // and pause it, then stop it.
      step("10_armed", function() {
        uiOnArm();
        for (var i = 0; i < 20; i++) { uiPump(0.1); uiRefreshPlayback(); }
      });
      report.armedState = readPlaybackState(UI.supportDir);
      report.controlAtArm = readPlaybackControl(UI.supportDir);
      uiSetSpeed(0.8);
      report.controlAfterSpeed = readPlaybackControl(UI.supportDir);
      step("11_stopped", function() {
        uiOnStop();
        for (var j = 0; j < 10; j++) { uiPump(0.1); uiRefreshPlayback(); }
      });
      report.stoppedState = readPlaybackState(UI.supportDir);
      report.controlAfterStop = readPlaybackControl(UI.supportDir);
    }
    // The menu bar, and a demo song opened the way File › Demo Songs does.
    var bar = UI.nsApp.mainMenu;
    report.menus = [];
    for (var mi = 1; mi < Number(bar.numberOfItems); mi++) {
      var sub = bar.itemAtIndex(mi).submenu;
      var titles = [];
      for (var si = 0; si < Number(sub.numberOfItems); si++) titles.push(String(unwrapMaybe(sub.itemAtIndex(si).title)));
      report.menus.push(String(unwrapMaybe(sub.title)) + ": " + titles.join(" | "));
    }
    uiDispatchAction(UI.nsApp.mainMenu.itemAtIndex(1).submenu.itemAtIndex(1).submenu.itemAtIndex(1));
    report.demoLoaded = UI.song ? UI.song.name + " (" + UI.song.parsed.notes.length + " notes)" : "";
    report.windowHeight = UI.windowHeight;
    report.language = uiEffectiveLanguage();
  } finally {
    UI.cfg = sanitizeConfig(originalCfg);
    saveConfig(UI.configPath, UI.cfg);
    try { UI.timer.invalidate; } catch (_) {}
    try { UI.window.close; } catch (_) {}
  }
  writeTextFile(st.prefix + "_report.json", JSON.stringify(report, null, 2));
  return JSON.stringify(report, null, 2);
}
