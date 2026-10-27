# Roblox MIDI Piano Player

Play any MIDI file on a Roblox piano. Pick a song, see on a picture of the piano which keys it uses, click **Arm playback**, then click the Roblox piano once: the app presses the right keys at the right time, chords and all. While it plays you can slow it down, speed it up or pause it, and you can play the Roblox piano yourself from the app's window, with your keyboard or your mouse.

It is a small native macOS app, in English and French. Nothing to install besides the app itself.

![The app playing "Ode to Joy" at 1.30× speed, with a C major chord held on the live keys](docs/images/window-en.png)

## What it does

- **Plays MIDI files on the Roblox piano.** Each note becomes the key the Roblox piano expects: white keys `1` … `m`, black keys with Shift. Notes are held for their real length, chords land together, and tempo changes in the MIDI file are followed.
- **Both Roblox pianos.** *Mode 1* is the classic 61-key piano (C2–C7). *Mode 2* is the full 88-key piano (A0–C8) found in pianos such as *Talent Show*, whose extra low and high notes are the "dotted" keys played with Ctrl held down. The picture of the piano shows which keys a song uses, and the app tells you how many notes the other mode would add or lose.
- **Live speed and pause.** While a song plays, **−** and **+** change the speed on the spot (0.25× to 2×), the middle button puts it back to 1×, and **Pause** holds the song exactly where it is. The music never jumps or rushes to catch up.
- **Live keys.** While the app's window is in front, the piano keys you press on your keyboard are pressed in Roblox too, and so are the keys you click on the piano picture (drag across it for a glissando). Pressed keys turn blue.
- **Keeps playing in the background.** Keys are sent straight to the Roblox process, so you can switch to other apps while a song plays.
- **Exact or best fit.** *Perfect* mapping plays every note exactly where it is written and skips notes that are outside the piano. *Smart best fit* may shift a song to fit more of it in. You can also transpose one song by semitones.
- **US QWERTY and French AZERTY** keyboards, an optional free-form custom layout, and English or French for the whole window.

## Install

### Download

1. Download `Roblox-MIDI-Piano-Player-2.1.0.zip` from the [latest release](https://github.com/GodisGood-GodisGreat-and-GodisReal-Amen/Roblox-MIDI-Piano-Player/releases/latest) and double-click it.
2. Move **Roblox MIDI Piano Player** into your **Applications** folder.
3. The app is not signed by Apple, so macOS stops it the first time. Open it once, then go to **System Settings › Privacy & Security** and click **Open Anyway** next to its name. (Or, in Terminal: `xattr -dr com.apple.quarantine "/Applications/Roblox MIDI Piano Player.app"`.)

### Build it yourself

You only need macOS 10.15 or newer; nothing is compiled.

```bash
git clone https://github.com/GodisGood-GodisGreat-and-GodisReal-Amen/Roblox-MIDI-Piano-Player.git
cd Roblox-MIDI-Piano-Player
./build.sh --install
```

`./build.sh` alone builds `build/Roblox MIDI Piano Player.app`; `--install` also puts it in `/Applications` (updating an installed copy in place, so macOS keeps its permission); `--zip` makes the release zip.

### Allow it to send keys

macOS asks you to allow the app to control your computer: open **System Settings › Privacy & Security › Accessibility** and switch on **Roblox MIDI Piano Player** (if macOS lists **osascript** instead, switch that on). Until then the app shows an **Allow…** button that takes you there.

## Play a song

1. **Choose a MIDI file**: the button, **File › Open MIDI…** (⌘O), or drop a `.mid` file anywhere on the window. A demo song is in [`examples/`](examples).
2. **Pick the piano**: Mode 1 (61 keys) or Mode 2 (88 keys), the same as the piano in your Roblox game.
3. Click **Arm playback**, then click the Roblox piano window once. The song starts after the short delay set in the settings.

| While it plays | Button | Shortcut |
| --- | --- | --- |
| Slower / faster (by 0.05×) | **−** / **+** | ⌘− / ⌘= |
| Back to normal speed | the speed in the middle | ⌘0 |
| Pause / resume | **Pause** | ⌘P |
| Stop and let go of every key | **Stop** | ⌘. |
| Live keys on / off | the **Live keys** checkbox | ⌘L |

The speed is saved: the next songs start at the speed you left.

## Settings

All settings are saved as you change them.

- **Keyboard layout**: US QWERTY or French AZERTY. It only changes the letters drawn on the keys; the keys themselves are the same physical keys either way. *Legacy custom* lets you type any layout, one character per semitone, for unusual pianos.
- **Note mapping**: *Perfect* (exact notes, out-of-range notes skipped) or *Smart best fit* (may transpose the whole song).
- **Key sending**: *Quartz* sends a key in about 2 ms, so chords land together; *Accessibility* is slower but is there in case a Roblox update ever stops Quartz; *Automatic* uses Quartz and switches by itself if it fails.
- **Extended keys held with**: the key held for the dotted keys of the 88-key piano, Control (standard) or Option.
- **Speed**, **Delay after click** (how long after you click Roblox the song starts) and **Note of key 1** (C2 on a standard Roblox piano; change it only if every song sounds too high or too low).

## The two pianos

| | Mode 1 · Classic, 61 keys | Mode 2 · Extended, 88 keys |
| --- | --- | --- |
| Range | C2 – C7 | A0 – C8 |
| White keys | `1 2 3 4 5 6 7 8 9 0 q w e r t y u i o p a s d f g h j k l z x c v b n m` | the same |
| Black keys | Shift + the white key on their left | the same |
| 15 lowest notes, A0 – B1 | — | Ctrl + `1 2 3 4 5 6 7 8 9 0 q w e r t` |
| 12 highest notes, C#7 – C8 | — | Ctrl + `y u i o p a s d f g h j` |

## How it works, in one paragraph

The whole app is one JavaScript for Automation script, [`src/main.js`](src/main.js), in an ordinary app bundle whose launcher starts it with `osascript`; the window is built with AppKit straight from JavaScript. Loading a song parses the MIDI file (all tracks, tempo changes, note lengths) and maps every note onto the chosen piano. Arming starts a separate background player process that waits for Roblox to come to the front, then sends each chord's keys to the Roblox process with `CGEventPostToPid`. Only the key presses are on the time-critical path; key releases are budgeted into the gaps, and when a big chord runs late the whole rest of the song shifts by the overrun instead of rushing, so the pulse stays steady. The window and the player talk through small JSON files in `~/Library/Application Support/Roblox MIDI Piano Player/`: the player reports its state and position, and the window writes the speed and the pause, which the player picks up within a tenth of a second and applies from the note that is playing. Live keys use the same sender from the window itself, and keep track of every key they press so that nothing is ever left stuck down in Roblox.

## For developers

```bash
osascript -l JavaScript tools/engine_harness.js "$PWD/src/main.js"   # engine tests (virtual clock)
python3 tools/genmidi.py /tmp/midi                                    # test and demo MIDI files
./build.sh
"build/Roblox MIDI Piano Player.app/Contents/MacOS/RobloxMidiPianoPlayer" --ui-selftest /tmp/midi/span88.mid /tmp/shot
```

- The engine harness runs the real playback engine with a virtual clock and checks every key, modifier and timing: the 88-key map, chords across the zones, live speed changes, pause, and hold lengths.
- `--ui-selftest <midi> <png-prefix> [arm]` builds the real window, loads the song, switches modes and languages, plays live keys into a recorder, and saves a picture of the window after each step, plus a JSON report. Add `arm` to also start and stop a real background player (it waits for Roblox, so nothing is played).
- `--selftest-senders` plays a short phrase into a running Roblox piano with Quartz, then with Accessibility, and logs how fast each one is.
- `--dialogs` starts the older dialog-based flow. `--midi <file>` opens a song at launch.
- `ROBLOX_MIDI_PLAYER_SUPPORT_DIR=/some/folder` keeps settings, logs and state somewhere else (handy for tests).
- `tools/make_icon.js` draws the icon.

## Privacy

The app works entirely on your Mac. It never connects to the internet (the only link it opens is this page, from **About**), it sends key presses to Roblox and nowhere else, and it does not read anything from Roblox. Settings and logs stay in `~/Library/Application Support/Roblox MIDI Piano Player/`.

## Troubleshooting

- **Nothing happens in Roblox.** Check the Accessibility permission above, and click the Roblox piano once after arming. **Open log** shows what the player did.
- **Wrong notes, or everything too high or too low.** Make sure the mode matches your Roblox piano, then check **Note of key 1** (C2 for standard pianos).
- **The extended notes do not play.** Some pianos use Option instead of Control: change **Extended keys held with**.
- **Live keys say "Roblox is not open".** Start Roblox; the app finds it within a couple of seconds.

## En français

L'app est entièrement traduite : choisis **Français** en haut à droite de la fenêtre. Elle joue n'importe quel fichier MIDI sur un piano Roblox (61 ou 88 touches) ; pendant la lecture, **−** et **+** changent la vitesse en direct et **Pause** arrête le morceau là où il en est. Avec les **touches en direct**, ce que tu appuies sur ton clavier ou que tu cliques sur l'image du piano est aussi joué dans Roblox. Pour l'installer, suis les étapes de [Install](#install) ci-dessus.

![La fenêtre en français, morceau en pause](docs/images/window-fr.png)

## License

Public domain. Roblox MIDI Piano Player is released under [The Unlicense](LICENSE): copy it, change it, share it, build on it, no credit needed.

Roblox is a trademark of Roblox Corporation. This project is not affiliated with or endorsed by Roblox.
