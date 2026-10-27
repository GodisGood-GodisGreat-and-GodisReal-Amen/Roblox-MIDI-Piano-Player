Roblox MIDI Piano Player
========================

Plays MIDI files on a Roblox piano by sending it the right keys at the right
time, and lets you play the Roblox piano live from the app's window.

Play a song
  1. Choose a MIDI file (button, File > Open MIDI, or drop it on the window).
  2. Pick the piano: Mode 1 = classic 61 keys (C2-C7), Mode 2 = full 88 keys
     (A0-C8, the dotted keys played with Ctrl).
  3. Click "Arm playback", then click the Roblox piano window once.
  The song keeps playing in the background, even if you switch apps.

While it plays
  - The - and + buttons (or Command - and Command =) slow the song down or
    speed it up on the spot; the middle button puts it back to 1x.
  - Pause (Command P) holds the song where it is; Resume carries on.
  - Stop (Command .) ends it and lets go of every key.

Live keys
  While the app's window is in front, the piano keys you press on your
  keyboard are pressed in Roblox too, and so are the keys you click on the
  piano picture (drag across it for a glissando). Pressed keys turn blue.
  Turn it off with the "Live keys" checkbox or Playback > Live Keys.

Permission
  macOS must allow the app to send keys: System Settings > Privacy &
  Security > Accessibility > switch on "Roblox MIDI Piano Player" (if macOS
  lists "osascript" instead, switch that on). The app shows an "Allow..."
  button when this is missing.

Your settings, the playback log and the playback state are kept in
~/Library/Application Support/Roblox MIDI Piano Player/ ("Config folder").

Source code, help and updates:
https://github.com/GodisGood-GodisGreat-and-GodisReal-Amen/Roblox-MIDI-Piano-Player

Free and open source (public domain, see LICENSE in the source code).
Not affiliated with Roblox Corporation.
