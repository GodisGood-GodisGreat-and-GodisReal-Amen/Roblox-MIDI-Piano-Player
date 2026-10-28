#!/usr/bin/env python3
"""Makes an .icns file smaller without changing what it shows (standard library only).

  python3 tools/shrink_icns.py app/AppIcon.icns

iconutil compresses the PNG images inside an icon only moderately. This
rewrites the file in place with every PNG recompressed losslessly by
tools/optimize_png.py; every other entry is kept byte for byte, and so is the
order. Nothing is left out: the 256- and 512-pixel images are stored twice
(as 1x, and as the @2x of the size below), and although their pixels are the
same, Finder draws a 128 pt or 256 pt Retina icon from the @2x entry only
(without it, it rescales a bigger image, which looks slightly different).
"""
import hashlib, os, struct, sys, tempfile, zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import optimize_png

def entries(data):
    if data[:4] != b"icns":
        raise ValueError("not an .icns file")
    pos = 8
    while pos < len(data):
        kind = data[pos:pos + 4]
        length = struct.unpack(">I", data[pos + 4:pos + 8])[0]
        yield kind, data[pos + 8:pos + length]
        pos += length


def pixels(png):
    """Size and RGBA pixels, whatever the PNG's colour type."""
    width, height, ctype, bpp, rows, others = optimize_png.decode(png)
    extra = dict(others)
    rgba = optimize_png.rgba_pixels(ctype, rows, extra.get(b"PLTE", b""), extra.get(b"tRNS", b""))
    return (width, height, hashlib.sha256(rgba).hexdigest())


def main(path):
    original = open(path, "rb").read()
    out = []
    for kind, body in entries(original):
        if body[:4] == b"\x89PNG":
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
                tmp.write(body)
            before, after = optimize_png.optimize(tmp.name)
            smaller = open(tmp.name, "rb").read()
            os.unlink(tmp.name)
            if pixels(smaller) != pixels(body):
                raise SystemExit("pixel mismatch in %s" % kind.decode())
            print("%s: %d -> %d bytes" % (kind.decode(), before, after))
            body = smaller
        out.append(struct.pack(">4sI", kind, len(body) + 8) + body)
    data = b"".join(out)
    result = b"icns" + struct.pack(">I", len(data) + 8) + data
    open(path, "wb").write(result)
    print("%s: %d -> %d bytes" % (path, len(original), len(result)))


if __name__ == "__main__":
    main(sys.argv[1])
