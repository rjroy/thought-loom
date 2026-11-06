"""Focused checks and inspection renders for this restricted path-only SVG pair.

Not a general SVG sanitizer. Does not edit SVGs or approved PNGs.
Run: python3 .impeccable/candidates/glyphs/production/verify.py --candidate-dir corrected
Requires the already-installed ImageMagick and rsvg-convert; installs nothing.
"""

import argparse
import collections
import hashlib
import json
import pathlib
import re
import subprocess
import xml.etree.ElementTree as ET


HERE = pathlib.Path(__file__).resolve().parent
REVIEW = HERE / "review"
SOURCES = {
    "lantern.png": "78ae83089be7edeac1e1da15e16c6171a8127c3f7be57083b676c0caeadd362e",
    "sprout.png": "50f27c40f676dc0c379534a4f3bcfbd400dc8238714fd31c510cdac73f3380c2",
    "lantern-prompt.txt": "a859da5f9596d6140855f52127992b85e012b2d8ef03391299a6e6a5849c6337",
    "sprout-prompt.txt": "ef9aa9f29fac3659fe115653f42a7c7580e1939d7133cf7704ece3691156befb",
}


def run(*args):
    return subprocess.check_output([str(a) for a in args])


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_svg(path):
    text = path.read_text()
    assert not re.search(r"<!|<\?|data:|url\s*\(|https?://(?!www\.w3\.org/2000/svg)", text, re.I)
    root = ET.fromstring(text)
    assert root.tag == "{http://www.w3.org/2000/svg}svg"
    assert root.attrib == {"width": "1024", "height": "1024", "viewBox": "0 0 1024 1024", "preserveAspectRatio": "xMidYMid meet"}
    assert 2 <= len(root) <= 8 and not (root.text or "").strip()
    for child in root:
        assert child.tag == "{http://www.w3.org/2000/svg}path"
        assert set(child.attrib) <= {"fill", "d", "fill-rule", "transform"}
        assert child.attrib["fill"] in {"#FEF6E1", "#FFD477"}
        assert child.attrib.get("fill-rule", "nonzero") in {"nonzero", "evenodd"}
        assert re.fullmatch(r"[MCLZ0-9.,\s+-]+", child.attrib["d"])
        assert re.fullmatch(r"translate\(512 512\) scale\(0\.[0-9]+\) translate\(-[0-9]+ -[0-9]+\)", child.attrib["transform"])
        assert not len(child) and not (child.text or "").strip() and not (child.tail or "").strip()
    assert {child.attrib["fill"] for child in root} == {"#FEF6E1", "#FFD477"}
    assert len({child.attrib["transform"] for child in root}) == 1
    return {"sha256": digest(path), "bytes": path.stat().st_size, "viewBox": root.attrib["viewBox"], "pathCount": len(root), "fills": [child.attrib["fill"] for child in root], "contentCheck": "pass"}


def components(alpha, width, minimum_area=64):
    """Eight-connected regions above half alpha; omit isolated tiny edge flecks."""
    mask = bytearray(value > 127 for value in alpha)
    height = len(mask) // width
    result = []
    for start in range(len(mask)):
        if not mask[start]:
            continue
        mask[start] = 0
        todo = [start]
        area = 0
        left = right = start % width
        top = bottom = start // width
        while todo:
            point = todo.pop()
            x, y = point % width, point // width
            area += 1
            left, right = min(left, x), max(right, x)
            top, bottom = min(top, y), max(bottom, y)
            for ny in range(max(0, y - 1), min(height, y + 2)):
                for nx in range(max(0, x - 1), min(width, x + 2)):
                    neighbor = ny * width + nx
                    if mask[neighbor]:
                        mask[neighbor] = 0
                        todo.append(neighbor)
        if area >= minimum_area:
            result.append({"areaPixels": area, "boundsInclusive": [left, top, right, bottom]})
    return sorted(result, key=lambda item: item["areaPixels"], reverse=True)


def pixels(path):
    raw = run("magick", path, "-depth", "8", "RGBA:-")
    alpha = raw[3::4]
    counts = collections.Counter(alpha)
    positions = [i for i, value in enumerate(alpha) if value]
    bounds = [min(i % 1024 for i in positions), min(i // 1024 for i in positions), max(i % 1024 for i in positions), max(i // 1024 for i in positions)]
    assert counts[0] > 0 and counts[255] > 0
    assert bounds[0] >= 128 and bounds[1] >= 128 and bounds[2] <= 895 and bounds[3] <= 895
    return {"fullyTransparentPixels": counts[0], "fullyOpaquePixels": counts[255], "antialiasedPixels": len(alpha) - counts[0] - counts[255], "alphaGtZeroBoundsInclusive": bounds, "clearPaddingCheck": "pass", "significantComponentsAtAlphaGt127MinArea64": components(alpha, 1024)}


def main():
    assert len(components(bytes([255, 0, 0, 255]), 2, 1)) == 1
    assert len(components(bytes([255, 0, 255, 0, 0, 0]), 3, 1)) == 2
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-dir", choices=(".", "corrected"), default=".")
    args = parser.parse_args()
    candidate = HERE / args.candidate_dir
    global REVIEW
    REVIEW = candidate / "review"
    for filename, expected in SOURCES.items():
        assert digest(HERE.parent / filename) == expected, filename
    stats = {name: check_svg(candidate / f"{name}.svg") for name in ("lantern", "sprout")}
    REVIEW.mkdir(exist_ok=True)
    for name in stats:
        for size in (24, 32, 384, 1024):
            run("rsvg-convert", "-w", size, "-h", size, "-o", REVIEW / f"{name}-{size}.png", candidate / f"{name}.svg")
        stats[name]["render"] = pixels(REVIEW / f"{name}-1024.png")
        for label, ground in (("dark", "#031315"), ("light", "#FEF6E1")):
            run("magick", REVIEW / f"{name}-384.png", "-background", ground, "-alpha", "remove", "-alpha", "off", REVIEW / f"{name}-{label}.png")
    font = HERE.parents[2] / "brand/fonts/SourceSans3-VariableFont_wght.ttf"
    args = ["magick", "-size", "800x870", "xc:#031315", "-fill", "#FEF6E1", "-font", font, "-pointsize", "22", "-annotate", "+20+30", "Approved PNGs / SVG candidates (not accepted)", "-pointsize", "18", "-annotate", "+40+65", "Approved PNG", "-annotate", "+420+65", "SVG reconstruction"]
    for name, y in (("lantern", 80), ("sprout", 365)):
        for path, x in ((HERE.parent / f"{name}.png", 40), (REVIEW / f"{name}-384.png", 420)):
            args += ["(", path, "-resize", "256x256", ")", "-geometry", f"+{x}+{y}", "-composite"]
    args += ["-pointsize", "17", "-annotate", "+20+665", "Actual canvas sizes: lantern PNG/SVG, then sprout PNG/SVG"]
    for size, start in ((24, 40), (32, 420)):
        args += ["-annotate", f"+{start}+710", f"{size}px"]
        for index, name in enumerate(("lantern", "sprout")):
            for offset, path in ((0, HERE.parent / f"{name}.png"), (55, REVIEW / f"{name}-{size}.png")):
                args += ["(", path, "-resize", f"{size}x{size}", ")", "-geometry", f"+{start + index * 130 + offset}+735", "-composite"]
    args += ["-annotate", "+20+835", "Inspection evidence only. Source originals unchanged; no runtime integration.", REVIEW / "comparison.png"]
    run(*args)
    composition = {name: {"expectedSignificantComponents": expected, "actualSignificantComponents": len(stats[name]["render"]["significantComponentsAtAlphaGt127MinArea64"])} for name, expected in (("lantern", 2), ("sprout", 1))}
    composition_pass = all(item["expectedSignificantComponents"] == item["actualSignificantComponents"] for item in composition.values())
    report = {"sourceAndPromptHashes": "pass", "svgContent": "pass", "renderAndTransparency": "pass", "compositionConnectivity": "pass" if composition_pass else "fail", "connectivityEvidence": composition, "renderer": run("rsvg-convert", "--version").decode().strip(), "imageMagick": run("magick", "--version").decode().splitlines()[0], "artifacts": stats, "visualApproval": "not evaluated by script; see README and designer review"}
    (REVIEW / "statistics.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if not composition_pass:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
