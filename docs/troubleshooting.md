# Troubleshooting

**"Apple could not verify 'Roblox MIDI Piano Player' is free of malware", or "… is damaged and can't be opened".** The app is not signed by Apple, and macOS stops apps downloaded from the internet until you say you trust them. Open **System Settings › Privacy & Security** and click **Open Anyway** next to its name (see [Getting started](getting-started.md#3-first-start)), or run `xattr -dr com.apple.quarantine "/Applications/Roblox MIDI Piano Player.app"` in Terminal. A copy built with `./build.sh` is never stopped.

**"macOS has not allowed this app to send keys yet."** Click **Allow…** and switch the app on under **Privacy & Security › Accessibility**; if macOS lists **osascript** instead, switch that on. If it is already on but the message stays, select it, remove it with **−**, then click **Allow…** again: macOS sometimes keeps an old entry after the app was replaced.

**Nothing plays after arming; the status stays on "Armed — click the Roblox piano window once".** The background player waits until Roblox is the app in front. Click inside the Roblox window (not just its title bar). If Roblox is in full screen, switch to its Space and click. **Open log** shows which app the player saw in front each time it changed ("Frontmost application changed: …").

**The song plays in the log, but nothing sounds in Roblox.** Check that your character is sitting at the piano and that pressing `1` yourself plays a note. Then check the Accessibility permission above. If both are fine, try **Key sending › Accessibility — compatible**: a Roblox update could have changed what Roblox accepts.

**Wrong notes, or every song sounds too high or too low.** Check the mode first: Mode 1 for a 61-key piano, Mode 2 for one with dotted keys. Then check **Note of key 1**: standard Roblox pianos start at C2 (**Reset to C2**). If a single song is off, use **Transpose this song** instead.

**Some notes are missing.** The coverage line under the piano picture says how many notes fit and how many were skipped. Orange keys are notes the classic piano does not have: switch to Mode 2 if your piano has 88 keys, or choose **Note mapping › Smart best fit**, which shifts the song to fit more of it. Notes outside A0–C8 cannot be played on any Roblox piano.

**The dotted keys play the wrong notes, or nothing.** Your piano may not have the 88-key extension: use Mode 1. If it has dotted keys but plays them with Option rather than Ctrl, set **Extended keys held with** to **Option / Alt**.

**Chords come out as fast rolls, or a busy song falls behind.** Each key press takes time to send. Use **Key sending › Quartz — fast** (about 2 ms per key, against 12–17 ms with Accessibility), or slow the song down with **−**. At the end of a song that fell more than a second behind, the log says so.

**A note keeps ringing in Roblox after the song.** **Stop** lets go of every key, Shift and Ctrl included, and so does the end of a song. Live keys let go of everything when the window loses focus. If a key still seems held (after the app was forced to quit, say), press and release that key in Roblox yourself.

**Stop does not stop the music.** The window first asks the player to stop, then ends its process. If even that fails, a message gives the player's process number: quit Roblox, or run `kill` with that number in Terminal.

**The speed buttons or Pause do nothing during a song.** They reach the player within a tenth of a second. A song armed by version 2.0 of the app (before updating) does not listen for them: stop it and arm it again.

**Live keys say "Roblox is not open" while Roblox is running.** The app connects as soon as macOS reports that Roblox has opened, and otherwise looks for it every second and a half; give it a moment. If it still does not find it, **Open log**: when live keys connect, the log says "Live keys: connected to …" with the app it found.

**Live keys are connected, but pressing keys in the window plays nothing.** Make sure the window is in front and no text field is being edited (a blinking cursor in **Delay after click** or **Note of key 1**): click the piano picture to give the keys back to the piano. Only the piano's keys and Space are passed on.

**Pressing keys in the window beeps.** Live keys are off, or the key is not a piano key. macOS beeps when a window has nothing to do with a key.

**"This MIDI file has no notes to play."** The file has no note-on events, or only empty tracks. Open it in a MIDI editor to check.

**"This MIDI file uses a timing format the app cannot read."** The file counts time in SMPTE frames, which is rare. Open it in a MIDI editor (GarageBand, MuseScore, Logic) and export it again as a standard MIDI file.

**A song plays notes that do not belong to the melody.** Every track of the file is played: a file made for a whole band also has its bass, strings and so on. Drum tracks (channel 10) are already left out. Delete the other instruments in a MIDI editor, or look for a piano arrangement of the song.

**The Terminal live log opens every time a song is armed.** Untick **Also open the live log (Terminal)** in the settings. **Open log** shows the same log whenever you want it.

**The window does not appear, or the app shows old-style dialogs instead.** If the window cannot be built, the app falls back to its older dialogs so that it stays usable. **Open log** (or `playback.log` in the config folder) says why. Please [report it](https://github.com/GodisGood-GodisGreat-and-GodisReal-Amen/Roblox-MIDI-Piano-Player/issues), with that line.

**The uninstaller did not list a copy you know is there.** It looks in both **Applications** folders, **Downloads**, **Desktop** and **Documents**, and anywhere else Spotlight or macOS knows of a copy. A copy on a drive Spotlight does not search, or one put there a moment ago, can be missed: drag it to the Trash yourself.

**The uninstaller says it "could not remove" something.** That item is on a locked or read-only drive, or belongs to another user of the Mac (a copy another account put in **Applications**, say). Drag it to the Trash in Finder, which asks for your password when it is needed.

**Something went to the Trash that you wanted to keep.** The uninstaller only takes the app, archives named after it, its settings and the files macOS keeps for it. Unless you ticked **Delete right away**, everything is still in the Trash: drag it back where it was, which the list showed for each item.

**After uninstalling and installing again, the app asks to send keys again.** The uninstaller removes its Accessibility permission too, so a new copy starts clean: click **Allow…** once more.

**Starting over.** Quit the app and delete `config.json` from the config folder (`~/Library/Application Support/Roblox MIDI Piano Player/`). The app starts with its default settings next time.
