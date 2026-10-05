import struct, zlib, sys, os

SRC = r"C:\Users\aimji\WorkBuddy\2026-10-05-13-57-42\jianye-pe\icon.ico"
OUT = r"C:\Users\aimji\WorkBuddy\2026-10-05-13-57-42\jianye-pe\_icon_preview.png"

def read_ico_entries(data):
    res, typ, n = struct.unpack_from('<HHH', data, 0)
    entries = []
    for i in range(n):
        w, h, c, r, planes, bpp, size, off = struct.unpack_from('<BBBBHHII', data, 6 + i * 16)
        entries.append(dict(w=w or 256, h=h or 256, bpp=bpp, size=size, off=off))
    return entries

def decode_dib(d):
    (hdr_size, w, h2, planes, bpp) = struct.unpack_from('<IiiHH', d, 0)
    comp = struct.unpack_from('<I', d, 16)[0]
    h = h2 // 2  # height doubled (XOR + AND mask)
    palette = b''
    if bpp <= 8:
        ncol = 1 << bpp
        palette = d[hdr_size:hdr_size + ncol * 4]
        pix_off = hdr_size + ncol * 4
    else:
        pix_off = hdr_size
    # AND mask stride: 1bpp, rows padded to 4 bytes, only present if h2 == 2*h
    has_mask = (h2 == 2 * h) or (h2 < 0)
    use_h = abs(h2) // 2 if h2 != 0 else h
    rgb = []
    stride = ((w * bpp + 31) // 32) * 4
    for y in range(use_h):
        row = []
        base = pix_off + (use_h - 1 - y) * stride
        for x in range(w):
            if bpp == 32:
                b, g, r, a = struct.unpack_from('<BBBB', d, base + x * 4)
                row.append((r, g, b, a))
            elif bpp == 24:
                b, g, r = struct.unpack_from('<BBB', d, base + x * 3)
                row.append((r, g, b, 255))
            elif bpp == 8:
                idx = d[base + x]
                b, g, r, _ = struct.unpack_from('<BBBB', palette, idx * 4)
                row.append((r, g, b, 255))
            else:
                raise ValueError('unsupported bpp %d' % bpp)
        rgb.append(row)
    return w, use_h, rgb

def write_png(path, w, h, rows):
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)

data = open(SRC, 'rb').read()
ents = read_ico_entries(data)
print('entries:', ents)
e = ents[0]
w, h, rows = decode_dib(data[e['off']:e['off'] + e['size']])
print('decoded', w, h)
write_png(OUT, w, h, rows)
print('wrote', OUT, os.path.getsize(OUT))
