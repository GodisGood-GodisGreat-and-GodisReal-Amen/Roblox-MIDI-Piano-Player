# How Roblox MIDI Piano Player works

A map of the code for anyone who wants to change it.

## The shape of it

```
Roblox MIDI Piano Player.app
  Contents/MacOS/RobloxMidiPianoPlayer   shell launcher: exec osascript main.js
  Contents/Resources/main.js             the whole app (src/main.js, compacted)

  osascript main.js                              osascript main.js --worker job.json
 ┌──────────────────────────────────┐   JSON    ┌──────────────────────────────────┐
 │ the window (mainWindowUI)        │   files   │ the background player            │
 │ songs, mapping, piano picture,   │ ◄───────► │ (workerMain)                     │
 │ settings, speed, pause, stop     │           │ waits for Roblox, then plays     │
 └───────────────┬──────────────────┘           └────────────────┬─────────────────┘
                 │ live keys                                     │ every chord
                 ▼                                               ▼
          key events to the Roblox process (CGEventPostToPid, or Accessibility)
```

Two rules shape everything:

1. **Only key presses are on the time-critical path.** A key press is sent at its note's instant; the matching key release waits for a quiet moment between notes, within a budget, so it can never push a note late. When a big chord does run late, the whole rest of the song shifts by the overrun instead of rushing to catch up: the pulse stays steady, a few milliseconds later.
2. **Nothing may stay pressed in Roblox.** Every key sent down, by the player or by live keys, is tracked and let go on every way out: the end of a song, Stop, Pause, an error, the window losing focus, ⌘, an open menu, quitting.

## One file, two processes

`src/main.js` is the whole app, a JavaScript for Automation (JXA) script. The bundle holds a compact copy of it, made by `tools/minify.js`: comments, indentation and blank lines removed (a quarter smaller), the line breaks between tokens kept so that JavaScript reads it exactly as the source, and the result checked token by token before it is written. The bundle's launcher sets `ROBLOX_MIDI_PLAYER_EXECUTABLE` and starts it with `osascript`, natively on Apple silicon (`arch -arm64`): LaunchServices would otherwise start a script bundle under Rosetta, where JXA's Objective-C subclassing hangs.

`run(argv)` picks the role:

| Arguments | Role |
| --- | --- |
| none, or `--midi FILE` | the window (`mainWindowUI`) |
| `--worker JOB` | the background player (`workerMain`) |
| `--dialogs` | the older dialog-based flow (`main`); also the fallback when the window cannot be built |
| `--selftest-senders [background]` | plays a phrase into Roblox with each key sender (`selfTestSenders`) |
| `--uninstall [--yes] [--now]` | lists, then removes, every version of the app (`uninstallFromCommandLine`) |
| `--ui-selftest MIDI PREFIX [arm]` | the window's self test (`uiRunSelfTest`) |

The player is a process of its own because osascript has one thread: the window's event loop and a loop that must press a key within a millisecond of its time cannot share it. It also lets a song carry on when the window closes. **Arm playback** (`armBackgroundPlayback`) writes the song, already mapped to keys, to `playback_job_<id>.json`, writes a small launch script, and starts it with `nohup`. The script `exec`s osascript, so the process number it reports is the player itself and Stop can signal it.

## Reading a MIDI file

`parseMIDIFile` reads formats 0, 1 and 2 with any number of tracks: running status, tempo changes, system exclusive and meta events. Each note-on is paired with the oldest open note-on of the same channel and pitch (a queue, because a pitch is often struck again before it is released), which gives every note its real length. Notes on channel 10, the drums, are left out when the file has other notes. Files timed in SMPTE frames are refused with a clear message.

`annotateTempoSeconds` and `tickToSeconds` turn ticks into seconds through the tempo map, so tempo changes inside a song are followed. `tickToSeconds` finds the tempo in force with a binary search: performances recorded with rubato can carry thousands of tempo changes, and a scan of all of them for every note made such a song take a second to prepare.

## Mapping notes to keys

A **keyboard profile** (`makeMaxKeyboardProfile`) lists every key of a Roblox piano in semitone order. Each step knows its macOS key code, whether it needs Shift (the classic black keys) or Ctrl (the dotted keys of the 88-key piano), its label, its zone (`low`, `main`, `high`) and whether it is black. The classic piano has 61 steps; the extended one adds 15 below and 12 above, and `anchorIndex` (0 or 15) says where key `1` is. US QWERTY and French AZERTY profiles have the same key codes, the physical positions, and differ only in their labels. A legacy custom layout is a string of characters, one per semitone, turned into key codes by `layoutCharSpec`.

The saved **Note of key 1** (C2 = 36 by default) is the note of key `1` in both modes. `analyzeNotes` and `detectBaseNote` choose where the song sits on the piano: *Perfect* keeps that base; *Smart best fit* tries octave shifts first and arbitrary semitone shifts only if none fits, keeping the base when a shift would gain almost nothing. `buildSchedule` then turns every note into an event: its time and length in seconds at the chosen speed, its key code and modifiers, its label, and the note it came from. Notes outside the piano are counted, not moved.

## The background player

`workerMain` writes its state to `playback_state.json` at every step: `waiting` (for Roblox), `delay` (the after-click delay), `playing`, then `finished`, `stopped` or `error`. `waitForRobloxFrontmost` looks at the front app every 50 ms, reading its details only when another app comes to the front, and starts once a Roblox app has stayed in front for 0.15 s. From then on the keys go to that process by its id, so the user may switch apps.

### The timing loop

`performPlaybackToPid` walks the events chord by chord. Notes within 6 ms of each other are one chord. Before waiting for a chord, it prepares everything: the keys, their modifiers and which keys the chord is about to press again. `waitForOnset` then sleeps in shrinking steps until the chord's instant. While it waits it:

- checks the stop file every 50 ms and the control file every 100 ms;
- lets go of keys whose notes have ended, but only as many as fit before the next note (at least 30 ms ahead, at most six per gap, with the cost of a key event measured as the song plays);
- lets go early of a key the next chord strikes again, so the release is not paid inside the chord.

`createKeyController` holds the state of the keyboard: the keys down, with when each should be let go, and whether Shift and Ctrl are down. A chord is pressed from its lowest note up, like a pianist spreading it; if that order would cost more than two Shift or Ctrl changes, the chord is pressed as one run per modifier instead. Modifiers change only when the next key needs it, and are always released before pressing.

When a chord makes the next note late by more than 10 ms, the rest of the song shifts by the overrun (the *slip*). A rest longer than 0.3 s gives back up to a quarter of its length, at most 120 ms, until the slip is repaid. A key is held for its note's written length, between 50 ms and 2.5 s (140 ms when the file gives none); a key overdue by 1.5 s is let go even in a passage with no gap. The last notes ring for their length before the player ends.

| Constant | Value | What it is |
| --- | --- | --- |
| `CHORD_EPSILON_SECONDS` | 0.006 | notes this close are one chord |
| `MIN_HOLD_SECONDS`, `MAX_HOLD_SECONDS`, `DEFAULT_HOLD_SECONDS` | 0.05, 2.5, 0.14 | bounds of a key's hold |
| `RELEASE_SLACK_SECONDS`, `MAX_RELEASES_PER_GAP` | 0.03, 6 | the release budget |
| `FORCE_RELEASE_AFTER_SECONDS` | 1.5 | the safety valve for keys that never get a gap |
| `SLIP_TRIGGER_SECONDS`, `SLIP_REST_SECONDS`, `SLIP_RECOVER_FRACTION`, `SLIP_RECOVER_MAX_SECONDS` | 0.01, 0.3, 0.25, 0.12 | when the song shifts, and how it catches up in rests |
| `MAX_CHORD_SHIFT_TOGGLES` | 2 | modifier changes allowed to keep a chord in pitch order |
| `STOP_CHECK_INTERVAL_SECONDS`, `CONTROL_POLL_SECONDS` | 0.05, 0.1 | how often the stop and control files are read |

### Live speed and pause

The window writes `playback_control.json` (`{ jobId, speed, paused }`) whenever the speed or the pause changes; the player reads it at most ten times a second and ignores a file meant for another song (`createLiveControl`). Time runs through `createPlaybackTimeline`: a song position (in seconds of the schedule) maps to a wall-clock time through an anchor pair, a rate (the requested speed divided by the speed the song was armed at) and the slip. A speed change re-anchors the timeline at the current position, so the music carries on from the note it was at. A pause lets go of every key, waits (still watching the stop file), and re-anchors at the same position on resume. Key lengths are worked out when a chord is pressed, at the speed in force.

The player reports its position and the song's length in seconds of the song at 1×, its speed and whether it is paused. It writes the state about once a second, with its own process id, so the window never needs to rewrite the file. Between two reports the window moves the clock on by itself.

### Sending keys

`createDirectKeySender` sends key events to one process id:

- **Quartz** (`createCGKeySender`): `CGEventCreateKeyboardEvent` and `CGEventPostToPid`, about 2 ms per key. It reaches Roblox in front and in the background.
- **Accessibility** (`createAXKeySender`): `AXUIElementPostKeyboardEvent`, 12–17 ms per key, because it waits for Roblox to handle each event.

*Automatic* starts with Quartz and keeps Accessibility ready: if a send fails mid-song, the sender switches to the other one by itself. Shift (56), Control (59) and Option (58) are sent as key events of their own.

## The window

`mainWindowUI` builds the whole interface with AppKit from JavaScript, without a nib: `uiBuildWindow` lists every view with its place, `uiApplyStrings` fills in the text from `UI_STRINGS` (English and French, through `T(key, vars)`). Objective-C classes made with `ObjC.registerSubclass`:

| Class | What it does |
| --- | --- |
| `RMPPController` | the target of every control (one action, `uiAction:`, dispatched by the control's tag), the timer, the app's and the window's delegate |
| `RMPPWindow` | the window; its `sendEvent:` sees every key first and hands piano keys to live keys |
| `RMPPPianoView` | the piano picture; mouse down, drag and up press keys |
| `RMPPDropView` | the window's content view; accepts dropped MIDI files |

A timer reads the player's state 4 times a second while a song is armed or playing and once a second otherwise, with some leeway so that macOS can group its wake-ups; it re-checks the Accessibility permission every 2 s while it is missing and every 10 s once given. When a song loads or a setting changes, the current mode gets a full schedule, and the other mode only its note count, summed from the song's note counts (`uiCountPlayable`), which is all the window shows of it. The piano picture is drawn into a bitmap at twice the screen resolution (`renderPianoPicture`); `pianoLayout` gives the same geometry to the drawing and to mouse clicks, and pressed keys are small coloured boxes inside the picture's view, so the picture is not redrawn for every key. Every setting is saved to `config.json` as it changes, through `sanitizeConfig`, which also brings any value back into range.

## Live keys

`liveHandleKeyEvent` decides what happens to each key event the window gets. A key goes to Roblox only if it is one of the current piano's keys or Space, Command is not held, and no text field is being edited; auto-repeat is ignored. Modifiers are sent with the key that needs them, and let go when released on the keyboard. `liveMouse` does the same for the piano picture, with a glide from key to key. The global `LIVE` remembers every key sent down and the modifier state; `liveReleaseAll` lets go of all of it when the window resigns key, when ⌘ is pressed (AppKit stops delivering key-ups then), when a menu opens (menus take the key-ups), when live keys are turned off, and when the app quits. `liveSender` builds a sender with the same method as the player once it has found Roblox, from the cheapest way to the dearest: macOS reports every app that opens (`uiAppLaunched`, an `NSWorkspace` notification), the Roblox player is asked for by its bundle identifier every 1.5 s, and every running app is read (about 40 ms) only at the first lookup, when forced, or when an app opened that macOS did not describe.

## Files in the config folder

The window and the player share `~/Library/Application Support/Roblox MIDI Piano Player/` (or `ROBLOX_MIDI_PLAYER_SUPPORT_DIR`). The JSON files are written atomically, so a reader never sees half a file.

| File | Written by | Read by | Contents |
| --- | --- | --- | --- |
| `config.json` | the window | the window | the settings |
| `playback_job_<id>.json` | the window | the player | the song, mapped to keys, with its id, name and language; every note packed as one short array (`packSchedule`, `unpackSchedule`), times to the microsecond |
| `launch_playback_worker.sh` | the window | `nohup` | starts the player |
| `playback.pid` | the window | both | the player's process id |
| `playback_state.json` | the player (and the window when it starts or stops one) | the window | status, position, length, speed, pause, notes sent |
| `playback_control.json` | the window | the player | the speed and pause wanted for one job id |
| `playback.stop` | the window | the player | Stop; the player checks for it 20 times a second |
| `playback.log` | both | you | each step, in plain words |

## The uninstaller

`uninstallPlan` lists what there is to remove, by kind, and `uninstallRun` removes it.

| Kind | How it is found |
| --- | --- |
| `app` | a bundle with one of the app's identifiers (`APP_BUNDLE_IDS`: the current one, and the one versions 1.0 to 2.0 used), or whose name, letters and digits only, starts with `robloxmidipianoplayer`. Looked for at the top of Applications, ~/Applications, Downloads, Desktop and Documents (and inside a folder named like the app), and anywhere through Spotlight and Launch Services. Spotlight alone is not enough: it can miss recent copies. |
| `zip` | an archive whose name starts the same way, in the same places and through Spotlight |
| `source` | a folder holding `RobloxMIDIPianoPlayer.swift`, the very first version's source, and nothing but its known files |
| `settings` | the settings folder |
| `leftover` | the preferences file, saved window state, caches and web storage macOS keeps under the app's identifiers |

The running copy is listed last. `uninstallRun` stops a song that is playing, ends the other running copies (by the script they run), moves each item to the Trash (`trashItemAtURL…`) or deletes it, deletes the preference domains, resets the Accessibility permission of both identifiers with `tccutil`, then sets `UNINSTALLED`, after which nothing writes the settings folder again. Only items of these kinds are touched: a folder named like the app keeps everything but the copies inside it, and goes too only once nothing else is left in it (a `.DS_Store` aside). With `ROBLOX_MIDI_PLAYER_UNINSTALL_ROOTS` set (folders separated by colons), only those folders and the settings folder are looked at, and nothing outside them is changed: the tests use it.

## Permissions, safety and privacy

- macOS lets an app post key events to other apps only with the **Accessibility** permission. `AXIsProcessTrusted` tells the window whether it has it; **Allow…** asks macOS to list the app and opens the settings page.
- Key events are always aimed at one process: the Roblox player, found by its bundle identifier, name or path (`isRobloxApplicationInfo`), never the app itself. Nothing is typed into whatever app happens to be in front.
- Live keys pass on only the piano's keys and Space, never `/`, Escape, Return, Tab, the arrows or ⌘ shortcuts, and never while you type in a field.
- The app makes no network connection. The Help menu and **About** open web pages in your browser when you ask for them.

## Notes on JavaScript for Automation

Things worth knowing before changing the code:

- A JavaScript `null` passed where Objective-C expects an object becomes `NSNull`, not `nil`: `makeFirstResponder(null)` throws and `convertPoint:fromView:null` crashes. Pass `$()` for `nil`. (`null` is fine for an `NSError **` out-parameter or an ignored sender.)
- Objective-C methods without arguments are properties: `window.close`, `timer.invalidate`, `path.fill`. Adding `()` throws.
- `ObjC.registerSubclass` cannot override methods that take structures (`drawRect:`, `hitTest:`), but `sendEvent:`, `mouseDown:` and `acceptsFirstMouse:` work, and `ObjC.super(this).sendEvent(event)` calls the original.
- Never `CFRelease` an object returned by a *Create* function: the bridge owns it already, and the double release crashes the process.
- AppKit puts the cursor in the first text field when a window opens; the window drops it at once, or the piano keys would type into the field.
- `cacheDisplayInRect` and `dataWithPDFInsideRect` draw controls without their text; the self test captures the real window with `screencapture -l` instead.
- AppKit hands `application:openFile:` every path on the command line while it launches, `main.js` itself included; only `.mid` files are taken, and nothing may open an alert before launching ends.

## Measured

| | |
| --- | --- |
| One key event with Quartz | about 2 ms |
| One key event with Accessibility | 12–17 ms |
| A ten-note chord with Quartz | about 20 ms |
| Spacing of notes in `tools/realtime_test.sh` | median within 1 ms of the schedule, before and after a speed change |
| A speed change or a pause, from the click to the music | within 0.1 s |
| The window, idle, live keys on, Roblox closed (`--ui-selftest … idle`) | 0.5 % of one CPU core (2.1: 5.6 %) |
| Looking for Roblox, regular check / full scan | 0.06 ms / about 45 ms (2.1: a full scan every 1.5 s) |
| Mapping a 12,000-note song with 3,000 tempo changes, and counting the other mode | about 10 ms (2.1: about 1 s) |
| The job file of that song | 523 KB (2.1: 3.4 MB) |
| Drawing the piano picture | 28 ms (2.1: 37 ms) |
| The app / the release zip | 509 KB / 322 KB (2.1.1: 694 KB / 459 KB) |
