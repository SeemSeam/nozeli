#!/usr/bin/env python3
"""Offline `gh` CLI stand-in for checker behavior fixtures (no network, no secrets).

Reads a JSON endpoint map from $NOZELI_FIXTURE_GH_MAP and answers
`gh api <endpoint>` calls: plain endpoints print the mapped JSON value,
`-H Accept: application/octet-stream` endpoints print the mapped raw text.
Any endpoint outside the map fails loudly instead of guessing.
"""
import json
import os
import sys

path = os.environ.get('NOZELI_FIXTURE_GH_MAP')
if not path:
    sys.stderr.write('gh fixture: NOZELI_FIXTURE_GH_MAP is not set\n')
    sys.exit(1)
with open(path, encoding='utf-8') as stream:
    mapping = json.load(stream)
endpoint = sys.argv[-1]
if endpoint not in mapping:
    sys.stderr.write(f'gh fixture: unexpected endpoint {endpoint}\n')
    sys.exit(1)
value = mapping[endpoint]
if any('octet-stream' in argument for argument in sys.argv):
    if not isinstance(value, str):
        sys.stderr.write('gh fixture: raw endpoint must map to text\n')
        sys.exit(1)
    sys.stdout.write(value)
else:
    json.dump(value, sys.stdout)
