"""Read old absolute input paths from a verified snapshot in the current checkout."""
import json
import os
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
ALIASES=json.loads((ROOT/'workspace-paths.json').read_text(encoding='utf8'))

if os.environ.get('ARACHNE_PATH_ALIASES'):
    saved=json.loads(Path(os.environ['ARACHNE_PATH_ALIASES']).read_text(encoding='utf8'))
    roots=saved.get('roots')
    if not isinstance(roots,list) or len(roots)>32: raise ValueError('Invalid installation roots')
    ALIASES['roots'].extend(p for p in roots if isinstance(p,str) and Path(p).is_absolute() and p!='/' )

def workspace_path(value):
    normalized=str(value).replace('\\','/')
    for old,target in ALIASES.get('files',{}).items():
        if normalized.lower()==old.lower():return ROOT/target
    for old in ALIASES['roots']:
        if normalized.lower()==old.lower():return ROOT
        if normalized.lower().startswith(old.lower()+'/'):
            result=(ROOT/normalized[len(old)+1:]).resolve()
            if ROOT not in result.parents:raise ValueError('Input path escaped workspace')
            return result
    return Path(value)
