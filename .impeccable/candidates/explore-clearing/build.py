"""Mechanical, deterministic derivative of the exact user-approved scene.

No image generation, repainting, silhouette reconstruction or runtime writes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import zlib

HERE = Path(__file__).resolve().parent
MAGICK_VERSION = 'Version: ImageMagick 7.1.2-34 Q16-HDRI x86_64 c5d4ca8a0:20261014 https://imagemagick.org'
SOURCE_SHA256 = '73dca3c3d76b1f0731d3a3a9339eb4a73138ae0d25c846edfc3d676cad9d44ec'
SOURCE_SIZE = (2172, 724)
OUTPUT_SIZE = (1122, 374)  # Exact 3:1, at least 2x the approved 560px display width.
BACKDROP_RGB = (2, 30, 35)
INNER_DISTANCE = 12
OUTER_DISTANCE = 36
OUTPUT_NAME = 'lantern-clearing.png'


def run(*args, data=None):
    return subprocess.check_output([str(arg) for arg in args], input=data)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def embed_origin(png, origin):
    """Add deterministic PNG tEXt provenance without changing decoded pixels."""
    if not png.startswith(b'\x89PNG\r\n\x1a\n') or png[-8:-4] != b'IEND':
        raise ValueError('Expected complete PNG with final IEND chunk')
    payload = b'impeccable:prompt\0' + origin.encode('ascii')
    chunk = b'tEXt' + payload
    return png[:-12] + struct.pack('>I', len(payload)) + chunk + struct.pack('>I', zlib.crc32(chunk)) + png[-12:]


def remove_backdrop(rgb, width, height, *, backdrop, inner, outer):
    """Separate a near-uniform backdrop by color, not by drawn subject contours.

    Chebyshev sRGB distance <=inner is transparent; >=outer is opaque.
    Smoothstep between the bounds keeps antialiased transitions. Retained RGB
    is never repainted; fully transparent RGB is zeroed. Dark cat/ground ink
    matching the sky becomes transparent and takes the consumer's page ground.
    All inputs are explicit so unit fixtures do not depend on artwork/tuning.
    """
    if width < 1 or height < 1 or len(rgb) != width * height * 3:
        raise ValueError('Invalid RGB dimensions')
    if len(backdrop) != 3 or any(not isinstance(c, int) or not 0 <= c <= 255 for c in backdrop):
        raise ValueError('Invalid backdrop color')
    if not 0 <= inner < outer <= 255:
        raise ValueError('Invalid matte distances')
    rgba = bytearray(width * height * 4)
    counts = {'transparent': 0, 'partial': 0, 'opaque': 0}
    for index in range(width * height):
        at = index * 3
        pixel = rgb[at:at + 3]
        distance = max(abs(pixel[channel] - backdrop[channel]) for channel in range(3))
        if distance <= inner:
            alpha = 0
        elif distance >= outer:
            alpha = 255
        else:
            t = (distance - inner) / (outer - inner)
            alpha = round(255 * t * t * (3 - 2 * t))
        dest = index * 4
        if alpha:
            rgba[dest:dest + 3] = pixel
        rgba[dest + 3] = alpha
        counts['transparent' if alpha == 0 else 'opaque' if alpha == 255 else 'partial'] += 1
    return bytes(rgba), counts


def build_once():
    version = run('magick', '--version').decode().splitlines()[0]
    if version != MAGICK_VERSION:
        raise RuntimeError(f'Unverified ImageMagick version: {version}')
    source = HERE / 'source.png'
    source_bytes = source.read_bytes()
    if sha(source_bytes) != SOURCE_SHA256:
        raise RuntimeError('Approved source identity mismatch')
    size = tuple(map(int, run('magick', 'identify', '-format', '%w %h', source).split()))
    if size != SOURCE_SIZE:
        raise RuntimeError('Approved source dimensions mismatch')
    rgb = run('magick', source, '-depth', '8', 'RGB:-')
    rgba, counts = remove_backdrop(rgb, *size, backdrop=BACKDROP_RGB, inner=INNER_DISTANCE, outer=OUTER_DISTANCE)
    recipe_sha = sha(Path(__file__).read_bytes())
    origin = f'Approved Thoughtloom wide clearing; source.png SHA256 {SOURCE_SHA256}; mechanical color-matte and Lanczos resample; build.py SHA256 {recipe_sha}; original generation request retained in source.png.'
    result = run('magick', '-size', f'{size[0]}x{size[1]}', '-depth', '8', 'RGBA:-',
                 '-filter', 'Lanczos', '-resize', f'{OUTPUT_SIZE[0]}x{OUTPUT_SIZE[1]}!',
                 '-strip',
                 '-define', 'png:exclude-chunk=date,time', '-define', 'png:compression-level=9', 'PNG32:-', data=rgba)
    result = embed_origin(result, origin)
    report = {
        'status': 'production-derivative-candidate-not-integrated',
        'source': 'source.png', 'sourceSha256': SOURCE_SHA256, 'sourceDimensions': size,
        'recipeSha256': recipe_sha, 'imageMagick': version,
        'operation': 'Color-derived alpha matte, retained RGB unchanged before resampling; no repainting or contour masks',
        'matte': {'backdropRgb': BACKDROP_RGB, 'innerDistance': INNER_DISTANCE, 'outerDistance': OUTER_DISTANCE, 'sourceAlphaCounts': counts},
        'output': OUTPUT_NAME, 'outputDimensions': OUTPUT_SIZE,
        'outputSha256': sha(result), 'outputBytes': len(result), 'resampling': 'Lanczos',
        'consumer': 'Initial Explore only; 560px image width, desktop 560x168 crop and narrow left-bottom crop; existing frame-edge fade remains a consumer presentation, not baked twice',
    }
    return result, report


def main():
    parser = argparse.ArgumentParser(description='Build the approved scene into a separate candidate directory; never promotes to public/')
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    target = args.output_dir.resolve()
    if target == HERE or target in HERE.parents or 'public' in target.parts:
        parser.error('Use a separate non-public candidate output directory')
    print('Building approved clearing derivative: first independent pass', flush=True)
    first, report = build_once()
    print('Rebuilding approved clearing derivative: second independent pass', flush=True)
    second, second_report = build_once()
    if first != second or report != second_report:
        raise RuntimeError('Independent derivative passes differ')
    target.mkdir(parents=True, exist_ok=True)
    if any(path.name not in {OUTPUT_NAME, 'build-receipt.json'} for path in target.iterdir()):
        parser.error('Candidate directory contains unrelated files')
    (target / OUTPUT_NAME).write_bytes(first)
    report['reproducibility'] = 'Two complete independent passes from packaged approved source; byte-identical PNG and report'
    (target / 'build-receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
