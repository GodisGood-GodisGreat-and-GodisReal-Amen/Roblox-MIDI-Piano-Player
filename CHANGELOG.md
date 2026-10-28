# Changelog

## 2.2.0 — 2026-10-28

**Uninstaller.** **Roblox MIDI Piano Player › Uninstall Roblox MIDI Piano Player…** removes the app and everything it ever left on the Mac, so nothing is left when you want the space back: this app and every other copy of any version back to 1.0 (found by both of the app's bundle identifiers and by name, in Applications, Downloads, Desktop and Documents, and wherever Spotlight or macOS knows of one), downloaded archives of it, the folder the first version's source came in, the settings folder with its logs and old song files, the files macOS keeps for the app, and its Accessibility permission. It shows the list with sizes first, **Cancel** is the default, and everything goes to the Trash unless you tick **Delete right away**. A song that is playing is stopped and other open copies are closed first. Only those kinds of item are touched: a folder of yours that holds a copy keeps everything else. From Terminal, `--uninstall` lists, `--uninstall --yes` removes.

**Lighter and faster, with every feature and the same playback.**
- The idle window uses 0.5 % of a CPU core instead of 5.6 %. Its timer runs four times a second only while a song is armed or playing, and once a second otherwise; once the Accessibility permission is given it is checked every 10 s instead of every 2 s; and live keys find Roblox by its bundle identifier, or the moment macOS reports it opened, instead of reading every running app every 1.5 s (46 ms each time).
- Mapping a big song (12,000 notes, 3,000 tempo changes) onto the piano, and counting what the other mode would play, takes about 10 ms instead of about 1 s, with the same results: tempo changes are looked up by halving instead of one by one, and the other mode's count comes from the analysis instead of a second full schedule.
- The job handed to the background player is six times smaller (523 KB instead of 3.4 MB for that song), so arming is quicker.
- The piano picture draws in 28 ms instead of 37 ms, and the armed player's check of the app in front costs a third of what it did.
- The app is 27 % smaller (509 KB instead of 694 KB) and the download 30 % smaller (322 KB instead of 459 KB). The app carries a compact copy of the script, without comments or indentation, checked token by token against the source; `./build.sh --readable` keeps the source as it is. The icon is recompressed without loss: the same 11 sizes, every pixel identical. The documentation's screenshots are recompressed the same way, 40 % smaller, and the two window pictures now show 2.2.0.
- A log backup that older versions left in the settings folder (`playback.log.bak`) is removed at launch, with the old job files.

**Polish.** Alerts show the app's icon instead of a generic one, and the self test also pictures the uninstaller and can measure the idle window (`--ui-selftest MIDI PREFIX idle`). New tests check that the fast paths give exactly the old results, and the CI check runs the engine tests on the compact copy too.

## 2.1.1 — 2026-10-27

- **Demo songs** in **File › Demo Songs**: *Ode to Joy* and *Für Elise* (Beethoven) for the classic piano, and arpeggios across all 88 keys for the extended one. A demo shows its title in the window and in the notifications.
- **Drum tracks are left out.** Notes on MIDI channel 10 are drum sounds, not pitches, and used to come out as stray piano notes. The song's line says how many drum hits were left out; a file whose only notes are on channel 10 still plays.
- **Help menu**: the user manual, getting started and troubleshooting pages, and a link to report a problem.
- The custom-layout dialog speaks the window's language, and the Accessibility hint fits in the window.
- **Documentation**: a getting-started guide, a user manual, a building guide, how it works, troubleshooting, and a contributing guide.
- **Tests**: `tools/realtime_test.sh` plays a song with the real engine into a test app and checks the timing, a speed change and a pause; the engine harness exits with an error when a check fails; a CI check runs the syntax checks, the engine tests and the build on every push.

## 2.1.0 — 2026-10-27

**Live keys.** While the window is in front, the piano keys you press are pressed in Roblox too, and so are the keys you click on the piano picture (drag across it for a glissando). Pressed keys turn blue. Only the piano's own keys and Space are passed on: Escape, Return, Tab, the arrows, `/` (Roblox's chat key) and every ⌘ shortcut keep their normal meaning, and nothing is sent while you type in a text field. Every key sent down is tracked and let go when the window loses focus, when you press ⌘ or open a menu, when live keys are turned off and when the app quits, so no key can stay stuck in Roblox. Turn it on or off with the checkbox or **Playback › Live Keys** (⌘L).

**Live speed and pause.** While a song plays, **−** and **+** (⌘− / ⌘=) change the speed by 0.05× between 0.25× and 2×, the middle button (⌘0) goes back to 1×, and **Pause** (⌘P) holds the song where it is. The player picks the change up within a tenth of a second and re-times the rest of the song from the note that is playing: no jump, no rush to catch up, and held notes keep their written length at the new speed. Pausing lets go of every key.

**Polish.**
- The status card shows the song's position and length (`1:02 / 3:34`), the speed, and a real progress bar; a paused song says so.
- New **Playback** menu with all the shortcuts.
- When macOS has not yet allowed the app to send keys, the window says so and an **Allow…** button opens the right settings page.
- The window opens where you left it.
- No text field takes the keyboard when the window opens, and a field gives the keys back to the piano as soon as its value is entered.
- The last notes of a song ring for their written length instead of being cut off.
- Notifications follow the window's language, and the "starting" ones only appear when the delay is long enough to notice.
- Clearer, shorter settings, with explanations on hover; friendlier messages for unreadable MIDI files.
- Leftover files from interrupted songs are cleaned up at launch.
- `ROBLOX_MIDI_PLAYER_SUPPORT_DIR` can point the app at another settings folder.
- The speed range is 0.25× to 2× everywhere (a saved speed outside it is brought back in).
- A demo song (*Ode to Joy*, Beethoven).

**Open source.** Released into the public domain under the Unlicense, with a build script, tests and documentation.

## 2.0.0 — 2026-09-27

- **One window** instead of a chain of dialogs: pick a song (button, drag and drop, or File › Open), see it on a picture of the Roblox piano, choose the piano, change settings in place (saved automatically), arm playback and follow it live, with Stop.
- **Mode 2: the 88-key piano** (A0–C8): Ctrl + `1` … `t` play the 15 lowest notes and Ctrl + `y` … `j` the 12 highest, the dotted keys of the game. Ctrl is handled like Shift by the engine: pressed only when needed and always let go. Option can replace Ctrl.
- The piano picture shows the keys a song uses (green), the ones it needs but the current mode lacks (orange), and how many notes fall outside.
- Transpose a single song by semitones; English or French window; an app icon.

## 1.8.0 — 2026-08-27

- **Quartz key sending**, about 2 ms per key instead of 12–17 ms with Accessibility, so a ten-note chord takes about 20 ms. Both methods reach Roblox in front and in the background, and the app switches to the other one by itself if a send fails.

## 1.7.x

- Fixed the background player crashing at the end of every song.
- Steady tempo on big chords: only key presses are on the time-critical path, key releases are budgeted into the gaps, and a late chord shifts the rest of the song instead of causing a rushed burst.
- Notes are held for their real MIDI length; chords roll bottom-up; Shift is only toggled when needed; Stop is reliable.
- US QWERTY and French AZERTY profiles on the standard 61-key Roblox map, with *Perfect* mapping (exact notes, out-of-range notes skipped) and *Smart best fit*.
