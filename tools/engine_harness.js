// Offline test of the playback engine with the extended (88-key) piano.
//
//   osascript -l JavaScript engine_harness.js /path/to/main.js
//
// Loads the real main.js, stubs the operating-system calls (clock, sleep, key
// sender, stop file, state/log files) and drives the REAL buildSchedule +
// performPlaybackToPid with synthetic songs. It then checks that every key was
// sent with the right modifier (Ctrl for the dotted keys, Shift for the classic
// black keys, nothing for white keys), that nothing is left held down, and that
// the classic piano really skips the extended notes.
ObjC.import('Foundation');

function run(argv) {
  var mainPath = String(argv[0] || "");
  var src = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError($(mainPath), $.NSUTF8StringEncoding, null));
  // Turn "function run(argv)" of main.js into "function mainRun(argv)" so this
  // harness keeps its own entry point, then evaluate everything else as is.
  src = src.replace(/function run\(argv\)/, "function mainRun(argv)");
  (0, eval)(src);

  var failures = [];
  var log = [];
  function check(cond, msg) { if (!cond) failures.push(msg); }

  // ---- stubs -------------------------------------------------------------
  // Virtual clock. Reading it costs a little time too, otherwise the engine's
  // final sub-3ms busy-wait (which relies on real time passing) never ends.
  var clock = 0;
  nowSeconds = function() { clock += 0.00005; return clock; };
  sleepSeconds = function(s) { if (s > 0) clock += s; };
  stopRequested = function() { return false; };
  appendPlaybackLog = function(dir, msg) { log.push(String(msg)); };
  savePlaybackState = function() {};
  createPlaybackTraceWriter = function() { return { write: function() {}, close: function() {} }; };
  isApplicationRunning = function() { return true; };
  applicationInfoForPid = function(pid) { return { name: "Roblox", pid: pid }; };

  var KEY_COST = 0.002;   // like Quartz
  function makeRecorder() {
    var rec = { events: [], down: {}, shift: false, ctrl: false, alt: false, presses: [] };
    rec.sender = {
      mode: "cg",
      postKeyCode: function(code, isDown) {
        clock += KEY_COST;
        rec.events.push({ t: clock, code: code, down: isDown });
        if (code === 56) { rec.shift = isDown; return; }
        if (code === 59) { rec.ctrl = isDown; return; }
        if (code === 58) { rec.alt = isDown; return; }
        if (isDown) {
          rec.presses.push({ t: clock, code: code, shift: rec.shift, ctrl: rec.ctrl, alt: rec.alt });
          rec.down[code] = true;
        } else {
          delete rec.down[code];
        }
      },
      close: function() {}
    };
    return rec;
  }
  var recorder = null;
  createDirectKeySender = function() { return recorder.sender; };

  // ---- helpers -----------------------------------------------------------
  function song(list) {
    // list of [tick, [pitches], durTicks]
    var notes = [];
    for (var i = 0; i < list.length; i++) {
      for (var p = 0; p < list[i][1].length; p++) notes.push({ tick: list[i][0], note: list[i][1][p], durTicks: list[i][2] });
    }
    notes.sort(function(a, b) { return a.tick === b.tick ? a.note - b.note : a.tick - b.tick; });
    return notes;
  }
  function cfgFor(mode, profileId, modifier) {
    return sanitizeConfig({
      baseMIDINote: 36, keyboardProfile: profileId || "us", keyLayout: profileId === "azerty" ? AZERTY_PROFILE_LABELS.join('') : US_PROFILE_LABELS.join(''),
      startDelaySeconds: 0, speed: 1, noteRecognitionMode: "perfect", keySendMethod: "quartz",
      keyboardMode: mode, extendedModifier: modifier || "ctrl"
    });
  }
  function play(notes, cfg) {
    var profile = resolveKeyboardProfile(cfg);
    var analysis = analyzeNotes(notes, profile, cfg.baseMIDINote, cfg.noteRecognitionMode);
    var pc = clone(cfg);
    pc.baseMIDINote = analysis.detectedBase;
    pc.savedBaseMIDINote = analysis.savedBase;
    var built = buildSchedule(notes, [], 480, pc, profile);
    recorder = makeRecorder();
    clock = 100;
    performPlaybackToPid(built.schedule, 4242, "/tmp/harness", { jobId: "h" });
    return { profile: profile, analysis: analysis, built: built, rec: recorder };
  }
  function expectedSpec(profile, midi) {
    var idx = midi - (36 - (profile.anchorIndex || 0));
    if (idx < 0 || idx >= profile.steps.length) return null;
    return profile.steps[idx];
  }

  // ---- test 1: profile shape ----------------------------------------------
  var ext = resolveKeyboardProfile(cfgFor("extended", "us"));
  var cls = resolveKeyboardProfile(cfgFor("classic", "us"));
  check(cls.steps.length === 61 && cls.anchorIndex === 0, "classic profile has 61 steps, anchor 0");
  check(ext.steps.length === 88 && ext.anchorIndex === 15, "extended profile has 88 steps, anchor 15 (got " + ext.steps.length + "/" + ext.anchorIndex + ")");
  check(ext.steps[0].ctrl && ext.steps[0].code === 18 && ext.steps[0].label === "1" && !ext.steps[0].isBlack, "A0 = Ctrl+1 white");
  check(ext.steps[1].ctrl && ext.steps[1].code === 19 && ext.steps[1].isBlack, "A#0 = Ctrl+2 black");
  check(ext.steps[14].ctrl && ext.steps[14].code === 17 && ext.steps[14].label === "t", "B1 = Ctrl+t");
  check(!ext.steps[15].ctrl && ext.steps[15].code === 18 && ext.steps[15].label === "1", "C2 = key 1 (no modifier)");
  check(ext.steps[16].shift && ext.steps[16].label === "!", "C#2 = Shift+1 (!)");
  check(!ext.steps[75].ctrl && ext.steps[75].label === "m", "C7 = m");
  check(ext.steps[76].ctrl && ext.steps[76].code === 16 && ext.steps[76].isBlack && ext.steps[76].label === "y", "C#7 = Ctrl+y black");
  check(ext.steps[87].ctrl && ext.steps[87].code === 38 && ext.steps[87].label === "j" && !ext.steps[87].isBlack, "C8 = Ctrl+j white");
  // classic steps must be identical inside both profiles
  for (var i = 0; i < 61; i++) {
    var a = cls.steps[i], b = ext.steps[i + 15];
    if (a.code !== b.code || a.shift !== b.shift || a.label !== b.label) { check(false, "classic step " + i + " differs between profiles"); break; }
  }
  var extFr = resolveKeyboardProfile(cfgFor("extended", "azerty"));
  check(extFr.steps[0].label === "&" && extFr.steps[10].label === "a" && extFr.steps[81].label === "q" && extFr.steps[87].label === "j", "AZERTY extended labels (&, a, q, j)");
  check(extFr.steps[0].code === 18 && extFr.steps[81].code === 0, "AZERTY extended key codes are the physical positions");

  // ---- test 2: the classic piano skips the extended notes ---------------
  var wide = song([[0, [21], 240], [480, [36], 240], [960, [96], 240], [1440, [108], 240], [1920, [20], 240], [2400, [109], 240]]);
  var r1 = play(wide, cfgFor("classic", "us"));
  check(r1.built.mapped === 2 && r1.built.skippedLow === 2 && r1.built.skippedHigh === 2, "classic: 2 mapped, 2 low + 2 high skipped (got " + r1.built.mapped + "/" + r1.built.skippedLow + "/" + r1.built.skippedHigh + ")");
  check(r1.rec.presses.length === 2, "classic: 2 key presses sent");
  var ctrlEventsClassic = r1.rec.events.filter(function(e) { return e.code === 59 && e.down; }).length;
  check(ctrlEventsClassic === 0, "classic: Ctrl never pressed");

  // ---- test 3: the extended piano plays A0..C8 with Ctrl where needed -----
  var r2 = play(wide, cfgFor("extended", "us"));
  check(r2.built.mapped === 4 && r2.built.skippedLow === 1 && r2.built.skippedHigh === 1, "extended: 4 mapped, 1 low + 1 high skipped (got " + r2.built.mapped + "/" + r2.built.skippedLow + "/" + r2.built.skippedHigh + ")");
  check(r2.rec.presses.length === 4, "extended: 4 key presses sent");
  var p = r2.rec.presses;
  check(p[0].code === 18 && p[0].ctrl && !p[0].shift, "A0 pressed as Ctrl+1 (code 18, ctrl down, shift up)");
  check(p[1].code === 18 && !p[1].ctrl && !p[1].shift, "C2 pressed as plain key 1 (ctrl released first)");
  check(p[2].code === 46 && !p[2].ctrl && !p[2].shift, "C7 pressed as plain m");
  check(p[3].code === 38 && p[3].ctrl && !p[3].shift, "C8 pressed as Ctrl+j");
  check(Object.keys(r2.rec.down).length === 0 && !r2.rec.shift && !r2.rec.ctrl, "extended: nothing left held, modifiers up at the end");

  // ---- test 4: full chromatic sweep, every key gets the modifier its step says
  var sweep = [];
  for (var m = 21; m <= 108; m++) sweep.push([ (m - 21) * 120, [m], 60 ]);
  var r3 = play(song(sweep), cfgFor("extended", "us"));
  check(r3.built.mapped === 88 && r3.built.skipped === 0, "sweep: all 88 notes mapped");
  check(r3.rec.presses.length === 88, "sweep: 88 presses (got " + r3.rec.presses.length + ")");
  var bad = 0;
  for (var s = 0; s < r3.rec.presses.length; s++) {
    var pr = r3.rec.presses[s];
    var st = expectedSpec(r3.profile, 21 + s);
    if (!st || pr.code !== st.code || pr.ctrl !== !!st.ctrl || pr.shift !== !!st.shift) { bad++; if (bad < 4) failures.push("sweep: note " + noteName(21 + s) + " sent as code " + pr.code + " ctrl=" + pr.ctrl + " shift=" + pr.shift + " but expected code " + (st && st.code) + " ctrl=" + (st && !!st.ctrl) + " shift=" + (st && !!st.shift)); }
  }
  check(bad === 0, "sweep: every note carries the right modifier (" + bad + " wrong)");
  check(Object.keys(r3.rec.down).length === 0 && !r3.rec.shift && !r3.rec.ctrl, "sweep: clean at the end");
  // never both Shift and Ctrl down at a key press
  var both = r3.rec.presses.filter(function(x) { return x.shift && x.ctrl; }).length;
  check(both === 0, "sweep: Shift and Ctrl are never down together at a press");

  // ---- test 5: chords mixing the zones -----------------------------------
  var chords = song([
    [0, [21, 60, 108], 480],                 // A0 (ctrl) + C4 (plain) + C8 (ctrl)
    [960, [23, 36, 61, 96, 100], 480],       // B0 ctrl, C2 plain, C#4 shift, C7 plain, E7 ctrl
    [1920, [33, 45, 57, 69, 81, 93, 105], 960]
  ]);
  var r4 = play(chords, cfgFor("extended", "us"));
  check(r4.built.mapped === 15 && r4.built.skipped === 0, "chords: all 15 notes mapped");
  check(r4.rec.presses.length === 15, "chords: 15 presses (got " + r4.rec.presses.length + ")");
  var bad4 = 0;
  for (var c = 0; c < r4.rec.presses.length; c++) {
    // find which note this press corresponds to by code+modifiers at that chord
    var pr4 = r4.rec.presses[c];
    var okOne = false;
    for (var n = 0; n < chords.length && !okOne; n++) {
      var st4 = expectedSpec(r4.profile, chords[n].note);
      if (st4 && st4.code === pr4.code && !!st4.ctrl === pr4.ctrl && !!st4.shift === pr4.shift) okOne = true;
    }
    if (!okOne) bad4++;
  }
  check(bad4 === 0, "chords: every press matches a note's expected key+modifiers (" + bad4 + " wrong)");
  // Chord 1 = A0 (Ctrl+1), C4 (plain t = code 17), C8 (Ctrl+j). Strict pitch
  // order would cost 3 modifier events, so the engine plays the two Ctrl notes
  // as one run (lowest first) and the plain note as another: 2 events.
  var c1 = r4.rec.presses.slice(0, 3).map(function(x) { return x.code + (x.ctrl ? "C" : "") + (x.shift ? "S" : ""); }).join(",");
  check(c1 === "18C,38C,17" || c1 === "18C,17,38C", "chord 1 order sensible (got " + c1 + ")");
  var chord1ModEvents = r4.rec.events.filter(function(e) { return e.code === 59 && e.t <= r4.rec.presses[2].t; }).length;
  check(chord1ModEvents <= 2, "chord 1 costs at most 2 Ctrl events (got " + chord1ModEvents + ")");
  var chordSpan = r4.rec.presses[2].t - r4.rec.presses[0].t;
  check(chordSpan < 0.05, "chord 1 pressed within 50ms (took " + (chordSpan * 1000).toFixed(1) + "ms)");
  check(Object.keys(r4.rec.down).length === 0 && !r4.rec.shift && !r4.rec.ctrl, "chords: clean at the end");

  // ---- test 6: Option as the modifier ------------------------------------
  var r5 = play(song([[0, [21], 240], [480, [108], 240]]), cfgFor("extended", "us", "alt"));
  check(r5.rec.presses.length === 2 && r5.rec.presses[0].alt && !r5.rec.presses[0].ctrl && r5.rec.presses[1].alt, "Option modifier: both extended notes sent with Option (code 58)");
  check(r5.built.schedule.modifierKeyCode === 58, "schedule carries modifierKeyCode 58 for Option");

  // ---- test 7: event key labels & preview -------------------------------
  var ev0 = r2.built.schedule.events[0];
  check(ev0.keyCtrl === true && ev0.keyLabel === "Ctrl+1" && ev0.playedMIDINote === 21 && ev0.sourceMIDINote === 21, "event for A0: keyCtrl, label Ctrl+1, played A0 (got " + JSON.stringify(ev0) + ")");
  var preview = schedulePreviewText(r2.built.schedule, 4);
  check(preview.indexOf("[Ctrl+1]") >= 0 && preview.indexOf("+ctrl") >= 0, "schedule preview mentions Ctrl (" + preview + ")");

  // ---- test 8: smart mode still works with the anchor ---------------------
  var smartCfg = cfgFor("extended", "us"); smartCfg.noteRecognitionMode = "smart";
  var highSong = song([[0, [110, 114, 117], 240], [480, [121], 240]]);
  var prof8 = resolveKeyboardProfile(smartCfg);
  var an8 = analyzeNotes(highSong, prof8, smartCfg.baseMIDINote, "smart");
  // Smart best fit prefers octave-preserving shifts (same key, notes an octave
  // off) over arbitrary semitone shifts, exactly as on the classic piano. Here
  // the highest octave-safe base still leaves the top note out, so 3 of 4 map.
  check(an8.detectedBase !== 36 && ((an8.detectedBase - 36) % 12) === 0 && an8.detectedMapped >= 3, "smart best fit shifts the base by whole octaves on the extended piano (base " + an8.detectedBase + ", mapped " + an8.detectedMapped + ")");
  var pc8 = clone(smartCfg); pc8.baseMIDINote = an8.detectedBase; pc8.savedBaseMIDINote = an8.savedBase;
  var b8 = buildSchedule(highSong, [], 480, pc8, prof8);
  check(b8.mapped === an8.detectedMapped, "smart: the schedule maps what the analysis promised (got " + b8.mapped + " vs " + an8.detectedMapped + ")");
  var cls8 = analyzeNotes(highSong, resolveKeyboardProfile(cfgFor("classic", "us")), 36, "smart");
  check(cls8.detectedMapped === an8.detectedMapped && ((cls8.detectedBase - 36) % 12) === 0, "smart: the classic piano reaches the same octave-safe result (base " + cls8.detectedBase + ", mapped " + cls8.detectedMapped + ")");

  // ---- test 9: analysis ranges --------------------------------------------
  check(r2.analysis.instrumentLow === 21 && r2.analysis.instrumentHigh === 108 && r2.analysis.detectedBase === 36, "extended analysis: instrument A0..C8, base stays C2");
  check(r1.analysis.instrumentLow === 36 && r1.analysis.instrumentHigh === 96, "classic analysis: instrument C2..C7");

  // ---- test 10: sanitizeConfig ---------------------------------------------
  var sc = sanitizeConfig({ keyboardMode: "88", extendedModifier: "option", uiLanguage: "fr-CA", openLiveLogWindow: 1 });
  check(sc.keyboardMode === "extended" && sc.extendedModifier === "alt" && sc.uiLanguage === "fr" && sc.openLiveLogWindow === true, "sanitizeConfig normalises the new keys");
  var sc2 = sanitizeConfig({ keyboardProfile: "custom", keyLayout: "abc", keyboardMode: "extended" });
  check(sc2.keyboardMode === "classic", "custom layouts are forced to classic mode");
  var sc3 = sanitizeConfig(JSON.parse('{"baseMIDINote":36,"keyboardProfile":"azerty","keyLayout":"&é\\"\'(-è_çàazertyuiopqsdfghjklwxcvbn,","startDelaySeconds":0.5,"speed":1.1,"noteRecognitionMode":"perfect","mappingModel":"max61","keySendMethod":"quartz"}'));
  check(sc3.keyboardMode === "classic" && sc3.keyboardProfile === "azerty" && sc3.speed === 1.1 && sc3.extendedModifier === "ctrl", "a v1.8 config file loads unchanged, mode defaults to classic");
  check(sanitizeConfig({}).liveKeys === true && sanitizeConfig({ liveKeys: false }).liveKeys === false, "liveKeys defaults to on and can be turned off");

  // ---- test 11-16: live speed and pause (v2.1.0) ---------------------------
  // The control file is replaced by a script of changes on the virtual clock:
  // [{ at: secondsAfterStart, speed, paused, jobId }]. The worker polls it.
  var controlScript = [];
  var runStart = 0;
  readPlaybackControl = function() {
    var current = null;
    for (var cs = 0; cs < controlScript.length; cs++) {
      if (clock - runStart >= controlScript[cs].at) current = controlScript[cs];
    }
    if (!current) return { jobId: "h", speed: 1, paused: false };
    return { jobId: current.jobId || "h", speed: current.speed, paused: !!current.paused };
  };
  function playLive(notes, script) {
    controlScript = script || [];
    var cfg = cfgFor("classic", "us");
    var profile = resolveKeyboardProfile(cfg);
    var pc = clone(cfg);
    pc.savedBaseMIDINote = 36;
    var built = buildSchedule(notes, [], 480, pc, profile);
    recorder = makeRecorder();
    clock = 100;
    runStart = clock;
    performPlaybackToPid(built.schedule, 4242, "/tmp/harness", { jobId: "h" });
    return { built: built, rec: recorder };
  }
  function pressTimes(rec) { return rec.presses.map(function(x) { return x.t - runStart; }); }
  function near(a, b, tol) { return Math.abs(a - b) <= tol; }

  // 11: eighth notes every 0.25 s; at 2.1 s the speed doubles.
  var steady = [];
  for (var sn = 0; sn < 24; sn++) steady.push([sn * 240, [60 + (sn % 5)], 120]);
  var r11 = playLive(song(steady), [{ at: 2.1, speed: 2 }]);
  var t11 = pressTimes(r11.rec);
  check(t11.length === 24, "speed x2: all 24 notes played (got " + t11.length + ")");
  var gapsBefore = [], gapsAfter = [];
  for (var g11 = 1; g11 < t11.length; g11++) {
    var gap = t11[g11] - t11[g11 - 1];
    if (t11[g11] < 2.1) gapsBefore.push(gap);
    else if (t11[g11 - 1] > 2.2) gapsAfter.push(gap);
  }
  check(gapsBefore.length >= 6 && gapsBefore.every(function(x) { return near(x, 0.25, 0.01); }), "speed x2: notes 0.25 s apart before the change (" + gapsBefore.map(function(x) { return x.toFixed(3); }).join(",") + ")");
  check(gapsAfter.length >= 10 && gapsAfter.every(function(x) { return near(x, 0.125, 0.01); }), "speed x2: notes 0.125 s apart after the change (" + gapsAfter.map(function(x) { return x.toFixed(3); }).join(",") + ")");
  var minGap11 = 1;
  for (var m11 = 1; m11 < t11.length; m11++) minGap11 = Math.min(minGap11, t11[m11] - t11[m11 - 1]);
  check(minGap11 > 0.11, "speed x2: no rushed burst at the change (smallest gap " + minGap11.toFixed(3) + " s)");
  // The 9th note (index 8) is due at 2.0 s; the change at 2.1 s is half way to
  // the 10th (2.25 s at 1x), so it now lands at 2.1 + 0.15/2 = 2.175 s.
  check(near(t11[9], 2.175, 0.03), "speed x2: the note after the change lands at 2.175 s (got " + t11[9].toFixed(3) + ")");

  // 12: slowing down to half speed.
  var r12 = playLive(song(steady), [{ at: 1.05, speed: 0.5 }]);
  var t12 = pressTimes(r12.rec);
  var late12 = [];
  for (var g12 = 6; g12 < t12.length; g12++) late12.push(t12[g12] - t12[g12 - 1]);
  check(late12.every(function(x) { return near(x, 0.5, 0.01); }), "speed x0.5: notes 0.5 s apart after the change (" + late12.slice(0, 5).map(function(x) { return x.toFixed(3); }).join(",") + "…)");

  // 13: pause at 1.1 s for 3 s, then resume at the same speed.
  var r13 = playLive(song(steady), [{ at: 1.1, speed: 1, paused: true }, { at: 4.1, speed: 1, paused: false }]);
  var t13 = pressTimes(r13.rec);
  check(t13.length === 24, "pause: all 24 notes played (got " + t13.length + ")");
  // Notes 0..4 play before the pause (0 .. 1.0 s); the 6th note was due at
  // 1.25 s, i.e. 0.15 s after the pause began, so it plays 0.15 s after resume.
  check(near(t13[4], 1.0, 0.01) && near(t13[5], 4.25, 0.06), "pause: playback stops at 1.1 s and picks up where it left off (note 6 at " + t13[5].toFixed(3) + " s)");
  var held13 = r13.rec.events.filter(function(e) { return e.t - runStart > 1.2 && e.t - runStart < 4.0 && e.down; }).length;
  check(held13 === 0, "pause: no key pressed during the pause (" + held13 + ")");
  var upsBeforeResume = r13.rec.events.filter(function(e) { return !e.down && e.t - runStart <= 1.2; }).length;
  check(upsBeforeResume >= 5, "pause: every key is let go when the pause starts (" + upsBeforeResume + " key-ups)");
  var gaps13 = [];
  for (var g13 = 7; g13 < t13.length; g13++) gaps13.push(t13[g13] - t13[g13 - 1]);
  check(gaps13.every(function(x) { return near(x, 0.25, 0.01); }), "pause: normal spacing after resuming");

  // 14: a speed change during a long rest moves the next note right away.
  var rest = song([[0, [60], 120], [3840, [62], 120]]);   // second note at 4 s
  var r14 = playLive(rest, [{ at: 1.0, speed: 2 }]);
  var t14 = pressTimes(r14.rec);
  check(t14.length === 2 && near(t14[1], 2.5, 0.06), "rest: speed x2 at 1 s brings the 4 s note to 2.5 s (got " + (t14[1] || 0).toFixed(3) + ")");

  // 15: hold lengths follow the speed.
  var longNotes = song([[0, [60], 960], [1920, [64], 960]]);   // 1 s notes, 2 s apart
  var r15 = playLive(longNotes, [{ at: 0.5, speed: 2 }]);
  var downs15 = r15.rec.events.filter(function(e) { return e.code === 17 && e.down; });   // key "t" = C4 on key 1 = C2
  var ups15 = r15.rec.events.filter(function(e) { return e.code === 17 && !e.down; });
  check(downs15.length === 1 && ups15.length === 1 && near(ups15[0].t - downs15[0].t, 1.0, 0.06), "hold: a note pressed at 1x is held for its 1 s length (" + (ups15.length ? (ups15[0].t - downs15[0].t).toFixed(3) : "?") + ")");
  var secondDown = r15.rec.events.filter(function(e) { return e.down && e.code !== 17 && e.code !== 56; })[0];
  var secondUp = secondDown ? r15.rec.events.filter(function(e) { return !e.down && e.code === secondDown.code && e.t > secondDown.t; })[0] : null;
  check(secondDown && secondUp && near(secondUp.t - secondDown.t, 0.5, 0.06), "hold: a 1 s note pressed at 2x is held 0.5 s (" + (secondUp ? (secondUp.t - secondDown.t).toFixed(3) : "?") + ")");
  check(Object.keys(r15.rec.down).length === 0, "hold: nothing left down at the end");

  // 16: a control file left by another job is ignored.
  var r16 = playLive(song(steady), [{ at: 0.5, speed: 2, jobId: "other" }]);
  var t16 = pressTimes(r16.rec);
  check(near(t16[23], 23 * 0.25, 0.02), "foreign control file ignored (last note at " + t16[23].toFixed(3) + " s)");

  // 17: Pause while the last note rings: let go there and finish.
  var lastNote = song([[0, [60], 1920]]);   // one 2 s note
  var r17 = playLive(lastNote, [{ at: 0.5, speed: 1, paused: true }]);
  var up17 = r17.rec.events.filter(function(e) { return e.code === 17 && !e.down; });
  check(up17.length === 1 && near(up17[0].t - runStart, 0.5, 0.15), "pause during the final ring lets go at once (" + (up17.length ? (up17[0].t - runStart).toFixed(3) : "?") + " s)");

  // 18: the worker writes its own pid in the state, so the window never
  // rewrites the file under it.
  var savedStates = [];
  savePlaybackState = function(dir, st) { savedStates.push(st); };
  playLive(song([[0, [60], 120], [480, [62], 120]]), []);
  savePlaybackState = function() {};
  var ownPid = currentProcessId();
  check(savedStates.length > 0 && savedStates.every(function(x) { return x.pid === ownPid && ownPid > 0; }), "playing states carry the worker's pid (" + (savedStates[0] && savedStates[0].pid) + " vs " + ownPid + ")");

  // 19: one speed range everywhere.
  check(sanitizeConfig({ speed: 3 }).speed === SPEED_MAX && sanitizeConfig({ speed: 0.1 }).speed === SPEED_MIN && sanitizeConfig({ speed: 0 }).speed === 1, "config speed clamped to " + SPEED_MIN + "-" + SPEED_MAX);

  var out = ["Engine harness: " + (failures.length === 0 ? "ALL CHECKS PASSED" : failures.length + " FAILURE(S)")];
  for (var f = 0; f < failures.length; f++) out.push("  FAIL: " + failures[f]);
  out.push("  sweep timeline: first press t=" + (r3.rec.presses[0].t - 100).toFixed(3) + "s, last press t=" + (r3.rec.presses[87].t - 100).toFixed(3) + "s (scheduled 0.000 .. " + ((87 * 120) / 480 * 0.5).toFixed(3) + "s)");
  out.push("  extended modifier events in sweep: " + r3.rec.events.filter(function(e) { return e.code === 59; }).length + " (down+up)");
  out.push("  live speed x2 at 2.1s: notes at " + t11.slice(6, 13).map(function(x) { return x.toFixed(3); }).join(", ") + " s");
  out.push("  pause 1.1s-4.1s: notes at " + t13.slice(3, 8).map(function(x) { return x.toFixed(3); }).join(", ") + " s");
  out.push("  speed x2 during a rest: second note at " + t14[1].toFixed(3) + " s (was 4.000)");
  return out.join("\n");
}
