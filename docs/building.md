# Building it yourself

The app is one JavaScript for Automation script in an ordinary app bundle, so building it means checking the script and putting the files in place. Nothing is compiled, and there are no dependencies.

## 1. Requirements

| What | Why | Check |
| --- | --- | --- |
| **macOS 10.15 or newer** | `osascript`, `osacompile` and the frameworks the app uses come with it | Apple menu › About This Mac |
| **git** | to get the code | `git --version` (macOS offers to install it) |
| **Python 3** (for the tests only) | writes the test and demo MIDI files, and checks the real-time test | `python3 --version` |

## 2. One command

```bash
git clone https://github.com/GodisGood-GodisGreat-and-GodisReal-Amen/Roblox-MIDI-Piano-Player.git
cd Roblox-MIDI-Piano-Player
./build.sh
```

`build.sh` checks that the version in `src/main.js` matches `app/Info.plist`, checks the script's syntax with `osacompile`, and assembles `build/Roblox MIDI Piano Player.app`. The app gets a compact copy of the script, made by `tools/minify.js`: no comments, no indentation, no blank lines, a quarter smaller. The line breaks between statements stay, so JavaScript reads the copy exactly as it reads the source, and `minify.js` reads its own result back and stops the build unless every token, and every line break before one, is the same as in the source. The copy is checked with `osacompile` too.

| In the bundle | From |
| --- | --- |
| `Contents/Info.plist` | `app/Info.plist` |
| `Contents/MacOS/RobloxMidiPianoPlayer` | `app/RobloxMidiPianoPlayer`, the launcher |
| `Contents/Resources/main.js` | `src/main.js`, the whole app, in its compact form |
| `Contents/Resources/AppIcon.icns`, `README.txt` | `app/` |
| `Contents/Resources/demo/*.mid` | `docs/demo/`, the songs of **File › Demo Songs** |

Options:

- `./build.sh --install` puts the app in `/Applications`. When it is already there, the files inside it are updated rather than the bundle replaced, so macOS keeps its Accessibility permission.
- `./build.sh --zip` makes `build/Roblox-MIDI-Piano-Player-<version>.zip`, the file attached to a release.
- `./build.sh --readable` puts `src/main.js` in the app as it is, comments included, so that an error message's line number points into the source.

Because the app is a script, you can also look at a change without building: `osascript -l JavaScript src/main.js` opens the window straight from the source. Arming a song and the demo songs need the built app, because they rely on the bundle's launcher and resources.

## 3. Where the code is

Everything is in `src/main.js`, in this order: settings and tuning constants; `run`, which picks the role; the dialog flow; arming and stopping; the background player and its timing loop; the key senders; keyboard profiles and note mapping; the MIDI parser; and, last, the window with its strings, live keys and self test. [How it works](architecture.md) walks through each part.

## 4. Testing

Four tests, from the quickest to the most complete. The first two need nothing but the Mac.

**The engine harness** runs the real mapping and timing code on a virtual clock, with the operating system replaced by a recorder. In a second it checks the 61- and 88-key maps on both layouts, every key's modifiers across a sweep of all 88 notes, chords that mix the zones, Option instead of Ctrl, the analysis of both modes, the settings, live speed changes (×2, ×0.5, during a rest), pause and resume, hold lengths at a new speed, the final notes, the drum filter on real MIDI files, and that a control file meant for another song is ignored. It also checks that the fast paths give exactly the old results: the tempo lookup against a plain scan on 8,000 random cases, the other mode's note count against a full schedule, and the packed job file against the notes it came from. It exits with an error when a check fails. Run it on the compact copy too, which is what people get:

```bash
osascript -l JavaScript tools/engine_harness.js "$PWD/src/main.js"
osascript -l JavaScript tools/engine_harness.js "$PWD/build/Roblox MIDI Piano Player.app/Contents/Resources/main.js"
```

**The real-time test** plays 40 notes with the real engine, the real clock and real Quartz key events into a small test app (`tools/key_receiver.js`) instead of Roblox. Another process doubles the speed at 2.1 s, pauses at 4.1 s and resumes at 5.6 s through the control file, as the window does. It then checks that every key pressed was let go, that notes were 0.25 s apart at 1× and 0.125 s at 2× (median within 5 ms, every note within 40 ms), and that the pause was clean. It takes about ten seconds, and the terminal running it needs the Accessibility permission.

```bash
tools/realtime_test.sh                                                          # the source
tools/realtime_test.sh "$PWD/build/Roblox MIDI Piano Player.app/Contents/Resources/main.js"   # the app's copy
```

**The window's self test** builds the real window and goes through it: it loads a song, switches modes and languages, transposes, sends real key and mouse events through the window with a recorder in place of Roblox (piano keys, Shift, a glissando, `/` and ⌘ shortcuts that must not pass, typing in a text field, ⌘ releasing held keys, Tab between fields), changes the speed, shows a song playing and paused from a stand-in state file, flips live keys off and on, shows the Accessibility hint, shows the uninstaller's list (and closes it without removing anything), and opens a demo from the menu. It saves a picture of the window after each step and a JSON report. Add `arm` to also start a real background player and stop it (it waits for Roblox, so nothing is played), and `idle` to leave the window alone for 20 s and report the CPU time it used.

```bash
./build.sh
python3 tools/genmidi.py /tmp/midi
ROBLOX_MIDI_PLAYER_SUPPORT_DIR=/tmp/rmpp-test ROBLOX_MIDI_PLAYER_UNINSTALL_ROOTS=/tmp/rmpp-test \
  "build/Roblox MIDI Piano Player.app/Contents/MacOS/RobloxMidiPianoPlayer" --ui-selftest /tmp/midi/span88.mid /tmp/shot arm
```

`ROBLOX_MIDI_PLAYER_SUPPORT_DIR` keeps the test's settings and state away from your own, and `ROBLOX_MIDI_PLAYER_UNINSTALL_ROOTS` (folders separated by colons) makes the uninstaller look only there, so a test never sees your real copies. While it runs, the test window floats over whatever you are doing, so that the pictures can be taken; it does not take the keyboard.

**The uninstaller.** `--uninstall` alone only lists, so it is safe to run on your own Mac. To see it remove things, give it a folder of its own:

```bash
mkdir -p /tmp/rmpp-uninstall/Applications /tmp/rmpp-uninstall/support
cp -R "build/Roblox MIDI Piano Player.app" /tmp/rmpp-uninstall/Applications/
ROBLOX_MIDI_PLAYER_UNINSTALL_ROOTS=/tmp/rmpp-uninstall/Applications ROBLOX_MIDI_PLAYER_SUPPORT_DIR=/tmp/rmpp-uninstall/support \
  "build/Roblox MIDI Piano Player.app/Contents/MacOS/RobloxMidiPianoPlayer" --uninstall --yes --now
```

**The key senders, against Roblox itself.** With Roblox open at a piano:

```bash
"/Applications/Roblox MIDI Piano Player.app/Contents/MacOS/RobloxMidiPianoPlayer" --selftest-senders
```

It plays a short phrase with Quartz, then with Accessibility, and logs how fast each one was. Add `background` to put Roblox behind another app first.

## 5. The demo songs and the test files

`tools/genmidi.py` writes the MIDI files the tests use (`span88.mid`, every key from A0 to C8 with chords across the zones; `classic61.mid`) and, with `--demos`, the demo songs in `docs/demo/`. The demos are public-domain music written out note by note in the script, and the output is the same byte for byte every time; the CI check compares them.

```bash
python3 tools/genmidi.py --demos docs/demo
```

To add a demo, add a function to `genmidi.py`, write the file, and list it in `DEMO_SONGS` in `src/main.js` with its English and French titles.

## 6. The icon

`tools/make_icon.js` draws the icon at 1024 × 1024. To rebuild `app/AppIcon.icns`, draw it, scale it with `sips`, pack it with `iconutil`, then let `tools/shrink_icns.py` recompress every image inside without changing a pixel (a third smaller; every entry stays, as Finder needs them all):

```bash
mkdir -p /tmp/AppIcon.iconset
osascript -l JavaScript tools/make_icon.js /tmp/icon_1024.png
for s in 16 32 128 256 512; do
  sips -z $s $s /tmp/icon_1024.png --out /tmp/AppIcon.iconset/icon_${s}x${s}.png
  sips -z $((s * 2)) $((s * 2)) /tmp/icon_1024.png --out /tmp/AppIcon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns /tmp/AppIcon.iconset -o app/AppIcon.icns
python3 tools/shrink_icns.py app/AppIcon.icns
```

`tools/optimize_png.py` does the same for any PNG file, such as the screenshots in `docs/images/`, and drops their metadata (EXIF, XMP and text).

## 7. Making a release

1. Raise `APP_VERSION` in `src/main.js` and both version strings in `app/Info.plist` (`build.sh` refuses to build when they differ).
2. Add the release to `CHANGELOG.md`, with its date.
3. Run the engine harness, the real-time test and the window self test, and look at the pictures.
4. Build the zip, then publish it with the changelog's notes:

```bash
./build.sh --zip
gh release create v2.2.0 build/Roblox-MIDI-Piano-Player-2.2.0.zip --title "Roblox MIDI Piano Player 2.2.0" --notes-file notes.md
```

## 8. The CI check

Every push and pull request runs `.github/workflows/check.yml` on a GitHub Mac: the syntax of every script (`osacompile`, `bash -n`, Python), the property list, the demo songs against `genmidi.py`, the engine harness on the source, `./build.sh --zip`, the engine harness again on the compact copy inside the app, and an uninstaller listing on the clean machine. The real-time test and the window self test need permissions and a screen that a CI machine does not give, so run them yourself before a release.
