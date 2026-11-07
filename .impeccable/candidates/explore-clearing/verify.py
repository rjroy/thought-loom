"""Integration verification of packaged source, recipe and candidate; no runtime."""
import argparse
import json
from pathlib import Path
from build import build_once, run, sha, OUTPUT_SIZE, OUTPUT_NAME


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate-dir', type=Path, required=True)
    args = parser.parse_args()
    first, report = build_once()
    second, second_report = build_once()
    assert first == second and report == second_report, 'Rebuilds differ'
    candidate = args.candidate_dir / OUTPUT_NAME
    assert candidate.read_bytes() == first, 'Candidate differs from reproducible source conversion'
    rgba = run('magick', candidate, '-depth', '8', 'RGBA:-')
    width, height = OUTPUT_SIZE
    assert len(rgba) == width * height * 4
    alpha = rgba[3::4]
    assert all(value == 0 for value in alpha[:width]), 'Sky edge must be genuinely transparent'
    assert 0 in alpha and 255 in alpha and any(0 < a < 255 for a in alpha)
    assert b'impeccable:prompt' in first, 'Embedded mechanical-source provenance missing'
    recorded = json.loads((args.candidate_dir / 'build-receipt.json').read_text())
    assert recorded['outputSha256'] == sha(first)
    print(json.dumps({'status': 'verified candidate, not runtime acceptance', 'twoRebuildsByteIdentical': True, 'candidateSha256': sha(first), 'transparentSkyEdge': True, 'alphaCounts': {'transparent': alpha.count(0), 'opaque': alpha.count(255), 'partial': sum(0 < a < 255 for a in alpha)}}, indent=2))


if __name__ == '__main__':
    main()
