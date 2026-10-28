# Contributing

Thanks for looking under the hood. Roblox MIDI Piano Player is small on purpose: one JavaScript for Automation script, a shell launcher, no build step beyond copying files and making a compact copy of the script, and no dependencies. Keep it that way where you can.

## Building from source

```bash
git clone https://github.com/GodisGood-GodisGreat-and-GodisReal-Amen/Roblox-MIDI-Piano-Player.git
cd Roblox-MIDI-Piano-Player
./build.sh --install
```

[Building it yourself](docs/building.md) covers the build, the four tests and making a release.

## Layout

| File | What it is |
| --- | --- |
| `src/main.js` | the whole app: the window, the background player and its timing engine, the key senders, the key maps, the MIDI parser, the uninstaller, the self test |
| `app/RobloxMidiPianoPlayer` | the launcher: starts `main.js` with `osascript`, natively on Apple silicon |
| `app/Info.plist`, `app/AppIcon.icns`, `app/README.txt` | the bundle's property list, icon and short guide |
| `build.sh` | assembles the app; `--install` puts it in `/Applications`, `--zip` makes the release file, `--readable` keeps the script as it is |
| `tools/minify.js` | makes the compact copy of `src/main.js` that goes in the app, and checks it token by token |
| `docs/demo/` | the demo songs of **File › Demo Songs**, written by `tools/genmidi.py` |
| `tools/engine_harness.js` | the engine tests on a virtual clock |
| `tools/realtime_test.sh`, `tools/realtime_test.js`, `tools/key_receiver.js` | the real-time test: the real engine plays into a small test app |
| `tools/genmidi.py` | the test MIDI files and the demo songs |
| `tools/make_icon.js` | draws the icon |
| `tools/shrink_icns.py`, `tools/optimize_png.py` | recompress the icon and the pictures without changing a pixel |
| `.github/workflows/check.yml` | the CI check |

[How it works](docs/architecture.md) explains the code.

## Conventions

- **Plain JavaScript for Automation, one file.** The app must run on the `osascript` that ships with macOS 10.15 and later: no modules, no transpiling, `var` and function declarations as in the rest of the file. Mind the bridge's habits listed in [How it works](docs/architecture.md#notes-on-javascript-for-automation), above all `$()` rather than `null` for `nil`.
- **Only key presses on the time-critical path.** Anything new in the playback loop must stay out of the way of the next note: do the work before the wait, or in the gaps, within a budget.
- **Nothing may stay pressed in Roblox.** Every key sent down must be tracked and let go on every way out.
- **Every word in the window is in `UI_STRINGS`, in English and in French**, and the worker's notifications in `WORKER_STRINGS`. Write in the user's terms, in plain words.
- **Settings go through `sanitizeConfig`**, which gives every value a default and brings it back into range, so an old or hand-edited `config.json` always loads.
- **Comments say why, in plain words.** The code reads like a description of what happens on purpose; keep that voice.
- **Write the source for people; the build makes it small.** The app carries a copy of `src/main.js` without comments or indentation, so comments cost nothing: keep them. Run the engine harness on the built copy as well as on the source (see [Building it yourself](docs/building.md#4-testing)).
- **Light when idle.** The window's timer slows down when nothing is playing, and Roblox is looked for by its bundle identifier, not by reading every running app. Anything new in the timer or the live-keys path must keep the idle window under 1 % of a CPU core (`--ui-selftest … idle` measures it).
- **Raise `APP_VERSION`** in `src/main.js` and the versions in `app/Info.plist` with every release; `build.sh` checks that they match.
- Match the existing style: two-space indent, double quotes for text (single quotes for selectors such as `'uiAction:'`), semicolons, `camelCase` functions with a prefix for each part (`ui…` for the window, `live…` for live keys, `worker…` for the player).

## Debugging

- **Open log** in the window (`playback.log` in the config folder) records each step of a song: the key sender, the app seen in front, every speed change and pause, and, for the first notes and every 128th after, the scheduled and actual time of each chord.
- **Also open the live log (Terminal)** follows that log live while a song plays.
- `playback_state.json` and `playback_control.json` in the config folder show what the player and the window are telling each other.
- `ROBLOX_MIDI_PLAYER_SUPPORT_DIR=/some/folder` gives a test run its own settings and state, and `ROBLOX_MIDI_PLAYER_UNINSTALL_ROOTS=/some/folder` makes the uninstaller look only there.
- `./build.sh --readable` puts the source in the app unchanged, so that a line number in an error message is a line of `src/main.js`.
- The self test's report (`<prefix>_report.json`) lists what each step saw, and the pictures show the window after each step.
- `--dialogs` starts the older dialog flow, handy to tell a problem in the window from a problem in the engine.

## Pull requests

Keep them focused, describe what changed in the user's terms, and add a line to `CHANGELOG.md`. Say how you tested the change: which tests you ran and, for anything that sends keys, whether you heard it on a Roblox piano. Pictures from the self test help for anything visual.

Roblox MIDI Piano Player is public domain under [The Unlicense](LICENSE). By contributing, you dedicate your contribution to the public domain on the same terms.
