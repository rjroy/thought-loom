"""Extract exact existing WebPs and a retimed reveal contract from the approved study.

No raster conversion, generation, metadata rewrite or application integration.
"""
import argparse
import base64
import copy
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
SVG = "{http://www.w3.org/2000/svg}"
STUDY_SHA256 = "4bf00c2ef8d646535449b2ff6e424126258c26b470aad21ac1147376d4780fec"
LAYERS = {
    "clean-plate": ("splash-landscape.webp", "1ce48ed5c1ec9547fc8c6167818a666a3ffe00ca4c4501ef9e0d8b516f8a6192"),
    "original-art": ("splash-complete.webp", "ec9d6e81e99fc90695aa5e5787a896f5fd3300729122520e08991dc455cf52e8"),
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def extract_webp(scene, image_id):
    matches = [element for element in scene.iter(f"{SVG}image") if element.get("id") == image_id]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one {image_id} image")
    href = matches[0].get("href", "")
    prefix = "data:image/webp;base64,"
    if not href.startswith(prefix):
        raise ValueError("Expected an embedded WebP")
    return base64.b64decode(href[len(prefix):], validate=True)


def map_time(value, old_min, old_max, new_min, new_max):
    if old_max <= old_min:
        raise ValueError("Source time range must increase")
    return new_min + (value - old_min) / (old_max - old_min) * (new_max - new_min)


def normalize_scene_markup(markup):
    # Approved HTML has a redundant identical mask attribute. Browsers accept it,
    # XML does not. Normalize only the extraction copy, never the approved study.
    for tag in re.findall(r'<image\b[^>]*>', markup):
        masks = re.findall(r'\bmask="([^"]*)"', tag)
        if len(masks) > 1:
            if len(set(masks)) != 1:
                raise ValueError("Conflicting duplicate image masks")
            normalized = re.sub(r'\s+mask="[^"]*"', "", tag, count=len(masks) - 1)
            markup = markup.replace(tag, normalized, 1)
    return markup


def expected_package():
    source = (ROOT / "study.html").read_bytes()
    if sha256(source) != STUDY_SHA256:
        raise ValueError("Approved study changed; do not silently extract a different source")
    match = re.search(r'<svg class="art"[\s\S]*?</svg>', source.decode())
    if not match:
        raise ValueError("Missing supplied inline scene")
    scene = ET.fromstring(normalize_scene_markup(match.group(0)))
    output = {}
    for image_id, (filename, identity) in LAYERS.items():
        data = extract_webp(scene, image_id)
        if sha256(data) != identity:
            raise ValueError(f"Approved layer changed: {image_id}")
        output[filename] = data

    # Preserve all supplied geometry/material attributes; change timing metadata only.
    defs = copy.deepcopy(scene.find(f"{SVG}defs"))
    if defs is None:
        raise ValueError("Missing supplied reveal definitions")
    for element in defs.iter():
        if element.tag == f"{SVG}path":
            start = map_time(float(element.attrib["data-start"]), 1.9, 14.1, 230, 1000)
            duration = 350
        elif element.tag == f"{SVG}circle" and "data-start" in element.attrib:
            if element.get("id") == "center-plant":
                start, duration = 1150, 500
            else:
                start = map_time(float(element.attrib["data-start"]), .9, 15.8, 150, 1000)
                duration = 350
        else:
            continue
        element.set("data-start", repr(start / 1000))
        element.set("data-duration", repr(duration / 1000))
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    reveal = ET.Element(f"{SVG}svg", {"viewBox": scene.attrib["viewBox"]})
    reveal.append(defs)
    output["reveal.svg"] = ET.tostring(reveal, encoding="utf-8", xml_declaration=True) + b"\n"
    receipt = {
        "source": "../study.html",
        "sourceSha256": STUDY_SHA256,
        "operation": "Decode existing base64 WebPs without changing bytes; copy existing reveal definitions and retarget only timing metadata to the approved study.",
        "recipe": "../build.py",
        "tools": "Python 3 standard library only; no raster encoder or generation",
        "images": {name: {"bytes": len(data), "sha256": sha256(data), "nativeSize": [1536, 1024]} for name, data in output.items() if name.endswith(".webp")},
        "reveal": {"file": "reveal.svg", "bytes": len(output["reveal.svg"]), "sha256": sha256(output["reveal.svg"]), "connections": 13, "peripheralNodes": 12, "centerNodes": 1, "consumer": "Inline matching defs in runtime SVG. Standalone defs-only SVG is an assembly reference, not a publicly served illustration or an external-document mask."},
        "timelineMs": {"landscape": [0, 150], "peripheral": [150, 1350], "center": [1150, 1650], "hold": [1650, 1950], "dissolve": [1950, 2400]},
        "consumer": "Landscape WebP beneath completed-scene WebP; reveal mask applies only to completed scene until 1650ms, then remove it. Both are full opaque 3:2 scenes, not transparent cutouts. Keep the still landscape, original framing and entire overlay dissolve.",
        "publicPromotion": ["/backgrounds/splash-landscape.webp", "/backgrounds/splash-complete.webp"],
        "displayEvidence": {"desktopViewport": [1440, 900], "desktopArt": [1218, 812], "phoneViewport": [390, 844], "phoneArt": [390, 260]},
    }
    output["receipt.json"] = (json.dumps(receipt, indent=2) + "\n").encode()
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="Compare existing package to fresh in-memory extraction; write nothing")
    args = parser.parse_args()
    target = ROOT / "production"
    package = expected_package()
    if args.verify:
        for name, data in package.items():
            if (target / name).read_bytes() != data:
                raise ValueError(f"Packaged derivative differs: {name}")
        print("PASS: exact WebP bytes, unchanged reveal geometry, approved timing metadata and deterministic receipt")
    else:
        target.mkdir(exist_ok=True)
        for name, data in package.items():
            destination = target / name
            if destination.exists() and destination.read_bytes() != data:
                raise ValueError(f"Refusing to replace a different candidate: {destination}")
            destination.write_bytes(data)
        print("Prepared source-preserving root-splash package; no runtime files promoted")


if __name__ == "__main__":
    main()
