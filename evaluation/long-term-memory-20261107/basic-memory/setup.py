#!/usr/bin/env python3
"""Recreate the evaluation-only environment from the retained exact dependency lock.
Network is used ONLY for public package/interpreter installation and evidence.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
for name in ('home', 'cache', 'evidence'):
    (ROOT/name).mkdir(exist_ok=True)
env = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL') if k in os.environ}
env.update(HOME=str(ROOT/'home'), UV_CACHE_DIR=str(ROOT/'cache/uv'),
           XDG_CACHE_HOME=str(ROOT/'cache'), UV_PYTHON_INSTALL_DIR=str(ROOT/'home/.local/share/uv/python'))
report = {'candidate': 'basic-memory==1.0.0', 'steps': []}
commands = [(['uv', 'venv', '--python', '3.12', str(ROOT/'.venv')], 'reproduce-venv'),
            (['uv', 'pip', 'install', '--python', str(ROOT/'.venv/bin/python'),
              '-r', str(ROOT/'requirements.lock')], 'reproduce-install')]
for argv, label in commands:
    start = time.perf_counter()
    process = subprocess.run(argv, env=env, capture_output=True)
    (ROOT/'evidence'/f'{label}.stdout').write_bytes(process.stdout)
    (ROOT/'evidence'/f'{label}.stderr').write_bytes(process.stderr)
    report['steps'].append({'argv': argv, 'wall_seconds': time.perf_counter()-start,
                            'returncode': process.returncode})
    (ROOT/'evidence/reproduce-setup.json').write_text(json.dumps(report, indent=2)+'\n')
    if process.returncode:
        raise SystemExit(process.returncode)
metadata = json.loads((ROOT/'evidence/pypi.json').read_text())
report['pinned_wheel'] = []
for item in metadata['urls']:
    if item['filename'].endswith('.whl'):
        wheel = ROOT/'evidence'/item['filename']
        if not wheel.exists():
            wheel.write_bytes(urllib.request.urlopen(item['url']).read())
        digest = hashlib.sha256(wheel.read_bytes()).hexdigest()
        if digest != item['digests']['sha256']:
            raise RuntimeError('Retained pinned wheel digest mismatch')
        report['pinned_wheel'].append({'path': str(wheel), 'url': item['url'], 'sha256': digest})
inventory = subprocess.run([str(ROOT/'.venv/bin/python'), str(ROOT/'evidence/collect-distributions.py')],
                           env=env, capture_output=True)
(ROOT/'evidence/installed-distributions.json').write_bytes(inventory.stdout)
(ROOT/'evidence/distribution-metadata.stderr').write_bytes(inventory.stderr)
if inventory.returncode:
    raise SystemExit(inventory.returncode)
(ROOT/'evidence/reproduce-setup.json').write_text(json.dumps(report, indent=2)+'\n')
print('Installed exact requirements.lock in basic-memory/.venv; run ./run.py next.')
