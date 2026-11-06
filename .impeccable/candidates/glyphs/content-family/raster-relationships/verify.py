"""Inspect retained PNG originals, never repair/crop/key artwork. Exit 2 = brief mismatch."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
REVIEW = HERE / "review"
FONT = HERE.parents[3] / "brand/fonts/SourceSans3-VariableFont_wght.ttf"
NATIVE = Path('/home/rjroy/.codex/generated_images/01a1b292-7e9f-7440-81b6-dcd959dff85c')
NAMES = {'connection': ('Discovered connection', 'exec-dd7d1ec0-f381-467a-b674-7c0279807b7b.png'), 'used-as-source': ('Used as source', 'exec-97937005-477a-4ccf-9d38-2794c057984d.png')}


def run(*args):
    return subprocess.check_output([str(a) for a in args])


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def bounds(alpha, width, threshold):
    occupied = [i for i, a in enumerate(alpha) if a > threshold]
    return [min(i % width for i in occupied), min(i // width for i in occupied), max(i % width for i in occupied), max(i // width for i in occupied)] if occupied else None


def inspect(name, filename):
    source = HERE / f'{name}.png'
    assert sha(source) == sha(NATIVE / filename)
    width, height = map(int, run('magick', 'identify', '-format', '%w %h', source).split())
    raw = run('magick', source, '-depth', '8', 'RGBA:-')
    alpha = raw[3::4]
    assert len(alpha) == width * height
    assert alpha.count(0) > 0 and any(a >= 250 for a in alpha)
    palette = {(254, 246, 225), (255, 212, 119)}
    near_opaque_colors = Counter(tuple(raw[i:i+3]) for i in range(0, len(raw), 4) if raw[i+3] >= 250)
    total_near_opaque = sum(near_opaque_colors.values())
    exact = sum(count for color, count in near_opaque_colors.items() if color in palette)
    b = bounds(alpha, width, 0)
    padding = min(b[0]/width, b[1]/height, (width-1-b[2])/width, (height-1-b[3])/height)
    return {'nativePath': str(NATIVE / filename), 'candidate': f'{name}.png', 'sha256': sha(source), 'nativeCopyHashMatch': True, 'bytes': source.stat().st_size, 'format':'PNG', 'dimensions':[width,height], 'colorspace':run('magick','identify','-format','%[colorspace]',source).decode(), 'fullyTransparentPixels':alpha.count(0), 'fullyOpaquePixels':alpha.count(255), 'partiallyTransparentPixels':len(alpha)-alpha.count(0)-alpha.count(255), 'alpha1Through16Pixels':sum(0<a<=16 for a in alpha), 'alphaGreaterThanZeroBoundsInclusive':b, 'alphaGreaterThan127BoundsInclusive':bounds(alpha,width,127), 'alphaGreaterThan249BoundsInclusive':bounds(alpha,width,249), 'minimumFullyClearPaddingFraction':padding, 'padding12point5Percent':'pass' if padding>=0.125 else 'fail', 'requested1024Square':'pass' if width==height==1024 else 'fail', 'nearOpaqueUniqueRgbCount':len(near_opaque_colors), 'nearOpaqueExactPalettePixelFraction':exact/total_near_opaque, 'topNearOpaqueRgbCounts': [{'rgb':list(color),'count':count} for color,count in near_opaque_colors.most_common(6)], 'flatExactPalette':'pass' if exact==total_near_opaque else 'fail'}


def two_board(label, ground, ink):
    args=['magick','-size','900x650',f'xc:{ground}','-font',FONT,'-fill',ink,'-pointsize','24','-annotate','+24+34','Thoughtloom — two generated PNG candidates']
    for i,(name,(title,_)) in enumerate(NAMES.items()):
        x=i*450
        args+=['-pointsize','23','-annotate',f'+{x+24}+88',title,'(',REVIEW/f'{name}-320.png',')','-geometry',f'+{x+65}+110','-composite']
        for size,dx in ((16,90),(20,207),(24,325)):
            args+=['(',REVIEW/f'{name}-{size}.png',')','-geometry',f'+{x+dx}+478','-composite','-pointsize','18','-annotate',f'+{x+dx-8}+530',f'{size}px']
    run(*args,'-pointsize','18','-annotate','+24+610','Untrimmed canvases; actual-size samples. Inspection only, not runtime assets.',REVIEW/f'board-{label}.png')


def family_board():
    base=HERE.parent
    items=[('captured-original','Original capture',base/'revised/captured-original.svg'),('user-contribution','Contribution',base/'revised/user-contribution.svg'),('ai-interpretation','Interpretation',base/'ai-interpretation.svg'),('developing-idea','Developing idea',base/'developing-idea.svg'),('imported-original','Imported source',base/'imported-original.svg'),('full-reply','Full reply',base/'full-reply.svg'),('evolution','Evolution',base/'revised/evolution.svg')]+[(name,title,HERE/f'{name}.png') for name,(title,_) in NAMES.items()]
    args=['magick','-size','960x1000','xc:#031315','-font',FONT,'-fill','#FEF6E1','-pointsize','23','-annotate','+24+34','Seven unchanged SVG candidates + two new PNG alternatives']
    for i,(name,title,source) in enumerate(items):
        x,y=i%3*320,70+i//3*300
        for size in (160,16,20,24):
            dest=REVIEW/f'family-{name}-{size}.png'
            if source.suffix=='.svg':
                run('rsvg-convert','-w',size,'-h',size,'-o',dest,source)
            else:
                run('magick',source,'-resize',f'{size}x{size}',dest)
        args+=['-pointsize','20','-annotate',f'+{x+20}+{y+20}',title,'(',REVIEW/f'family-{name}-160.png',')','-geometry',f'+{x+80}+{y+40}','-composite']
        for size,dx in ((16,65),(20,140),(24,215)):
            args+=['(',REVIEW/f'family-{name}-{size}.png',')','-geometry',f'+{x+dx}+{y+220}','-composite','-pointsize','14','-annotate',f'+{x+dx-2}+{y+265}',f'{size}px']
    run(*args,REVIEW/'family-comparison.png')


def main():
    preserved=json.loads((HERE/'preserved-before.json').read_text())
    changed=[path for path,expected in preserved.items() if sha(Path(path))!=expected]
    assert not changed,changed
    REVIEW.mkdir(exist_ok=True)
    stats={name:inspect(name,filename) for name,(_,filename) in NAMES.items()}
    for name in NAMES:
        for size in (16,20,24,320):
            run('magick',HERE/f'{name}.png','-resize',f'{size}x{size}',REVIEW/f'{name}-{size}.png')
        for label,ground in (('dark','#031315'),('light','#FEF6E1')):
            run('magick',REVIEW/f'{name}-320.png','-background',ground,'-alpha','remove','-alpha','off',REVIEW/f'{name}-{label}.png')
        run('magick',REVIEW/f'{name}-16.png','-filter','point','-resize','256x256',REVIEW/f'{name}-16-magnified.png')
    two_board('dark','#031315','#FEF6E1')
    two_board('light','#FEF6E1','#031315')
    family_board()
    failures={name:[key for key in ('requested1024Square','padding12point5Percent','flatExactPalette') if item[key]=='fail'] for name,item in stats.items()}
    report={'preservedArtworkEvidenceRuntimeReferenceAndPassiveTrackerFingerprints':len(preserved),'preservation':'pass','decodeAndRealAlpha':'pass','requestedBriefFailures':failures,'artifacts':stats,'imageMagick':run('magick','--version').decode().splitlines()[0],'svgFamilyRenderer':run('rsvg-convert','--version').decode().strip(),'humanVisualReview':'See README; source originals are unmodified. PNG previews are inspection evidence only.'}
    (REVIEW/'statistics.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
    if any(failures.values()):
        raise SystemExit(2)


if __name__=='__main__':
    main()
