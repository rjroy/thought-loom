"""Preserve the approved RGBA canopy; resize only, never repair/repaint it."""
import argparse
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import zlib

HERE = Path(__file__).resolve().parent
SOURCE_SHA256 = '94f3beee00bc89baf7706844e95760608d279830df303fc55b75d31cee4c5ab4'
SOURCE_SIZE = (1024, 1536)
DISPLAY_WIDTH = 196
PIXEL_RATIO = 2
OUTPUT_NAME = 'capture-canopy.png'
MAGICK_VERSION = 'Version: ImageMagick 7.1.2-34 Q16-HDRI x86_64 c5d4ca8a0:20261014 https://imagemagick.org'


def run(*args, data=None):
    return subprocess.check_output([str(arg) for arg in args], input=data)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def output_size(width, height, display_width, pixel_ratio):
    """Require exact integer aspect preservation, never silently stretch/crop."""
    if any(type(value) is not int or value < 1 for value in (width, height, display_width, pixel_ratio)):
        raise ValueError('Dimensions and density must be positive integers')
    target_width = display_width * pixel_ratio
    target_height = Fraction(height * target_width, width)
    if target_height.denominator != 1:
        raise ValueError('Requested size cannot preserve the exact source ratio')
    return target_width, int(target_height)


def embed_origin(png, origin):
    """Deterministic provenance chunk; no decoded pixel change."""
    if not png.startswith(b'\x89PNG\r\n\x1a\n') or png[-8:-4] != b'IEND':
        raise ValueError('Expected complete PNG with final IEND chunk')
    payload = b'impeccable:prompt\0' + origin.encode('ascii')
    chunk = b'tEXt' + payload
    return png[:-12] + struct.pack('>I', len(payload)) + chunk + struct.pack('>I', zlib.crc32(chunk)) + png[-12:]


def convert_png(source, size, origin):
    """RGBA Lanczos resampling only. Existing soft alpha is not thresholded."""
    if len(size) != 2 or any(type(value) is not int or value < 1 for value in size):
        raise ValueError('Invalid output dimensions')
    png = run('magick', 'PNG:-', '-alpha', 'on', '-filter', 'Lanczos',
              '-resize', f'{size[0]}x{size[1]}!', '-strip',
              '-define', 'png:exclude-chunk=date,time', '-define', 'png:compression-level=9', 'PNG32:-', data=source)
    return embed_origin(png, origin)


def alpha_summary(png):
    alpha = run('magick', 'PNG:-', '-alpha', 'extract', '-depth', '8', 'GRAY:-', data=png)
    return {'minimum': min(alpha), 'maximum': max(alpha), 'transparentPixels': alpha.count(0), 'partialPixels': sum(0 < value < 255 for value in alpha), 'opaquePixels': alpha.count(255)}


def build_once():
    version = run('magick', '--version').decode().splitlines()[0]
    if version != MAGICK_VERSION:
        raise RuntimeError(f'Unverified ImageMagick build: {version}')
    source = (HERE / 'source.png').read_bytes()
    if sha(source) != SOURCE_SHA256:
        raise RuntimeError('Immutable approved source identity mismatch')
    dimensions = tuple(map(int, run('magick', 'identify', '-format', '%w %h', 'PNG:-', data=source).split()))
    if dimensions != SOURCE_SIZE:
        raise RuntimeError('Approved source dimensions mismatch')
    size = output_size(*dimensions, DISPLAY_WIDTH, PIXEL_RATIO)
    recipe_sha = sha(Path(__file__).read_bytes())
    origin = f'Approved Thoughtloom Capture canopy; source.png SHA256 {SOURCE_SHA256}; RGBA Lanczos resize only; original soft alpha retained, no threshold/matte/crop/repaint; build.py SHA256 {recipe_sha}; original generation request retained in immutable source.png.'
    candidate = convert_png(source, size, origin)
    alpha = alpha_summary(candidate)
    if not alpha['transparentPixels'] or not alpha['partialPixels']:
        raise RuntimeError('Expected transparent space and preserved soft alpha')
    report = {
        'status': 'prepared-derivative-not-integrated',
        'source': 'source.png', 'sourceSha256': SOURCE_SHA256, 'sourceDimensions': list(dimensions),
        'recipeSha256': recipe_sha, 'imageMagick': version,
        'operation': 'RGBA Lanczos resample only, no alpha threshold, new matte, cleanup, repaint, crop or recentering',
        'displaySize': [DISPLAY_WIDTH, DISPLAY_WIDTH * dimensions[1] // dimensions[0]], 'pixelRatio': PIXEL_RATIO,
        'output': OUTPUT_NAME, 'outputDimensions': list(size), 'outputSha256': sha(candidate), 'outputBytes': len(candidate),
        'sourceBytes': len(source), 'alpha': alpha,
    }
    return candidate, report


def main():
    parser = argparse.ArgumentParser(description='Prepare/verify a separate canopy derivative; never promotes to public/')
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--verify', action='store_true', help='Rebuild twice and compare existing candidate without writing files')
    args = parser.parse_args()
    target = args.output_dir.resolve()
    if target == HERE or target in HERE.parents or 'public' in target.parts:
        parser.error('Use a separate non-public candidate directory')
    print('Converting approved canopy: first independent pass', flush=True)
    first, report = build_once()
    print('Converting approved canopy: second independent pass', flush=True)
    second, second_report = build_once()
    if first != second or report != second_report:
        raise RuntimeError('Independent conversion passes differ')
    if args.verify:
        if (target / OUTPUT_NAME).read_bytes() != first:
            raise RuntimeError('Candidate bytes differ from approved-source conversion')
        recorded = json.loads((target / 'build-receipt.json').read_text())
        if recorded != report:
            raise RuntimeError('Candidate receipt differs from current source/recipe')
        print(json.dumps({'status': 'verified derivative, not runtime acceptance', 'sha256': sha(first), 'twoRebuildsByteIdentical': True}, indent=2))
        return
    target.mkdir(parents=True, exist_ok=True)
    if any(path.name not in {OUTPUT_NAME, 'build-receipt.json'} for path in target.iterdir()):
        parser.error('Candidate output contains unrelated files')
    (target / OUTPUT_NAME).write_bytes(first)
    (target / 'build-receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
