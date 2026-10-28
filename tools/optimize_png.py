#!/usr/bin/env python3
"""Recompresses PNG files without changing a single pixel (standard library only).

  python3 tools/optimize_png.py FILE.png [FILE.png ...]

For each file it decodes the image, then encodes it again several ways (every
PNG row filter, the usual "smallest sum" choice per row, an 8-bit palette when
the image has 256 colours or fewer, several zlib settings) and keeps the
smallest result, but only if the decoded pixels are identical. It keeps the
colour profile (iCCP, sRGB, gAMA, cHRM), so colours look the same, and drops
metadata: EXIF, XMP and text chunks. Used for app/AppIcon.icns and the
screenshots in docs/images.
"""
import struct, sys, zlib

KEEP = {b"IHDR", b"PLTE", b"tRNS", b"iCCP", b"sRGB", b"gAMA", b"cHRM", b"IDAT", b"IEND"}
CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def chunks(data):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG file")
    pos = 8
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        yield data[pos + 4:pos + 8], data[pos + 8:pos + 8 + length]
        pos += 12 + length


def chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def unfilter(raw, width, height, bpp, row_bytes):
    rows, prev, pos = [], bytearray(row_bytes), 0
    for _ in range(height):
        kind = raw[pos]
        line = bytearray(raw[pos + 1:pos + 1 + row_bytes])
        pos += 1 + row_bytes
        for i in range(row_bytes):
            left = line[i - bpp] if i >= bpp else 0
            up = prev[i]
            corner = prev[i - bpp] if i >= bpp else 0
            if kind == 1:
                line[i] = (line[i] + left) & 255
            elif kind == 2:
                line[i] = (line[i] + up) & 255
            elif kind == 3:
                line[i] = (line[i] + ((left + up) >> 1)) & 255
            elif kind == 4:
                line[i] = (line[i] + paeth(left, up, corner)) & 255
        rows.append(bytes(line))
        prev = line
    return rows


def filter_row(kind, line, prev, bpp):
    out = bytearray(len(line))
    for i in range(len(line)):
        left = line[i - bpp] if i >= bpp else 0
        up = prev[i]
        corner = prev[i - bpp] if i >= bpp else 0
        if kind == 0:
            value = line[i]
        elif kind == 1:
            value = line[i] - left
        elif kind == 2:
            value = line[i] - up
        elif kind == 3:
            value = line[i] - ((left + up) >> 1)
        else:
            value = line[i] - paeth(left, up, corner)
        out[i] = value & 255
    return bytes([kind]) + bytes(out)


def filtered_streams(rows, bpp):
    """The image filtered with each single filter, and with the best one per row."""
    width = len(rows[0])
    per_kind = {k: [] for k in range(5)}
    prev = bytes(width)
    for line in rows:
        for k in range(5):
            per_kind[k].append(filter_row(k, line, prev, bpp))
        prev = line
    adaptive = []
    for r in range(len(rows)):
        options = [per_kind[k][r] for k in range(5)]
        adaptive.append(min(options, key=lambda f: sum(b if b < 128 else 256 - b for b in f[1:])))
    streams = [b"".join(per_kind[k]) for k in range(5)]
    streams.append(b"".join(adaptive))
    return streams


def compress(stream):
    best = None
    for level in (9,):
        for strategy in (zlib.Z_DEFAULT_STRATEGY, zlib.Z_FILTERED):
            for mem in (8, 9):
                c = zlib.compressobj(level, zlib.DEFLATED, 15, mem, strategy)
                data = c.compress(stream) + c.flush()
                if best is None or len(data) < len(best):
                    best = data
    return best


def decode(data):
    ihdr, idat, others = None, b"", []
    for kind, body in chunks(data):
        if kind == b"IHDR":
            ihdr = body
        elif kind == b"IDAT":
            idat += body
        elif kind in KEEP and kind not in (b"IEND",):
            others.append((kind, body))
    width, height, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", ihdr)
    if depth != 8 or interlace != 0 or ctype not in CHANNELS:
        return None
    bpp = CHANNELS[ctype]
    rows = unfilter(zlib.decompress(idat), width, height, bpp, width * bpp)
    return width, height, ctype, bpp, rows, others


def rgba_pixels(ctype, rows, palette, trns):
    if ctype == 6:
        return b"".join(rows)
    if ctype == 3:
        out = bytearray()
        for line in rows:
            for index in line:
                r, g, b = palette[index * 3:index * 3 + 3]
                a = trns[index] if index < len(trns) else 255
                out += bytes((r, g, b, a))
        return bytes(out)
    return None


def optimize(path):
    original = open(path, "rb").read()
    decoded = decode(original)
    if decoded is None:
        return len(original), len(original)
    width, height, ctype, bpp, rows, others = decoded
    profile = [(k, b) for k, b in others if k in (b"iCCP", b"sRGB", b"gAMA", b"cHRM")]
    candidates = []

    def build(ihdr_type, rows_, bpp_, extra):
        ihdr = struct.pack(">IIBBBBB", width, height, 8, ihdr_type, 0, 0, 0)
        best_idat = min((compress(s) for s in filtered_streams(rows_, bpp_)), key=len)
        body = [chunk(b"IHDR", ihdr)] + [chunk(k, b) for k, b in profile] + [chunk(k, b) for k, b in extra]
        return b"\x89PNG\r\n\x1a\n" + b"".join(body) + chunk(b"IDAT", best_idat) + chunk(b"IEND", b"")

    palette = dict(others).get(b"PLTE", b"")
    trns = dict(others).get(b"tRNS", b"")
    extra = [(k, b) for k, b in others if k in (b"PLTE", b"tRNS")]
    candidates.append(build(ctype, rows, bpp, extra))

    # An RGBA image with 256 colours or fewer fits a palette exactly.
    if ctype == 6:
        pixels = b"".join(rows)
        colours = {}
        for i in range(0, len(pixels), 4):
            colours.setdefault(pixels[i:i + 4], len(colours))
            if len(colours) > 256:
                break
        if len(colours) <= 256:
            ordered = sorted(colours, key=lambda c: c[3])          # transparent ones first, short tRNS
            index = {c: i for i, c in enumerate(ordered)}
            plte = b"".join(c[:3] for c in ordered)
            alphas = bytes(c[3] for c in ordered)
            last_translucent = max([i for i, c in enumerate(ordered) if c[3] < 255], default=-1)
            pal_rows = [bytes(index[line[i:i + 4]] for i in range(0, len(line), 4)) for line in rows]
            pal_extra = [(b"PLTE", plte)] + ([(b"tRNS", alphas[:last_translucent + 1])] if last_translucent >= 0 else [])
            candidates.append(build(3, pal_rows, 1, pal_extra))

    reference = rgba_pixels(ctype, rows, palette, trns)
    best = original
    for data in candidates:
        if len(data) >= len(best):
            continue
        w2, h2, c2, b2, r2, o2 = decode(data)
        check = rgba_pixels(c2, r2, dict(o2).get(b"PLTE", b""), dict(o2).get(b"tRNS", b""))
        if (w2, h2) == (width, height) and check == reference:
            best = data
    if best is not original:
        open(path, "wb").write(best)
    return len(original), len(best)


def main(paths):
    total_before = total_after = 0
    for p in paths:
        before, after = optimize(p)
        total_before += before
        total_after += after
        print("%-48s %8d -> %8d bytes" % (p[-48:], before, after))
    if len(paths) > 1:
        print("%-48s %8d -> %8d bytes" % ("total", total_before, total_after))


if __name__ == "__main__":
    main(sys.argv[1:])
