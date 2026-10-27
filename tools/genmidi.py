#!/usr/bin/env python3
"""Writes small test MIDI files (stdlib only).

  python3 genmidi.py out_dir

Files:
  span88.mid      - every key from A0 (21) to C8 (108), ascending, plus a few
                    chords that mix the low Ctrl zone, the middle and the high
                    Ctrl zone; and two notes outside even the 88-key piano.
  classic61.mid   - only notes inside C2..C7 (the classic piano).
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

def build(notes_seq, division=480):
    """notes_seq: list of (start_tick, [pitches], dur_ticks) sorted by start."""
    ev = []
    cur = 0
    timeline = []
    for start, pitches, dur in notes_seq:
        for p in pitches:
            timeline.append((start, 1, p))       # on
            timeline.append((start + dur, 0, p)) # off
    timeline.sort(key=lambda t: (t[0], t[1]))    # offs before ons at equal ticks
    for tick, kind, p in timeline:
        ev.append((tick - cur, note_on(p) if kind == 1 else note_off(p)))
        cur = tick
    tempo = [(0, b"\xff\x51\x03" + (500000).to_bytes(3, "big"))]
    return midi([track(tempo, division), track(ev, division)], division)

def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    q = 480
    seq = []
    t = 0
    for p in range(21, 109):          # A0..C8 ascending, eighth notes
        seq.append((t, [p], q // 2)); t += q // 4
    t += q
    seq.append((t, [21, 60, 108], q))          # chord across all three zones
    t += q
    seq.append((t, [23, 36, 61, 96, 100], q))  # low ctrl + classic white/black + high ctrl
    t += q
    seq.append((t, [19, 110], q))              # outside even the 88-key piano
    t += q
    seq.append((t, [33, 45, 57, 69, 81, 93, 105], q * 2))  # A octaves, A1..A7
    open(os.path.join(out_dir, "span88.mid"), "wb").write(build(seq))

    seq2 = []
    t = 0
    for p in list(range(36, 97, 3)):
        seq2.append((t, [p], q // 2)); t += q // 3
    seq2.append((t, [36, 48, 60, 72, 84, 96], q))
    open(os.path.join(out_dir, "classic61.mid"), "wb").write(build(seq2))

    # A demo song: the "Ode to Joy" theme (Beethoven, public domain), melody
    # with a simple left hand, all inside the classic 61-key piano.
    melody = "E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4. D4- D4_ " \
             "E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4. C4- C4_"
    names = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    def pitch(n):
        return 12 * (int(n[1]) + 1) + names[n[0]]
    seq3 = []
    t = 0
    for tok in melody.split():
        length = q
        if tok.endswith("."): length, tok = q * 3 // 2, tok[:-1]
        elif tok.endswith("-"): length, tok = q // 2, tok[:-1]
        elif tok.endswith("_"): length, tok = q * 2, tok[:-1]
        seq3.append((t, [pitch(tok)], length - 20))
        t += length
    bass = [("C3", "G3"), ("G2", "G3"), ("C3", "G3"), ("G2", "D3"),
            ("C3", "G3"), ("G2", "G3"), ("C3", "G3"), ("G2", "C3")]
    for bar, (low, high) in enumerate(bass):
        seq3.append((bar * 4 * q, [pitch(low), pitch(high)], 4 * q - 20))
    seq3.sort(key=lambda e: e[0])
    open(os.path.join(out_dir, "Ode to Joy.mid"), "wb").write(build(seq3))
    print("wrote", out_dir)

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
