#!/usr/bin/env python3
"""Writes MIDI files for the tests and the demo songs (standard library only).

  python3 tools/genmidi.py OUT_DIR           test files
  python3 tools/genmidi.py --demos OUT_DIR   the demo songs (docs/demo/)

Test files:
  span88.mid      - every key from A0 (21) to C8 (108), ascending, plus a few
                    chords that mix the low Ctrl zone, the middle and the high
                    Ctrl zone; and two notes outside even the 88-key piano.
  classic61.mid   - only notes inside C2..C7 (the classic piano).

Demo songs (public-domain music, written out note by note here):
  ode-to-joy.mid             - Beethoven's theme with a simple left hand (Mode 1)
  fur-elise.mid              - the opening of Beethoven's Für Elise (Mode 1)
  full-range-arpeggios.mid   - A minor arpeggios from A0 to C8 and back, then
                               one chord across the whole keyboard (Mode 2)

The output is the same byte for byte every time, so the demos in the
repository can be checked against this script.
"""
import os, struct, sys

def vlq(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append(0x80 | (n & 0x7F))
        n >>= 7
    return bytes(reversed(out))

def track(events, division=480):
    """events: list of (delta_ticks, bytes)"""
    data = b"".join(vlq(d) + b for d, b in events)
    data += vlq(0) + b"\xff\x2f\x00"
    return b"MTrk" + struct.pack(">I", len(data)) + data

def midi(tracks, division=480):
    return b"MThd" + struct.pack(">IHHH", 6, 1, len(tracks), division) + b"".join(tracks)

def note_on(n, vel=90): return bytes([0x90, n, vel])
def note_off(n): return bytes([0x80, n, 0])

def build(notes_seq, division=480, micro_per_quarter=500000):
    """notes_seq: list of (start_tick, [pitches], dur_ticks)."""
    ev = []
    cur = 0
    timeline = []
    for start, pitches, dur in notes_seq:
        for p in pitches:
            timeline.append((start, 1, p))       # on
            timeline.append((start + dur, 0, p)) # off
    timeline.sort(key=lambda t: (t[0], t[1], t[2]))  # offs before ons at equal ticks
    for tick, kind, p in timeline:
        ev.append((tick - cur, note_on(p) if kind == 1 else note_off(p)))
        cur = tick
    tempo = [(0, b"\xff\x51\x03" + micro_per_quarter.to_bytes(3, "big"))]
    return midi([track(tempo, division), track(ev, division)], division)

NAMES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

def pitch(name):
    """'C4' -> 60, 'D#5' -> 75."""
    sharp = 1 if "#" in name else 0
    letter, octave = name[0], int(name.replace("#", "")[1:])
    return 12 * (octave + 1) + NAMES[letter] + sharp

Q = 480   # ticks per quarter note

def test_files(out_dir):
    seq = []
    t = 0
    for p in range(21, 109):          # A0..C8 ascending, eighth notes
        seq.append((t, [p], Q // 2)); t += Q // 4
    t += Q
    seq.append((t, [21, 60, 108], Q))          # chord across all three zones
    t += Q
    seq.append((t, [23, 36, 61, 96, 100], Q))  # low ctrl + classic white/black + high ctrl
    t += Q
    seq.append((t, [19, 110], Q))              # outside even the 88-key piano
    t += Q
    seq.append((t, [33, 45, 57, 69, 81, 93, 105], Q * 2))  # A octaves, A1..A7
    open(os.path.join(out_dir, "span88.mid"), "wb").write(build(seq))

    seq2 = []
    t = 0
    for p in list(range(36, 97, 3)):
        seq2.append((t, [p], Q // 2)); t += Q // 3
    seq2.append((t, [36, 48, 60, 72, 84, 96], Q))
    open(os.path.join(out_dir, "classic61.mid"), "wb").write(build(seq2))

def ode_to_joy():
    melody = "E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4. D4- D4_ " \
             "E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4. C4- C4_"
    seq = []
    t = 0
    for tok in melody.split():
        length = Q
        if tok.endswith("."): length, tok = Q * 3 // 2, tok[:-1]
        elif tok.endswith("-"): length, tok = Q // 2, tok[:-1]
        elif tok.endswith("_"): length, tok = Q * 2, tok[:-1]
        seq.append((t, [pitch(tok)], length - 20))
        t += length
    bass = [("C3", "G3"), ("G2", "G3"), ("C3", "G3"), ("G2", "D3"),
            ("C3", "G3"), ("G2", "G3"), ("C3", "G3"), ("G2", "C3")]
    for bar, (low, high) in enumerate(bass):
        seq.append((bar * 4 * Q, [pitch(low), pitch(high)], 4 * Q - 20))
    return build(seq)

def fur_elise():
    # 3/8 time counted in sixteenths (U ticks); 2 sixteenths of pick-up.
    U = Q // 4
    seq = []
    t = 0
    def rh(names, units=1, hold=0.9):
        nonlocal t
        for n in names.split():
            seq.append((t, [pitch(n)], int(units * U * hold)))
            t += units * U
    def rest(units):
        nonlocal t
        t += units * U
    def lh(names):
        # The left-hand arpeggio rings under the bar, as with the pedal.
        start = t
        for i, n in enumerate(names.split()):
            seq.append((start + i * U, [pitch(n)], (3 - i) * U + 2 * U))
    turn = "E5 D#5 E5 B4 D5 C5"
    def phrase(last_bar):
        lh("A2 E3 A3"); rh("A4", 2); rest(1); rh("C4 E4 A4")
        lh("E2 E3 G#3"); rh("B4", 2); rest(1); rh("E4 G#4 B4")
        lh("A2 E3 A3"); rh("C5", 2); rest(1); rh("E4 E5 D#5")
        rh(turn)
        lh("A2 E3 A3"); rh("A4", 2); rest(1); rh("C4 E4 A4")
        lh("E2 E3 G#3"); rh("B4", 2); rest(1); rh("E4 C5 B4")
        last_bar()
    def first_ending():
        lh("A2 E3 A3"); rh("A4", 2); rest(2); rh("E5 D#5")
    def last_ending():
        lh("A2 E3 A3"); rh("A4", 6, hold=0.95)
    rh("E5 D#5")              # pick-up
    rh(turn)
    phrase(first_ending)
    rh(turn)
    phrase(last_ending)
    seq.sort(key=lambda e: e[0])
    return build(seq, micro_per_quarter=560000)

def full_range_arpeggios():
    E = Q // 4
    up = [21, 24, 28, 33, 36, 40, 45, 48, 52, 57, 60, 64, 69, 72, 76, 81, 84, 88, 93, 96, 100, 105, 108]
    seq = []
    t = 0
    for p in up:
        seq.append((t, [p], E * 2)); t += E
    t += E
    for p in reversed(up):
        seq.append((t, [p], E * 2)); t += E
    t += E
    # One A minor chord from the bottom of the piano to the top.
    seq.append((t, [21, 33, 45, 57, 60, 64, 93, 96, 100, 105], Q * 4))
    return build(seq, micro_per_quarter=520000)

def demos(out_dir):
    open(os.path.join(out_dir, "ode-to-joy.mid"), "wb").write(ode_to_joy())
    open(os.path.join(out_dir, "fur-elise.mid"), "wb").write(fur_elise())
    open(os.path.join(out_dir, "full-range-arpeggios.mid"), "wb").write(full_range_arpeggios())

def main(argv):
    if argv and argv[0] == "--demos":
        out_dir = argv[1] if len(argv) > 1 else "docs/demo"
        os.makedirs(out_dir, exist_ok=True)
        demos(out_dir)
    else:
        out_dir = argv[0] if argv else "."
        os.makedirs(out_dir, exist_ok=True)
        test_files(out_dir)
    print("wrote", out_dir)

if __name__ == "__main__":
    main(sys.argv[1:])
