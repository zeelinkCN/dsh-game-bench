#!/usr/bin/env python3
"""显示层量化：client.js `fit`（默认 4:3 + 横向 1.25x 拉伸）与整数倍像素放大对比。

只做数学与最近邻重采样模拟，不改生产文件。
产出：
  out/display/
    jackal-native-2x.png            原始 256x240，2x 整数放大
    jackal-pixel-3x.png             pixel 模式（整数 3x）
    jackal-fit-<w>x<h>.png          fit 模式 CSS 尺寸（DPR=1 最近邻模拟）
    jackal-fit-<w>x<h>-dpr2.png     fit 模式 DPR=2（设备像素）最近邻模拟
    montage-fit-vs-pixel.png        对比拼图
    scaling-report.json             量化数据
"""
import json
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
DISPLAY = OUT / "display"
DISPLAY.mkdir(parents=True, exist_ok=True)

FRAME_W, FRAME_H = 256, 240
SLOT = "nes-701f4d4-赤色要塞"


def fit_size(avail_w: int, avail_h: int):
    """与 client.js screenSizeFor('fit') 完全一致的 4:3 计算"""
    height = min(max(1, avail_h), round(avail_w * 3 / 4))
    width = round(height * 4 / 3)
    return width, height


def pixel_size(avail_w: int, avail_h: int):
    """与 client.js screenSizeFor('pixel') 完全一致的整数倍计算"""
    scale = max(1, min(avail_w // FRAME_W, avail_h // FRAME_H))
    return FRAME_W * scale, FRAME_H * scale


def column_widths(scale: float, count: int = FRAME_W):
    """最近邻放大时每个源像素列占用的设备像素宽度（round(i*s)-round((i-1)*s)）"""
    widths = []
    prev = 0
    for i in range(1, count + 1):
        pos = round(i * scale)
        widths.append(pos - prev)
        prev = pos
    return widths


def tile_widths(scale: float, tile: int = 8, tiles: int = FRAME_W // 8):
    widths = []
    prev = 0
    for k in range(1, tiles + 1):
        pos = round(k * tile * scale)
        widths.append(pos - prev)
        prev = pos
    return widths


def drift_8px(scale: float, tiles: int = FRAME_W // 8):
    """8px tile 边界相对理想位置的设备像素漂移（round-ideal）"""
    return [round(k * 8 * scale) - k * 8 * scale for k in range(1, tiles + 1)]


def analyse(label: str, css_w: int, css_h: int, dpr: int):
    sx = css_w / FRAME_W * dpr
    sy = css_h / FRAME_H * dpr
    cw = column_widths(sx)
    tw = tile_widths(sx)
    drift = drift_8px(sx)
    return {
        "label": label,
        "css": [css_w, css_h],
        "dpr": dpr,
        "device": [css_w * dpr, css_h * dpr],
        "scaleX": round(sx, 4),
        "scaleY": round(sy, 4),
        "scaleX_integer": abs(sx - round(sx)) < 1e-9,
        "scaleY_integer": abs(sy - round(sy)) < 1e-9,
        "horizontal_stretch_vs_square": round(sx / sy, 4),
        "column_width_values": sorted(set(cw)),
        "column_width_counts": {str(v): cw.count(v) for v in sorted(set(cw))},
        "tile_width_values": sorted(set(tw)),
        "tile_width_counts": {str(v): tw.count(v) for v in sorted(set(tw))},
        "tile_boundary_drift_px": [round(d, 3) for d in drift],
        "tile_boundary_drift_max": round(max(abs(d) for d in drift), 3),
    }


def save_scaled(base: Image.Image, size, name):
    img = base.resize(size, Image.NEAREST)
    img.save(DISPLAY / name)
    return img


def label(img: Image.Image, text: str) -> Image.Image:
    canvas = Image.new("RGB", (img.width, img.height + 18), (12, 12, 16))
    canvas.paste(img, (0, 18))
    draw = ImageDraw.Draw(canvas)
    draw.text((6, 4), text, fill=(235, 235, 240))
    return canvas


def main() -> int:
    base = Image.open(OUT / "pure" / SLOT / "frame-0620.png").convert("RGB")

    report = {"native": [FRAME_W, FRAME_H], "cases": []}

    # 实际面板尺寸不可能预知：用几种典型可用区域做量化
    avail_cases = [(1100, 700), (980, 620), (560, 600)]
    images = []
    native2 = save_scaled(base, (FRAME_W * 2, FRAME_H * 2), "jackal-native-2x.png")
    images.append(label(native2, "native 2x (512x480) 原始像素 1:1"))
    pixel = pixel_size(1100, 700)
    pixel3 = save_scaled(base, pixel, "jackal-pixel-3x.png")
    images.append(label(pixel3, f"pixel 模式整数放大 ({pixel[0]}x{pixel[1]})"))

    for avail_w, avail_h in avail_cases:
        w, h = fit_size(avail_w, avail_h)
        for dpr in (1, 2):
            case = analyse(f"fit av={avail_w}x{avail_h} dpr={dpr}", w, h, dpr)
            report["cases"].append(case)
            name = f"jackal-fit-{w}x{h}" + (f"-dpr{dpr}" if dpr > 1 else "") + ".png"
            img = save_scaled(base, (w * dpr, h * dpr), name)
            if dpr == 1:
                images.append(label(img, f"fit 4:3 {w}x{h} dpr1 (scale {case['scaleX']},{case['scaleY']})"))

    # 拼图（统一缩放对齐高度）
    target_h = 560
    strips = []
    for img in images:
        scale = target_h / img.height
        strips.append(img.resize((max(1, round(img.width * scale)), target_h), Image.NEAREST))
    width = sum(s.width for s in strips) + 8 * (len(strips) - 1)
    montage = Image.new("RGB", (width, target_h), (30, 30, 36))
    x = 0
    for s in strips:
        montage.paste(s, (x, 0))
        x += s.width + 8
    montage.save(DISPLAY / "montage-fit-vs-pixel.png")

    (DISPLAY / "scaling-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    for case in report["cases"]:
        print(
            f"{case['label']:<34} device={case['device']} scaleX={case['scaleX']} scaleY={case['scaleY']} "
            f"integer({case['scaleX_integer']},{case['scaleY_integer']}) "
            f"列宽={case['column_width_values']} tile宽={case['tile_width_values']} "
            f"tile边界漂移max={case['tile_boundary_drift_max']}px"
        )
    print(f"\n[demo] -> {DISPLAY}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
