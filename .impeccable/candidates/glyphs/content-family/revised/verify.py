"""Focused, read-only artwork inspection; generated PNGs are review evidence only.

Exit 2 reports a failed technical constraint; visual acceptance is separate.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
BASE = HERE.parent
REVIEW = HERE / "review"
spec = importlib.util.spec_from_file_location("initial_inspection", BASE / "verify.py")
initial = importlib.util.module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(initial)
ITEMS = initial.ITEMS
REVISED = {"captured-original", "user-contribution", "evolution", "connection", "used-as-source"}
ORIGINAL_HASHES = {
    "captured-original": "2b3981f0c2a8cd28d790f7c082117bf0c492f057e39581102a5ccd98031d1813",
    "user-contribution": "c85dbc07dc21598827622da744294dcaf46568e2a550802b67f380f129a3d166",
    "ai-interpretation": "08b6f9d006c912a165a84e2a44154b276b206b869c9058dbb97f3a16f8dc4faf",
    "developing-idea": "124c1872fe5bd9f0a3d89e7fe447bd29ba37f84a005c092c66cf643ba890d354",
    "imported-original": "0c8587cfc40f36a31d868d8f58685823dcfe96c46f9ec34f7df7e9f7fc346464",
    "full-reply": "94107f8f41f58249806f092cf03bbc1c0309f0e5f51d726413d7d1698fa26ef0",
    "evolution": "dd83faf907859330e209248b94c8d38f0d9f6050f42de6f9a4fae53e805298e6",
    "connection": "58490a9b527734d9beda85167d359bd8d5679b23d7880709f4fb4ce0c7248d1e",
    "used-as-source": "dc9e5e053f03e764a855e0b24a77b0ac25f1090afb60ed2af875d87f9c4e00a1",
}
run = initial.run
sha = initial.sha


def source(name):
    return (HERE if name in REVISED else BASE) / f"{name}.svg"


def inspect(name):
    path = source(name)
    text = path.read_text()
    assert not re.search(r"<!|<\?|data:|url\s*\(|https?://(?!www\.w3\.org/2000/svg)", text, re.I)
    root = ET.fromstring(text)
    assert root.tag == "{http://www.w3.org/2000/svg}svg"
    assert root.attrib == {"width": "1024", "height": "1024", "viewBox": "0 0 1024 1024", "preserveAspectRatio": "xMidYMid meet"}
    assert len(root) and not (root.text or "").strip()
    allowed = {"path": {"fill", "fill-rule", "d"}, "circle": {"fill", "cx", "cy", "r"}, "ellipse": {"fill", "cx", "cy", "rx", "ry"}, "rect": {"fill", "x", "y", "width", "height", "rx", "ry"}}
    for child in root:
        tag = child.tag.removeprefix("{http://www.w3.org/2000/svg}")
        attrs = dict(child.attrib)
        if "transform" in attrs:
            assert name == "evolution" and attrs.pop("transform") == "translate(-84 0)"
        assert tag in allowed and set(attrs) <= allowed[tag]
        assert attrs["fill"] in {"#FEF6E1", "#FFD477"}
        assert not len(child) and not (child.text or "").strip() and not (child.tail or "").strip()
        if tag == "path":
            assert re.fullmatch(r"[MmLlHhVvCcSsQqTtAaZz0-9.,\s+eE-]+", attrs["d"])
            assert attrs.get("fill-rule", "nonzero") in {"nonzero", "evenodd"}
        else:
            assert all(re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", v) for k, v in attrs.items() if k != "fill")
    return {"source": str(path.relative_to(BASE)), "sha256": sha(path), "bytes": path.stat().st_size, "viewBox": "0 0 1024 1024", "dimensions": [1024, 1024], "safetyPaletteViewBox": "pass"}


def gold_containment(name):
    root = ET.parse(source(name)).getroot()
    masks = []
    for label, color in (("cream", "#FEF6E1"), ("gold", "#FFD477")):
        isolated = ET.fromstring(ET.tostring(root))
        for child in list(isolated):
            if child.attrib["fill"] != color:
                isolated.remove(child)
        output = REVIEW / f"{name}-{label}-mask.png"
        subprocess.run(["rsvg-convert", "-w", "1024", "-h", "1024", "-o", str(output)], input=ET.tostring(isolated), check=True)
        masks.append(run("magick", output, "-depth", "8", "RGBA:-")[3::4])
    cream, gold = masks
    outside = sum(g >= 128 and c == 0 for c, g in zip(cream, gold))
    original = ET.parse(BASE / f"{name}.svg").getroot()[0]
    actual = root[0]
    same = original.attrib["d"] == actual.attrib["d"] and original.attrib.get("fill-rule") == actual.attrib.get("fill-rule")
    assert same
    return {"creamPathAndFillRuleByteIdentical": True, "translation": actual.attrib.get("transform", "none"), "goldPixelsAtLeastHalfOpaqueOutsideCream": outside, "goldContainment": "pass" if outside == 0 else "fail"}


def boards():
    font = HERE.parents[3] / "brand/fonts/SourceSans3-VariableFont_wght.ttf"
    for label, ground, ink in (("dark", "#031315", "#FEF6E1"), ("light", "#FEF6E1", "#031315")):
        args = ["magick", "-size", "960x1060", f"xc:{ground}", "-font", font, "-fill", ink, "-pointsize", "23", "-annotate", "+24+34", "Thoughtloom — four selected keepers + five revised candidates"]
        for i, (name, title, role) in enumerate(ITEMS):
            x, y = i % 3 * 320, 64 + i // 3 * 320
            state = "REVISED" if name in REVISED else "KEEPER — unchanged"
            args += ["-pointsize", "21", "-annotate", f"+{x+20}+{y+24}", title, "(", REVIEW / f"{name}-256.png", "-resize", "160x160", ")", "-geometry", f"+{x+80}+{y+40}", "-composite"]
            for size, dx in ((16, 66), (20, 135), (24, 208)):
                args += ["(", REVIEW / f"{name}-{size}.png", ")", "-geometry", f"+{x+dx}+{y+225}", "-composite", "-pointsize", "15", "-annotate", f"+{x+dx-2}+{y+275}", f"{size}px"]
            args += ["-pointsize", "16", "-annotate", f"+{x+20}+{y+307}", state]
        run(*args, "-pointsize", "17", "-annotate", "+24+1040", "Actual-size samples; PNGs are inspection evidence, not production derivatives.", REVIEW / f"board-{label}.png")
    args = ["magick", "-size", "1000x1080", "xc:#031315", "-font", font, "-fill", "#FEF6E1", "-pointsize", "24", "-annotate", "+24+34", "Original candidates → single authorized revision pass"]
    for i, (name, title, _) in enumerate(item for item in ITEMS if item[0] in REVISED):
        y = 70 + i * 196
        args += ["-pointsize", "20", "-annotate", f"+20+{y+28}", title]
        for x, image in ((310, BASE / "review" / f"{name}-256.png"), (590, REVIEW / f"{name}-256.png")):
            args += ["(", image, "-resize", "176x176", ")", "-geometry", f"+{x}+{y}", "-composite"]
        for size, dx in ((16, 800), (20, 850), (24, 900)):
            args += ["(", REVIEW / f"{name}-{size}.png", ")", "-geometry", f"+{dx}+{y+65}", "-composite", "-pointsize", "14", "-annotate", f"+{dx}+{y+115}", f"{size}px"]
    run(*args, REVIEW / "five-before-after.png")


def main():
    assert {p.stem for p in HERE.glob("*.svg")} == REVISED
    for name, expected in ORIGINAL_HASHES.items():
        assert sha(BASE / f"{name}.svg") == expected, name
    for path, expected in initial.PROTECTED.items():
        assert sha(path) == expected, path
    REVIEW.mkdir(exist_ok=True)
    stats = {name: inspect(name) for name, _, _ in ITEMS}
    for name in stats:
        for size in (16, 20, 24, 256, 1024):
            run("rsvg-convert", "-w", size, "-h", size, "-o", REVIEW / f"{name}-{size}.png", source(name))
        stats[name]["render"] = initial.pixel_report(REVIEW / f"{name}-1024.png")
        for label, ground in (("dark", "#031315"), ("light", "#FEF6E1")):
            run("magick", REVIEW / f"{name}-256.png", "-background", ground, "-alpha", "remove", "-alpha", "off", REVIEW / f"{name}-{label}.png")
    for name in ("captured-original", "user-contribution", "evolution"):
        stats[name]["repair"] = gold_containment(name)
    boards()
    failed = [name for name, item in stats.items() if item["render"]["clearPadding128px"] == "fail" or item.get("repair", {}).get("goldContainment") == "fail"]
    report = {"originalNineAndAcceptedRuntimeHashes": "pass", "fourSelectedKeeperHashes": "pass", "svgSafetyPaletteViewBox": "pass", "renderTransparency": "pass", "projectedSizes": [16, 20, 24], "technicalFailures": failed, "renderer": run("rsvg-convert", "--version").decode().strip(), "imageMagick": run("magick", "--version").decode().splitlines()[0], "artifacts": stats, "visualReview": "Separate designer assessment; technical checks do not grant artwork approval."}
    (REVIEW / "statistics.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if failed:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
