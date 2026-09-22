#!/usr/bin/env python3
"""アイコンの PNG を生成する。外部のライブラリは使わず、zlib だけで PNG を書き出す。

    python3 tools/gen-icons.py
"""
import math
import struct
import zlib
from pathlib import Path

BG = (16, 16, 20)
RING = (245, 245, 247)
LENS = (30, 30, 36)
ACCENT = (255, 214, 10)


def blend(dst, src, alpha):
    return tuple(round(d + (s - d) * alpha) for d, s in zip(dst, src))


def coverage(distance, edge, softness=1.0):
    """距離 distance が edge を内側に含む割合（アンチエイリアス用）。"""
    return max(0.0, min(1.0, (edge - distance) / softness + 0.5))


def render(size):
    px = [[BG for _ in range(size)] for _ in range(size)]
    c = size / 2
    ring_outer = size * 0.34
    ring_inner = size * 0.27
    soft = max(1.0, size / 180)

    for y in range(size):
        for x in range(size):
            dx = x + 0.5 - c
            dy = y + 0.5 - c
            d = math.hypot(dx, dy)

            # レンズ本体
            a_lens = coverage(d, ring_inner, soft)
            if a_lens > 0:
                px[y][x] = blend(px[y][x], LENS, a_lens)

            # リング（外周 - 内周）
            a_ring = coverage(d, ring_outer, soft) * (1 - coverage(d, ring_inner, soft))
            if a_ring > 0:
                px[y][x] = blend(px[y][x], RING, a_ring)

            # 斜めのスラッシュ（無音の意）
            # 直線 y = x を中心に太さを持たせる
            line = abs(dx - dy) / math.sqrt(2)
            within = d < ring_outer * 1.24
            a_slash = coverage(line, size * 0.028, soft) if within else 0.0
            if a_slash > 0:
                px[y][x] = blend(px[y][x], ACCENT, a_slash)

    return px


def write_png(path, pixels):
    size = len(pixels)
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for r, g, b in row:
            raw += bytes((r, g, b))

    def chunk(tag, data):
        out = struct.pack('>I', len(data)) + tag + data
        return out + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    Path(path).write_bytes(png)


def main():
    out = Path(__file__).resolve().parent.parent / 'icons'
    out.mkdir(exist_ok=True)
    for size in (180, 192, 512):
        write_png(out / f'icon-{size}.png', render(size))
        print(f'icons/icon-{size}.png')


if __name__ == '__main__':
    main()
