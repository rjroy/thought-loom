"""Verify approved inputs, output identities, restricted SVGs and rendered alpha."""
import re
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from build import SOURCES, build_once, sha, run

HERE = Path(__file__).resolve().parent
RUNTIME = HERE / 'runtime'
PUBLIC = HERE.parents[4] / 'apps/web/public/glyphs'


def inspect(name):
    path = RUNTIME / f'{name}.svg'
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
    return {"source": str(path.relative_to(HERE)), "sha256": sha(path.read_bytes()), "bytes": path.stat().st_size, "viewBox": "0 0 1024 1024", "dimensions": [1024, 1024], "safetyPaletteViewBox": "pass"}



def pixel_report(path):
    raw = run("magick", path, "-depth", "8", "RGBA:-")
    alpha = raw[3::4]
    assert len(alpha) == 1024 * 1024
    occupied = [i for i, value in enumerate(alpha) if value]
    bounds = [min(i % 1024 for i in occupied), min(i // 1024 for i in occupied), max(i % 1024 for i in occupied), max(i // 1024 for i in occupied)]
    assert alpha.count(0) and alpha.count(255)
    padding = bounds[0] >= 128 and bounds[1] >= 128 and bounds[2] <= 895 and bounds[3] <= 895
    return {"fullyTransparentPixels": alpha.count(0), "fullyOpaquePixels": alpha.count(255), "antialiasedPixels": len(alpha) - alpha.count(0) - alpha.count(255), "nonzeroAlphaBoundsInclusive": bounds, "clearPadding128px": "pass" if padding else "fail"}



def main():
    assert {p.name for p in RUNTIME.iterdir()} == set(SOURCES)
    first, _ = build_once()
    second, _ = build_once()
    assert first == second
    with tempfile.TemporaryDirectory(prefix='glyph-verify-') as tmp:
        for name, data in first.items():
            path = RUNTIME / name
            assert path.read_bytes() == data == (PUBLIC / name).read_bytes(), name
            if path.suffix == '.svg':
                inspect(path.stem)
                rendered = Path(tmp) / (name + '.png')
                run('rsvg-convert', '-w', '1024', '-h', '1024', '-o', rendered, path)
            else:
                assert run('magick', 'identify', '-format', '%w %h', path) == b'1024 1024'
                rendered = path
            assert pixel_report(rendered)['clearPadding128px'] == 'pass', name
            print(f'{name}: source hash, reproducibility, public identity, alpha and padding pass')
    for name, expected in [('lantern', '24cda858b91c39e01711cf1a8692e5aaa6d7657dc6165ab40265bfc6a9dd7329'), ('sprout', '585b9522651ab998079ff283af994ce12aca44792359d4dc4369ed56f997b4b1')]:
        data = (HERE.parents[1] / 'production/corrected' / f'{name}.svg').read_bytes()
        assert sha(data) == expected and data == (PUBLIC / f'{name}.svg').read_bytes()
        print(f'{name}: source and public identity pass')


if __name__ == '__main__':
    main()
