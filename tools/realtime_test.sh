#!/bin/bash
# Plays a short song with the REAL playback engine into a small test app
# (tools/key_receiver.js) instead of Roblox, doubles the speed, transposes it
# and pauses it from another process, then checks what the test app received:
#   - every key pressed was also let go;
#   - notes 0.25 s apart at 1x, then 0.125 s apart after the speed change;
#   - the right key for every note, 2 semitones higher once transposed at 3.1 s;
#   - a clean 1.5 s pause with no key pressed, then the same spacing again.
#
#   tools/realtime_test.sh                 tests src/main.js
#   tools/realtime_test.sh path/to/main.js tests another copy (the built app's)
#
# It takes about ten seconds. Like the app, the terminal that runs it needs
# the Accessibility permission (System Settings › Privacy & Security ›
# Accessibility); without it macOS drops the keys and the test says so.
# Key events go to the test app only, never to another app.
set -euo pipefail
cd "$(dirname "$0")/.."
MAIN_JS="${1:-$PWD/src/main.js}"

WORK="$(mktemp -d -t rmpp-realtime)"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$WORK/support"

/usr/bin/osascript -l JavaScript tools/key_receiver.js "$WORK/keys.log" 30 > /dev/null &
RECEIVER=$!
for _ in $(seq 1 50); do
  [ -s "$WORK/keys.log.pid" ] && break
  sleep 0.1
done
TARGET="$(cat "$WORK/keys.log.pid")"

/usr/bin/osascript -l JavaScript tools/realtime_test.js "$MAIN_JS" "$WORK/support" "$TARGET" "$WORK/keys.log.done" > "$WORK/run.json"
wait "$RECEIVER"

/usr/bin/python3 - "$WORK" <<'PY'
import json, os, sys
work = sys.argv[1]
run = json.load(open(os.path.join(work, "run.json")))
events = [json.loads(line) for line in open(os.path.join(work, "keys.log")) if line.strip()]
downs = [e["wall"] - run["start"] for e in events if e["type"] == 10]
ups = [e for e in events if e["type"] == 11]
problems = []
if not downs:
    sys.exit("FAIL: the test app received no keys. Give this terminal the Accessibility permission and try again.")
if len(downs) != 40 or len(ups) != 40:
    problems.append("expected 40 key presses and 40 releases, got %d and %d" % (len(downs), len(ups)))
gaps = [b - a for a, b in zip(downs, downs[1:])]
before = [g for t, g in zip(downs[1:], gaps) if t < 2.1][1:]
pause = max(gaps)
after = [g for t, g in zip(downs[1:], gaps) if t > 2.4 and g < 1.0]
def median(values):
    s = sorted(values)
    return s[len(s) // 2] if s else 0
# The tempo is judged on the median spacing. A busy Mac can make one note
# arrive a little late and the next one early, so single notes get 40 ms.
for name, values, target in (("1x", before, 0.25), ("2x", after, 0.125)):
    if not values or abs(median(values) - target) > 0.005:
        problems.append("median spacing at %s is %.3f s, expected %.3f" % (name, median(values), target))
    elif max(abs(g - target) for g in values) > 0.04:
        problems.append("a note at %s was more than 40 ms off: %s" % (name, ", ".join("%.3f" % g for g in values)))
if not 1.45 <= pause <= 1.8:
    problems.append("pause of %.3f s, expected about 1.5 s" % pause)
during = [t for t in downs if 4.3 < t < 5.55]
if during:
    problems.append("%d key(s) pressed during the pause" % len(during))
# Note n is MIDI 60 + n % 5 (C4 to E4 on key 1 = C2): its key and whether
# Shift is down, untransposed, and 2 semitones up once the transposition
# written at 3.1 s has reached the player (it looks every 0.1 s). Shift's own
# events carry its state in their flags; the other keys' events do not.
KEYS = {60: (17, False), 61: (17, True), 62: (16, False), 63: (16, True), 64: (32, False), 65: (34, False), 66: (34, True)}
shift = False
pressed = []
for e in events:
    if e["type"] == 12 and e["code"] == 56:
        shift = bool(e.get("flags", 0) & (1 << 17))
    elif e["type"] == 10:
        pressed.append((e["wall"] - run["start"], e["code"], shift))
wrong = []
for n, (t, code, shifted) in enumerate(pressed):
    note = 60 + n % 5
    allowed = ([KEYS[note]] if t < 3.25 else []) + ([KEYS[note + 2]] if t > 3.1 else [])
    if (code, shifted) not in allowed:
        wrong.append("note %d at %.3f s: key %d%s" % (n + 1, t, code, "+shift" if shifted else ""))
transposed = len([1 for n, (t, code, shifted) in enumerate(pressed) if t > 3.1 and (code, shifted) == KEYS[60 + n % 5 + 2]])
if wrong:
    problems.append("wrong keys: " + "; ".join(wrong[:4]))
if transposed < 10:
    problems.append("only %d notes were transposed" % transposed)
print("keys: %d pressed, %d released" % (len(downs), len(ups)))
print("1x:   median %.3f s apart (%s ...)" % (median(before), ", ".join("%.3f" % g for g in before[:5])))
print("2x:   median %.3f s apart (%s ...)" % (median(after), ", ".join("%.3f" % g for g in after[:5])))
print("transposed +2 at 3.1 s: %d notes on the keys 2 semitones up, %d on a wrong key" % (transposed, len(wrong)))
print("pause: %.3f s" % pause)
if problems:
    print("FAIL: " + "; ".join(problems))
    sys.exit(1)
print("PASS")
PY
