#!/usr/bin/env python3
"""Offline reproducibility inventory for the source audit, not a candidate benchmark."""
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'evidence.json').read_text())
results = []
failures = []
for name, entry in manifest.items():
    checked = []
    for source in entry['sources']:
        relative = Path(source['raw_file'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Evidence path escapes audit directory')
        actual = hashlib.sha256((root / relative).read_bytes()).hexdigest()
        match = actual == source['sha256']
        checked.append({'file': str(relative), 'url': source['url'], 'sha256': actual, 'matches': match})
        if not match:
            failures.append(str(relative))
    results.append({'candidate': name, 'repo': entry['repo_slug'], 'pin_ref': entry['pin_ref'],
                    'pin_commit': entry['pin_commit'], 'files': checked})
report = {'kind': 'offline-source-evidence-integrity-only',
          'candidate_execution': False, 'model_calls': 0, 'installed_dependencies': [],
          'corpus_used': False, 'performance_measured': False,
          'candidates': results, 'failures': failures}
(root / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'kind': report['kind'], 'candidates': len(results),
                  'files': sum(len(row['files']) for row in results), 'failures': failures}))
raise SystemExit(1 if failures else 0)
