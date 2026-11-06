"""Reproducible derivatives from approved packaged artwork; no source edits.

Seven SVG byte copies; two PNG alpha-cleaned, framed runtime candidates.
Only installed ImageMagick is used. Source RGB shading is not flattened.
"""
from collections import deque
import hashlib
import json
import math
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
BASE = HERE.parent
MAGICK_VERSION = 'Version: ImageMagick 7.1.2-34 Q16-HDRI x86_64 c5d4ca8a0:20261014 https://imagemagick.org'
SOURCES = {
    'captured-original.svg': ('revised/captured-original.svg', '171f35874111014e31e63beeb313a861874959cc25608f65d1de76bfd397f980'),
    'user-contribution.svg': ('revised/user-contribution.svg', '5494ffc3d5576d6f4365c3fcdf63c880451c1966ff3bceb0a4c4f8d0463a0625'),
    'ai-interpretation.svg': ('ai-interpretation.svg', '08b6f9d006c912a165a84e2a44154b276b206b869c9058dbb97f3a16f8dc4faf'),
    'developing-idea.svg': ('developing-idea.svg', '124c1872fe5bd9f0a3d89e7fe447bd29ba37f84a005c092c66cf643ba890d354'),
    'imported-original.svg': ('imported-original.svg', '0c8587cfc40f36a31d868d8f58685823dcfe96c46f9ec34f7df7e9f7fc346464'),
    'full-reply.svg': ('full-reply.svg', '94107f8f41f58249806f092cf03bbc1c0309f0e5f51d726413d7d1698fa26ef0'),
    'evolution.svg': ('revised/evolution.svg', '0b820e6ca44f4f1f3ef7c8eb2417688894bd0da037cdea680c8f326764bf2029'),
    'connection.png': ('raster-relationships/connection.png', '84eb7314de1c95008eb9455cf24336f3284462dd4b4c766ebe51ffd6552df147'),
    'used-as-source.png': ('raster-relationships/used-as-source.png', '6fa474193e0521da8e45917e7e567fee60aaea0398e4e7350c544160c1aecaac'),
}


def run(*args, data=None):
    return subprocess.check_output([str(a) for a in args], input=data)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def clean_rgba(raw, width, height, minimum_component_area):
    """Keep substantial alpha>=128 components and their one-pixel AA envelope.

    Eight-neighbor connectivity preserves diagonal shapes and ring topology.
    Remove isolated debris; stabilize alpha>=250 to255. RGB of every retained
    pixel stays untouched, including source shading. Transparent RGB becomes0.
    The area threshold is explicit and fixture-testable, not production data.
    """
    if len(raw) != width * height * 4 or min(width, height, minimum_component_area) < 1:
        raise ValueError('Invalid RGBA dimensions or component threshold')
    alpha = raw[3::4]
    visited = bytearray(width * height)
    keep = bytearray(width * height)
    areas, retained = [], []

    def neighbors(i):
        x, y = i % width, i // width
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if (dx or dy) and 0 <= x + dx < width and 0 <= y + dy < height:
                    yield (y + dy) * width + x + dx

    for start, a in enumerate(alpha):
        if a < 128 or visited[start]:
            continue
        visited[start] = 1
        queue = deque([start])
        component = []
        while queue:
            i = queue.popleft()
            component.append(i)
            for j in neighbors(i):
                if alpha[j] >= 128 and not visited[j]:
                    visited[j] = 1
                    queue.append(j)
        areas.append(len(component))
        if len(component) >= minimum_component_area:
            retained.append(len(component))
            for i in component:
                keep[i] = 1
    if not retained:
        raise ValueError('No substantial foreground component')
    envelope = keep.copy()
    for i, kept in enumerate(keep):
        if kept:
            for j in neighbors(i):
                envelope[j] = 1
    cleaned = bytearray(raw)
    for i, a in enumerate(alpha):
        at = 4 * i
        if not envelope[i] or not a:
            cleaned[at:at+4] = b'\0\0\0\0'
        elif a >= 250:
            cleaned[at+3] = 255
    assert all(cleaned[4*i+3] >= 128 for i, k in enumerate(keep) if k)
    assert all(cleaned[4*i:4*i+3] == raw[4*i:4*i+3] for i in range(width*height) if cleaned[4*i+3])
    return bytes(cleaned), {'minimumComponentArea': minimum_component_area, 'allComponentAreasDescending': sorted(areas, reverse=True), 'retainedComponentAreasDescending': sorted(retained, reverse=True), 'retainedComponentCount': len(retained), 'substantialCorePixelsPreserved': sum(keep), 'changedAlphaPixelCount': sum(a != b for a, b in zip(alpha, cleaned[3::4])), 'retainedRgbUnchangedBeforeResampling': True}


def build_once():
    outputs, report = {}, {}
    for name, (relative, expected) in SOURCES.items():
        source = BASE / relative
        original = source.read_bytes()
        assert sha(original) == expected, source
        item = {'source': '../' + relative, 'sourceSha256': expected, 'sourceBytes': len(original)}
        if name.endswith('.svg'):
            result = original
            item['operation'] = 'byte-identical SVG copy; no framing or path edits'
        else:
            width, height = map(int, run('magick', 'identify', '-format', '%w %h', source).split())
            raw = run('magick', source, '-depth', '8', 'RGBA:-')
            cleaned, details = clean_rgba(raw, width, height, math.ceil(width*height*0.005))
            # Trim only debris-cleared transparent space. Four transparent border
            # pixels protect legitimate AA during Lanczos resampling. 760px total
            # content box leaves >=132px padding on a centered1024px canvas.
            result = run('magick', '-size', f'{width}x{height}', '-depth', '8', 'RGBA:-', '-trim', '+repage', '-bordercolor', 'none', '-border', '4', '-filter', 'Lanczos', '-resize', '760x760', '-gravity', 'center', '-background', 'none', '-extent', '1024x1024', '-strip', '-define', 'png:exclude-chunk=date,time', '-define', 'png:compression-level=9', 'PNG32:-', data=cleaned)
            item.update({'operation': 'alpha cleanup, transparent-space trim, uniform aspect-preserving framing; shading preserved', 'sourceDimensions': [width, height], 'cleanup': details, 'outputDimensions': [1024,1024], 'resampling': 'Lanczos', 'contentBoxMaxPx': 760, 'transparentBorderBeforeResamplingPx': 4})
        outputs[name] = result
        item.update({'output': 'runtime/' + name, 'outputSha256': sha(result), 'outputBytes': len(result)})
        report[name] = item
    return outputs, report


def main():
    version = run('magick','--version').decode().splitlines()[0]
    assert version == MAGICK_VERSION, f'Unverified ImageMagick version: {version}'
    first, report = build_once()
    second, second_report = build_once()  # Reload every immutable packaged input.
    assert first == second and report == second_report
    target = HERE / 'runtime'
    target.mkdir(exist_ok=True)
    assert not set(p.name for p in target.iterdir()) - set(SOURCES)
    for name, data in first.items():
        (target / name).write_bytes(data)
    receipt = {'status': 'production derivative candidates; user approval and app integration pending', 'reproducibility': 'two complete independent passes from original packaged sources, all nine output byte strings identical', 'imageMagick': version, 'recipeSha256': sha(Path(__file__).read_bytes()), 'artifacts': report}
    (HERE/'build-report.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt,indent=2))


if __name__ == '__main__':
    main()
