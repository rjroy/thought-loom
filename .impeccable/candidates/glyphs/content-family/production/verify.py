"""Focused source safety, alpha, framing and review renders; no artwork edits."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from build import SOURCES, sha, run

HERE = Path(__file__).resolve().parent
BASE = HERE.parent
REVIEW = HERE/'review'
RUNTIME = HERE/'runtime'
FONT = HERE.parents[3]/'brand/fonts/SourceSans3-VariableFont_wght.ttf'
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('source_inspection', BASE/'revised/verify.py')
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)
inspection.source = lambda name: RUNTIME/f'{name}.svg'
LABELS = [
    ('captured-original','Original capture','material'),
    ('user-contribution','Contribution','material'),
    ('ai-interpretation','Interpretation','material'),
    ('developing-idea','Developing idea','material'),
    ('imported-original','Imported source','material'),
    ('full-reply','Full reply','record role'),
    ('evolution','Evolution','relationship'),
    ('connection','Discovered connection','relationship · PNG'),
    ('used-as-source','Used as source','relationship · PNG'),
    ('lantern','Existing lantern','reference only · unchanged'),
    ('sprout','Existing sprout','reference only · unchanged'),
]


def path_for(name):
    if name in {'lantern','sprout'}:
        return BASE.parent/'production/corrected'/f'{name}.svg'
    return RUNTIME/(name+('.png' if name in {'connection','used-as-source'} else '.svg'))


def render(source, dest, size):
    if source.suffix=='.svg':
        run('rsvg-convert','-w',size,'-h',size,'-o',dest,source)
    else:
        run('magick',source,'-filter','Lanczos','-resize',f'{size}x{size}',dest)


def family_board(label, ground, ink):
    args=['magick','-size','960x1340',f'xc:{ground}','-font',FONT,'-fill',ink,'-pointsize','23','-annotate','+24+34','Thoughtloom — nine production candidates + accepted pair references']
    for i,(name,title,role) in enumerate(LABELS):
        x,y=i%3*320,64+i//3*310
        args+=['-pointsize','21','-annotate',f'+{x+20}+{y+24}',title,'(',REVIEW/f'{name}-160.png',')','-geometry',f'+{x+80}+{y+40}','-composite']
        for size,dx in ((16,66),(20,135),(24,208)):
            args+=['(',REVIEW/f'{name}-{size}.png',')','-geometry',f'+{x+dx}+{y+225}','-composite','-pointsize','15','-annotate',f'+{x+dx-2}+{y+265}',f'{size}px']
        args+=['-pointsize','16','-annotate',f'+{x+20}+{y+295}',role]
    run(*args,'-pointsize','17','-annotate','+24+1320','Exact 16 / 20 / 24px canvases. Text labels remain; not app integration.',REVIEW/f'family-{label}.png')


def before_after():
    for ground_label,ground,ink in (('dark','#031315','#FEF6E1'),('light','#FEF6E1','#031315')):
        args=['magick','-size','940x690',f'xc:{ground}','-font',FONT,'-fill',ink,'-pointsize','23','-annotate','+24+34','Approved PNG source → alpha-cleaned/framed candidate']
        for i,(name,title) in enumerate((('connection','Discovered connection'),('used-as-source','Used as source'))):
            y=70+i*300
            source=BASE/SOURCES[f'{name}.png'][0]
            render(source,REVIEW/f'{name}-source-256.png',256)
            render(path_for(name),REVIEW/f'{name}-candidate-256.png',256)
            args+=['-pointsize','20','-annotate',f'+20+{y+25}',title,'(',REVIEW/f'{name}-source-256.png',')','-geometry',f'+280+{y}','-composite','(',REVIEW/f'{name}-candidate-256.png',')','-geometry',f'+620+{y}','-composite']
        run(*args,REVIEW/f'raster-before-after-{ground_label}.png')


def main():
    assert {p.name for p in RUNTIME.iterdir()} == set(SOURCES)
    preserved=json.loads((HERE/'preserved-before.json').read_text())
    for relative,expected in preserved.items():
        assert sha(Path(relative).read_bytes())==expected,relative
    build=json.loads((HERE/'build-report.json').read_text())
    REVIEW.mkdir(exist_ok=True)
    stats={}
    for filename,item in build['artifacts'].items():
        path=RUNTIME/filename
        assert sha(path.read_bytes())==item['outputSha256']
        source=HERE/item['source']
        assert sha(source.read_bytes())==item['sourceSha256']
        name=path.stem
        if path.suffix=='.svg':
            assert path.read_bytes()==source.read_bytes()
            details=inspection.inspect(name)
            check_image=REVIEW/f'{name}-1024.png'
            render(path,check_image,1024)
        else:
            details={'format':'PNG','dimensions':list(map(int,run('magick','identify','-format','%w %h',path).split())),'colorSpace':run('magick','identify','-format','%[colorspace]',path).decode(),'shading':'approved source RGB retained before uniform resampling; intentionally not palette-flattened'}
            assert details['dimensions']==[1024,1024]
            check_image=path
        details['pixels']=inspection.initial.pixel_report(check_image)
        assert details['pixels']['clearPadding128px']=='pass',filename
        details.update({'sha256':sha(path.read_bytes()),'bytes':path.stat().st_size})
        stats[filename]=details
    for name,_,_ in LABELS:
        path=path_for(name)
        for size in (16,20,24,160):
            render(path,REVIEW/f'{name}-{size}.png',size)
        for label,ground in (('dark','#031315'),('light','#FEF6E1')):
            run('magick',REVIEW/f'{name}-160.png','-background',ground,'-alpha','remove','-alpha','off',REVIEW/f'{name}-{label}.png')
    for name in ('connection','used-as-source'):
        for stage,path in (('source',BASE/SOURCES[f'{name}.png'][0]),('candidate',path_for(name))):
            components=run('magick',path,'-alpha','extract','-threshold','50%','-define','connected-components:verbose=true','-connected-components','8','null:').decode()
            (REVIEW/f'{name}-{stage}-components.txt').write_text(components)
    family_board('dark','#031315','#FEF6E1')
    family_board('light','#FEF6E1','#031315')
    before_after()
    report={'preservation':f'pass: {len(preserved)} artwork/evidence/runtime/reference/passive tracker fingerprints','sourceApproval':'All nine exact selections approved; rejected relationship SVGs excluded','sevenSvgByteCopiesAndRestrictedSafety':'pass','rasterSourceRgbBeforeResampling':'unchanged where retained','realAlphaAndMinimum128PxPadding':'pass all nine','reproducibility':build['reproducibility'],'artifacts':stats,'visualReview':'Designer assessment in README; checks do not grant derivative approval or runtime acceptance','renderer':run('rsvg-convert','--version').decode().strip(),'imageMagick':run('magick','--version').decode().splitlines()[0]}
    (REVIEW/'statistics.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))


if __name__=='__main__':
    main()
