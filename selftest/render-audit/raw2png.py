#!/usr/bin/env python3
"""把 jsnes 原生 Uint32LE(0x00BBGGRR) 帧转 PNG，并可生成 2x 拼图便于目视。

用法：
  python3 raw2png.py <pure|engine> [--only slot] [--sheet]
"""
import json
import os
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
W, H = 256, 240


def raw_to_image(path: Path) -> Image.Image:
    data = path.read_bytes()
    assert len(data) == W * H * 4, f"{path} 应为 {W*H*4} 字节，实际 {len(data)}"
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        row = y * W * 4
        for x in range(W):
            o = row + x * 4
            # 小端：0x00BBGGRR -> 字节 R G B 0
            r, g, b = data[o], data[o + 1], data[o + 2]
            px[x, y] = (r, g, b)
    return img


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    which = args[0] if args else "pure"
    only = ""
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]
    sheet = "--sheet" in sys.argv

    base = HERE / "out" / which
    if not base.exists():
        print(f"没有 {base}", file=sys.stderr)
        return 1

    for slot_dir in sorted(base.iterdir()):
        if not slot_dir.is_dir():
            continue
        if only and only not in slot_dir.name:
            continue
        manifest = json.loads((slot_dir / "manifest.json").read_text(encoding="utf-8"))
        images = []
        for cap in manifest["captures"]:
            img = raw_to_image(slot_dir / cap["file"])
            png = slot_dir / cap["file"].replace(".raw", ".png")
            img.save(png)
            images.append((cap["frame"], img))
        if sheet and images:
            scale = 2
            cols = min(5, len(images))
            rows = (len(images) + cols - 1) // cols
            gap = 8
            sheet_img = Image.new("RGB", (cols * (W * scale + gap), rows * (H * scale + gap)), (20, 20, 24))
            for i, (frame, img) in enumerate(images):
                big = img.resize((W * scale, H * scale), Image.NEAREST)
                x = (i % cols) * (W * scale + gap)
                y = (i // cols) * (H * scale + gap)
                sheet_img.paste(big, (x, y))
            sheet_img.save(slot_dir / "sheet.png")
            print(f"{slot_dir.name}: {len(images)} frames -> sheet.png")
        else:
            print(f"{slot_dir.name}: {len(images)} frames -> png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
