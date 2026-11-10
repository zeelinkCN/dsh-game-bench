#!/usr/bin/env python3
"""分析 browser-raster.mjs 产出的 Chrome 截图：真实设备像素下的列宽/行高/平滑情况。

用法：python3 raster-analyze.py
产出：out/browser/raster-report.json + 控制台表格
"""
import json
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE / "out" / "browser"
FRAME_W, FRAME_H = 256, 240


def runs_of(values):
    """返回 [(value, run_length), ...]"""
    runs = []
    for v in values:
        if runs and runs[-1][0] == v:
            runs[-1][1] += 1
        else:
            runs.append([v, 1])
    return [tuple(r) for r in runs]


def classify(v):
    if v < 32:
        return "B"
    if v > 223:
        return "W"
    return "G"  # 灰 = 平滑插值


def analyse_case(case):
    png = Path(case["png"])
    img = Image.open(png).convert("RGB")
    dpr = case["dpr"]
    css_w, css_h = case["css"]
    device_w, device_h = img.width, img.height
    sx = css_w / FRAME_W * dpr
    sy = css_h / FRAME_H * dpr

    # 取源图 y=10 那一行（竖直 1px 条纹区），对应设备行 round(10*sy)
    src_y = 10
    dev_y = min(device_h - 1, max(0, round(src_y * sy)))
    row = [img.getpixel((x, dev_y))[0] for x in range(device_w)]
    labels = [classify(v) for v in row]
    gray_count = labels.count("G")
    runs = [r for r in runs_of(labels) if r[0] in ("B", "W")]
    widths = [length for _, length in runs]

    # 理论列宽（round 采样，相位未知；比较宽度集合与分布）
    theory = []
    prev = 0
    for i in range(1, FRAME_W + 1):
        pos = round(i * sx)
        theory.append(pos - prev)
        prev = pos

    # 水平条纹区（源 y=120 附近，取 x=30 一列）测行高
    src_x = 30
    dev_x = min(device_w - 1, max(0, round(src_x * sx)))
    src_y0 = 100
    dev_y0 = max(0, round(src_y0 * sy))
    col = [img.getpixel((dev_x, y))[0] for y in range(dev_y0, min(device_h, round(159 * sy)))]
    col_labels = [classify(v) for v in col]
    col_gray = col_labels.count("G")
    col_runs = [r for r in runs_of(col_labels) if r[0] in ("B", "W")]
    row_heights = [length for _, length in col_runs]

    # 8px 网格区（源 y=180 一行）：测相邻白线间距（=8*sx 附近）
    src_y2 = 180
    dev_y2 = min(device_h - 1, max(0, round(src_y2 * sy)))
    row2 = [img.getpixel((x, dev_y2))[0] for x in range(device_w)]
    lab2 = [classify(v) for v in row2]
    white_runs = [r for r in runs_of(lab2) if r[0] == "W"]
    # 白线中心位置（源 x%8==0 的 1px 白线）
    centers = []
    pos = 0
    for value, length in runs_of(lab2):
        if value == "W":
            centers.append(pos + length / 2)
        pos += length
    gaps = [round(centers[i + 1] - centers[i], 3) for i in range(len(centers) - 1)]
    drift = [round(centers[i + 1] - centers[i] - 8 * sx, 3) for i in range(len(centers) - 1)]

    result = {
        "case": case["name"],
        "rendering": case["rendering"],
        "dpr": dpr,
        "css": [css_w, css_h],
        "screenshot_device": [device_w, device_h],
        "scaleX": round(sx, 4),
        "scaleY": round(sy, 4),
        "columns": {
            "width_values": sorted(set(widths)),
            "width_counts": {str(v): widths.count(v) for v in sorted(set(widths))},
            "theory_values": sorted(set(theory)),
            "match_theory_multiset": sorted(widths) == sorted(theory[: len(widths)]),
            "gray_pixels": gray_count,
            "first_runs": runs[:6],
        },
        "rows": {
            "height_values": sorted(set(row_heights)),
            "height_counts": {str(v): row_heights.count(v) for v in sorted(set(row_heights))},
            "gray_pixels": col_gray,
        },
        "tiles": {
            "gap_values": sorted(set(gaps)),
            "ideal_gap": round(8 * sx, 4),
            "max_abs_drift": round(max(abs(d) for d in drift), 3) if drift else None,
            "white_line_widths": sorted(set(length for _, length in white_runs)),
        },
    }
    return result


def main() -> int:
    cases = json.loads((OUT / "raster-cases.json").read_text(encoding="utf-8"))
    report = []
    for case in cases:
        if not case.get("png"):
            print(f"跳过（无截图）：{case['name']}")
            continue
        result = analyse_case(case)
        report.append(result)
        cols = result["columns"]
        rows = result["rows"]
        tiles = result["tiles"]
        print(
            f"{result['case']:<34} device={result['screenshot_device']} sx={result['scaleX']} "
            f"列宽={cols['width_values']}×{cols['width_counts']} 灰像素={cols['gray_pixels']} | "
            f"行高={rows['height_values']}×{rows['height_counts']} 灰={rows['gray_pixels']} | "
            f"8px间距={tiles['gap_values']} 漂移max={tiles['max_abs_drift']}"
        )
    (OUT / "raster-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n[分析] -> {OUT / 'raster-report.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
