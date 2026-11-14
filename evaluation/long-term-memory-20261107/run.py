#!/usr/bin/env python3
"""Run isolated memory research sequentially and preserve every command result."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--name', default=time.strftime('%Y%m%d-%H%M%S'))
parser.add_argument('--only', choices=['baseline', 'audit', 'embedded', 'basic'], nargs='+', default=['baseline', 'audit', 'embedded', 'basic'])
args = parser.parse_args()
if not re.fullmatch(r'[A-Za-z0-9_-]+', args.name):
    parser.error('--name must contain only ASCII letters, numbers, hyphens or underscores')
out = HERE / 'runs' / args.name
out.mkdir(parents=True, exist_ok=False)
commands = {
    'baseline': ['node', str(HERE / 'baseline.mjs')],
    'audit': [sys.executable, str(HERE / 'audit/run.py')],
    'embedded': [sys.executable, str(HERE / 'embedded/run.py'), 'run', '--output', str(HERE / 'embedded/runs' / args.name)],
    'basic': [sys.executable, str(HERE / 'basic-memory/run.py'), '--output', str(HERE / 'basic-memory/runs' / args.name)],
}
report = {'scope': 'Linux synthetic research, not product acceptance', 'corpusSHA256': hashlib.sha256((HERE/'corpus.json').read_bytes()).hexdigest(), 'oracleSHA256': hashlib.sha256((HERE/'oracle.json').read_bytes()).hexdigest(), 'steps': []}
for name in args.only:
    command = commands[name]
    start = time.monotonic()
    with (out / (name + '.stdout')).open('wb') as stdout, (out / (name + '.stderr')).open('wb') as stderr:
        result = subprocess.run(command, cwd=REPO, stdout=stdout, stderr=stderr, check=False)
    step = {'name': name, 'argv': command, 'returncode': result.returncode, 'wallSeconds': time.monotonic()-start, 'stdout': str(out/(name+'.stdout')), 'stderr': str(out/(name+'.stderr'))}
    report['steps'].append(step)
    report['executionCompleted'] = all(s['returncode'] == 0 for s in report['steps'])
    (out/'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(step, ensure_ascii=False), flush=True)
print(str(out/'report.json'))
sys.exit(0 if report['executionCompleted'] else 2)
