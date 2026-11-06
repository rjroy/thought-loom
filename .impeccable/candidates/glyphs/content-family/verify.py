"""Inspect the authorized nine SVG candidates; never edit source artwork.

Requires installed rsvg-convert and ImageMagick. PNG outputs are review evidence,
not approved runtime derivatives. Exit 2 means a technical constraint failed.
Human silhouette/semantic assessment is recorded separately in README.md.
"""

import hashlib
import json
import pathlib
import re
import subprocess
import xml.etree.ElementTree as ET


HERE = pathlib.Path(__file__).resolve().parent
REVIEW = HERE / "review"
ITEMS = [
    ("captured-original", "Original capture", "material"),
    ("user-contribution", "Contribution", "material"),
    ("ai-interpretation", "Interpretation", "material"),
    ("developing-idea", "Developing idea", "material"),
    ("imported-original", "Imported source", "material"),
    ("full-reply", "Full reply", "record role"),
    ("evolution", "Evolution", "relationship"),
    ("connection", "Discovered connection", "relationship"),
    ("used-as-source", "Used as source", "relationship"),
]
PROTECTED = {
    HERE.parent / "production/corrected/lantern.svg": "24cda858b91c39e01711cf1a8692e5aaa6d7657dc6165ab40265bfc6a9dd7329",
    HERE.parent / "production/corrected/sprout.svg": "585b9522651ab998079ff283af994ce12aca44792359d4dc4369ed56f997b4b1",
    HERE.parents[3] / "apps/web/public/glyphs/lantern.svg": "24cda858b91c39e01711cf1a8692e5aaa6d7657dc6165ab40265bfc6a9dd7329",
    HERE.parents[3] / "apps/web/public/glyphs/sprout.svg": "585b9522651ab998079ff283af994ce12aca44792359d4dc4369ed56f997b4b1",
}


def run(*args):
    return subprocess.check_output([str(arg) for arg in args])


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_source(path):
    text = path.read_text()
    assert not re.search(r"<!|<\?|data:|url\s*\(|https?://(?!www\.w3\.org/2000/svg)", text, re.I)
    root = ET.fromstring(text)
    assert root.tag == "{http://www.w3.org/2000/svg}svg"
    assert root.attrib == {"width": "1024", "height": "1024", "viewBox": "0 0 1024 1024", "preserveAspectRatio": "xMidYMid meet"}
    assert len(root) and not (root.text or "").strip()
    fills = []
    for child in root:
        tag = child.tag.removeprefix("{http://www.w3.org/2000/svg}")
        attrs = {"path": {"fill", "fill-rule", "d"}, "circle": {"fill", "cx", "cy", "r"}, "ellipse": {"fill", "cx", "cy", "rx", "ry"}, "rect": {"fill", "x", "y", "width", "height", "rx", "ry"}}
        assert tag in attrs and set(child.attrib) <= attrs[tag]
        assert child.attrib["fill"] in {"#FEF6E1", "#FFD477"}
        assert not len(child) and not (child.text or "").strip() and not (child.tail or "").strip()
        if tag == "path":
            assert re.fullmatch(r"[MmLlHhVvCcSsQqTtAaZz0-9.,\s+eE-]+", child.attrib["d"])
            assert child.attrib.get("fill-rule", "nonzero") in {"nonzero", "evenodd"}
        else:
            for key, value in child.attrib.items():
                if key != "fill":
                    assert re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value)
        fills.append(child.attrib["fill"])
    return {"sourceSha256": sha(path), "bytes": path.stat().st_size, "viewBox": root.attrib["viewBox"], "dimensions": [1024, 1024], "elementCount": len(root), "fills": sorted(set(fills)), "safetyPaletteViewBox": "pass"}


def pixel_report(path):
    raw = run("magick", path, "-depth", "8", "RGBA:-")
    alpha = raw[3::4]
    assert len(alpha) == 1024 * 1024
    occupied = [i for i, value in enumerate(alpha) if value]
    bounds = [min(i % 1024 for i in occupied), min(i // 1024 for i in occupied), max(i % 1024 for i in occupied), max(i // 1024 for i in occupied)]
    assert alpha.count(0) and alpha.count(255)
    padding = bounds[0] >= 128 and bounds[1] >= 128 and bounds[2] <= 895 and bounds[3] <= 895
    return {"fullyTransparentPixels": alpha.count(0), "fullyOpaquePixels": alpha.count(255), "antialiasedPixels": len(alpha) - alpha.count(0) - alpha.count(255), "nonzeroAlphaBoundsInclusive": bounds, "clearPadding128px": "pass" if padding else "fail"}


def board(ground, ink, output):
    font = HERE.parents[2] / "brand/fonts/SourceSans3-VariableFont_wght.ttf"
    args = ["magick", "-size", "960x1060", f"xc:{ground}", "-font", font, "-fill", ink, "-pointsize", "24", "-annotate", "+24+34", "Thoughtloom — nine SVG candidates, not approved"]
    for index, (name, label, role) in enumerate(ITEMS):
        x, y = (index % 3) * 320, 64 + (index // 3) * 320
        args += ["-pointsize", "21", "-annotate", f"+{x+20}+{y+24}", label, "(", REVIEW / f"{name}-256.png", "-resize", "160x160", ")", "-geometry", f"+{x+80}+{y+40}", "-composite"]
        for size, dx in ((16, 66), (20, 135), (24, 208)):
            args += ["(", REVIEW / f"{name}-{size}.png", ")", "-geometry", f"+{x+dx}+{y+225}", "-composite", "-pointsize", "15", "-annotate", f"+{x+dx-2}+{y+275}", f"{size}px"]
        args += ["-pointsize", "16", "-annotate", f"+{x+20}+{y+307}", role]
    args += ["-pointsize", "17", "-annotate", "+24+1040", "Exact SVG renders; small samples are actual 16 / 20 / 24px canvases.", output]
    run(*args)


def family_board():
    font = HERE.parents[2] / "brand/fonts/SourceSans3-VariableFont_wght.ttf"
    refs = [("accepted-lantern", "Accepted lantern"), ("accepted-sprout", "Accepted sprout")]
    for short, source in (("lantern", HERE.parent / "production/corrected/lantern.svg"), ("sprout", HERE.parent / "production/corrected/sprout.svg")):
        run("rsvg-convert", "-w", 144, "-h", 144, "-o", REVIEW / f"accepted-{short}.png", source)
    all_items = refs + [(name, label) for name, label, _ in ITEMS]
    args = ["magick", "-size", "1100x490", "xc:#031315", "-font", font, "-fill", "#FEF6E1", "-pointsize", "22", "-annotate", "+20+30", "Existing accepted pair + new candidate vocabulary (same 144px canvases)"]
    for index, (name, label) in enumerate(all_items):
        x, y = (index % 6) * 182, 50 + (index // 6) * 210
        image = REVIEW / (f"{name}.png" if name.startswith("accepted-") else f"{name}-256.png")
        args += ["(", image, "-resize", "144x144", ")", "-geometry", f"+{x+18}+{y}", "-composite", "-pointsize", "16", "-annotate", f"+{x+10}+{y+170}", label]
    args += [REVIEW / "family-comparison.png"]
    run(*args)


def main():
    for path, expected in PROTECTED.items():
        assert sha(path) == expected, path
    assert {path.stem for path in HERE.glob("*.svg")} == {name for name, _, _ in ITEMS}
    stats = {name: check_source(HERE / f"{name}.svg") for name, _, _ in ITEMS}
    REVIEW.mkdir(exist_ok=True)
    for name in stats:
        for size in (16, 20, 24, 256, 1024):
            run("rsvg-convert", "-w", size, "-h", size, "-o", REVIEW / f"{name}-{size}.png", HERE / f"{name}.svg")
        stats[name]["render"] = pixel_report(REVIEW / f"{name}-1024.png")
        for label, ground in (("dark", "#031315"), ("light", "#FEF6E1")):
            run("magick", REVIEW / f"{name}-256.png", "-background", ground, "-alpha", "remove", "-alpha", "off", REVIEW / f"{name}-{label}.png")
    board("#031315", "#FEF6E1", REVIEW / "board-dark.png")
    board("#FEF6E1", "#031315", REVIEW / "board-light.png")
    family_board()
    padding_pass = all(item["render"]["clearPadding128px"] == "pass" for item in stats.values())
    report = {"inventory": "pass: all nine sources exist", "protectedSourceAndRuntimeHashes": "pass", "svgSafetyPaletteViewBox": "pass", "renderTransparency": "pass", "padding": "pass" if padding_pass else "fail", "renderSizesPx": [16, 20, 24, 256, 1024], "renderer": run("rsvg-convert", "--version").decode().strip(), "imageMagick": run("magick", "--version").decode().splitlines()[0], "artifacts": stats, "visualReview": "human assessment in README; script success never implies approval"}
    (REVIEW / "statistics.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if not padding_pass:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
