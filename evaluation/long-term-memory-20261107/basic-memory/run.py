#!/usr/bin/env python3
"""Run the real pinned Basic Memory CLI + stdio MCP against ../corpus.json.
Only generated run subdirectories are mutated. No models or external network.
"""
import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent


def isolated_env(run):
    env = {k: os.environ[k] for k in ('PATH', 'LANG', 'LC_ALL', 'TERM') if k in os.environ}
    env.update(HOME=str(run / 'home'), XDG_CACHE_HOME=str(run / 'cache'),
               XDG_CONFIG_HOME=str(run / 'home/.config'), TMPDIR=str(run / 'tmp'),
               BASIC_MEMORY_CONFIG_DIR=str(run / 'state'), BASIC_MEMORY_HOME=str(run / 'notes'),
               BASIC_MEMORY_FORCE_LOCAL='true', BASIC_MEMORY_NO_PROMOS='1',
               BASIC_MEMORY_AUTO_UPDATE='false', BASIC_MEMORY_DEFAULT_SEARCH_TYPE='text',
               FASTMCP_CHECK_FOR_UPDATES='off',
               BASIC_MEMORY_RERANKER_ENABLED='false', BASIC_MEMORY_LOGFIRE_ENABLED='false',
               BASIC_MEMORY_INDEX_CHANGES='false', BASIC_MEMORY_SKIP_INITIALIZATION_SYNC='true',
               FASTEMBED_CACHE_PATH=str(run / 'cache/fastembed'),
               HF_HOME=str(run / 'cache/huggingface'), HF_HUB_OFFLINE='1',
               TRANSFORMERS_OFFLINE='1', PYTHONPATH=str(ROOT / 'guard'),
               EVALUATION_GUARD_LOG=str(run / 'guard.jsonl'), NO_COLOR='1')
    return env


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str) + '\n', encoding='utf-8')


def footprint(path):
    files = [p for p in path.rglob('*') if p.is_file() and not p.is_symlink()]
    return {'files': len(files), 'logical_bytes': sum(p.stat().st_size for p in files),
            'allocated_bytes': sum(p.stat().st_blocks * 512 for p in files)}


def score(actual, expected):
    a, e = set(actual), set(expected)
    return {'actual_ids': sorted(a), 'expected_ids': sorted(e), 'missing_ids': sorted(e-a),
            'unexpected_ids': sorted(a-e), 'precision': len(a&e)/len(a) if a else None,
            'recall': len(a&e)/len(e) if e else None, 'exact': a == e}


def content_of(value):
    if isinstance(value, dict):
        if isinstance(value.get('content'), str):
            return value['content']
        for child in value.values():
            found = content_of(child)
            if found is not None:
                return found
    if isinstance(value, list):
        for child in value:
            found = content_of(child)
            if found is not None:
                return found
    return None


def search_payload(value):
    if isinstance(value, dict):
        if isinstance(value.get('results'), list):
            return value
        for child in value.values():
            found = search_payload(child)
            if found is not None:
                return found
    if isinstance(value, list):
        for child in value:
            found = search_payload(child)
            if found is not None:
                return found
    return None


def row_id(hit):
    for value in (hit.get('permalink', ''), hit.get('file_path', ''),
                  (hit.get('metadata') or {}).get('knowledge_id', '')):
        found = re.search(r'(?:^|/)(k\d{4})(?:\.md)?$', str(value))
        if found:
            return found[1]
    return None


class Monitor:
    """50ms samples: tree RSS sum peak; CPU last-seen total per pid/create-time.
    Short-lived processes between samples can be missed; not kernel high water.
    """
    def __init__(self, path):
        import psutil
        self.psutil = psutil
        self.process = psutil.Process()
        initial_cpu = self.process.cpu_times()
        self.initial_self_cpu = initial_cpu.user + initial_cpu.system
        self.path = path
        self.last = {}
        self.peak_rss = 0
        self.running = True

    async def sample(self):
        with self.path.open('w', encoding='utf-8') as out:
            while self.running:
                processes = []
                try:
                    children = self.process.children(recursive=True)
                except self.psutil.Error:
                    children = []
                for proc in [self.process, *children]:
                    try:
                        cpu = proc.cpu_times()
                        item = {'pid': proc.pid, 'ppid': proc.ppid(), 'created': proc.create_time(),
                                'rss': proc.memory_info().rss, 'cpu_s': cpu.user+cpu.system,
                                'cmdline': proc.cmdline()}
                        self.last[(proc.pid, item['created'])] = item['cpu_s']
                        processes.append(item)
                    except self.psutil.Error:
                        pass
                rss = sum(p['rss'] for p in processes)
                self.peak_rss = max(self.peak_rss, rss)
                out.write(json.dumps({'time': time.time(), 'rss_sum': rss,
                                      'processes': processes}, ensure_ascii=False)+'\n')
                out.flush()
                await asyncio.sleep(.05)

    def metrics(self):
        return {'sampled_tree_peak_rss_bytes': self.peak_rss,
                'sampled_tree_cpu_seconds': max(0, sum(self.last.values()) - self.initial_self_cpu),
                'definition': 'RSS sum of driver + recursive live descendants, sampled 50ms; CPU sum last seen user+system per pid/create-time minus initial driver CPU, per size; shared RSS may double count; short processes may be missed'}


async def cli(run, env, label, *args):
    start = time.perf_counter()
    process = await asyncio.create_subprocess_exec(str(ROOT/'.venv/bin/basic-memory'), *args,
                                                  env=env, cwd=run,
                                                  stdout=asyncio.subprocess.PIPE,
                                                  stderr=asyncio.subprocess.PIPE,
                                                  stdin=asyncio.subprocess.PIPE)
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(b'y\n' if args[0] == 'reset' else None), timeout=600)
    except asyncio.TimeoutError:
        process.kill()
        stdout, stderr = await process.communicate()
        stderr += b'\nEVALUATION TIMEOUT (600s)\n'
    (run/'raw'/f'{label}.stdout').write_bytes(stdout)
    (run/'raw'/f'{label}.stderr').write_bytes(stderr)
    result = {'argv': list(args), 'returncode': process.returncode,
              'cold_cli_wall_seconds': time.perf_counter()-start}
    dump(run/'raw'/f'{label}.json', result)
    return result


async def mcp_call(client, run, name, args, label):
    start = time.perf_counter()
    try:
        response = await asyncio.wait_for(client.call_tool(name, args, raise_on_error=False), 120)
        raw = {'structured_content': response.structured_content,
               'content': [part.model_dump(mode='json') for part in response.content],
               'is_error': response.is_error}
        value = response.structured_content
        if value is None:
            texts = [p.text for p in response.content if hasattr(p, 'text')]
            try:
                value = json.loads('\n'.join(texts))
            except ValueError:
                value = {'text': '\n'.join(texts)}
    except Exception as exc:
        raw = {'exception': repr(exc), 'is_error': True}
        value = raw
    raw['tool'] = name
    raw['arguments'] = args
    raw['warm_mcp_roundtrip_seconds'] = time.perf_counter()-start
    dump(run/'raw'/f'{label}.json', raw)
    return value, raw


async def paged_search(client, run, query, label, filters=None):
    ids, pages, errors = [], [], []
    # Full retrieval uses native 100-item pages; a separate two-page 5-item probe
    # below tests the old baseline's >5 reachability limitation explicitly.
    for page in range(1, 31):
        args = {'query': query, 'mode': 'text', 'project': 'evaluation',
                'page': page, 'page_size': 100, 'output_format': 'json'}
        if filters is not None:
            args['filters'] = filters
        value, raw = await mcp_call(client, run, 'bm_search', args, f'{label}-p{page}')
        payload = search_payload(value)
        pages.append({'page': page, 'latency_s': raw['warm_mcp_roundtrip_seconds'],
                      'raw_path': f'raw/{label}-p{page}.json'})
        if raw['is_error'] or payload is None:
            errors.append({'page': page, 'error': value})
            break
        ids.extend(row_id(hit) for hit in payload['results'] if row_id(hit))
        if not payload.get('has_more', False):
            break
    else:
        errors.append('Safety limit 30 pages reached; retrieval incomplete')
    return {'ids': sorted(set(ids)), 'ordered_ids': ids, 'pages': pages,
            'errors': errors, 'duplicates': len(ids)-len(set(ids))}


async def one_size(run, rows, oracle, corpus_hash):
    from fastmcp import Client
    from fastmcp.client.transports import StdioTransport
    size = len(rows)
    env = isolated_env(run)
    for name in ('home', 'cache', 'tmp', 'state', 'notes', 'raw'):
        (run/name).mkdir(parents=True, exist_ok=True)
    config = {'projects': {}, 'auto_update': False, 'default_search_type': 'text',
              'index_changes': False, 'skip_initialization_sync': True,
              'reranker_enabled': False, 'logfire_enabled': False,
              'ensure_frontmatter_on_sync': False}
    dump(run/'state/config.json', config)
    mapping, original = {}, {}
    for row in rows:
        stable = row['id']
        # Preserve all source fields (including full UTF-8 provenance) verbatim as
        # canonical JSON in the body; frontmatter merely exposes native filters.
        metadata = {'title': row['title'], 'type': 'note', 'permalink': stable,
                    'knowledge_id': stable, 'project_key': row['project'],
                    'instance_key': row['instance'], 'status': row['status'],
                    'outcome': row['outcome'], 'work': row['work'], 'revision': row['revision']}
        frontmatter = '\n'.join(f'{k}: {json.dumps(v, ensure_ascii=False)}' for k,v in metadata.items())
        source_json = json.dumps(row, ensure_ascii=False, separators=(',', ':'))
        text = f'---\n{frontmatter}\n---\n\n# {row["title"]}\n\n{row["text"]}\n\n## Exact source record\n```json\n{source_json}\n```\n'
        path = run/'notes'/f'{stable}.md'
        path.write_text(text, encoding='utf-8')
        mapping[stable] = {'file': str(path), 'source_json': source_json,
                           'markdown_sha256': hashlib.sha256(text.encode()).hexdigest()}
        original[stable] = text
    dump(run/'import-map.json', mapping)
    monitor = Monitor(run/'process-tree.jsonl')
    monitoring = asyncio.create_task(monitor.sample())
    summary = {'size': size, 'corpus_sha256': corpus_hash, 'queries': {},
               'source_preservation': {}, 'stable_id_reads': {}, 'external_mutations': {}}
    try:
        registration = await cli(run, env, 'register', 'project', 'add', 'evaluation', str(run/'notes'),
                                 '--default', '--no-wait', '--local')
        summary['registration'] = registration
        indexed = await cli(run, env, 'index', 'reindex', '--search', '--full', '-p', 'evaluation')
        summary['initial_index'] = indexed
        if registration['returncode'] or indexed['returncode']:
            summary['blocked'] = 'Actual candidate project registration or text indexing failed; raw logs retained'
            return summary
        # A separate process startup measurement; warm timings below exclude startup.
        transport = StdioTransport(command=str(ROOT/'.venv/bin/basic-memory'), args=['mcp'],
                                   env=env, cwd=str(run), keep_alive=False,
                                   log_file=run/'raw/mcp.stderr')
        start = time.perf_counter()
        async with Client(transport) as client:
            summary['mcp_cold_start_seconds'] = time.perf_counter()-start
            tools = await client.list_tools()
            dump(run/'raw/tools.json', [t.model_dump(mode='json') for t in tools])
            allids = {r['id'] for r in rows}
            currentids = {r['id'] for r in rows if r['project']=='alpha' and r['instance']=='i1'
                          and r['status'] in ('confirmed', 'verified')
                          and not r.get('tombstoned', False)}
            filters = {'project_key': 'alpha', 'instance_key': 'i1',
                       'status': {'$in': ['confirmed', 'verified']}}
            for i, (query, expected) in enumerate(oracle['queries'].items()):
                found = await paged_search(client, run, query, f'q{i}-history')
                native = await paged_search(client, run, query, f'q{i}-native-current', filters)
                history_expected = set(expected['historyExpected']) & allids
                current_expected = set(expected['currentExpected']) & allids
                summary['queries'][query] = {
                    'raw_history': score(found['ids'], history_expected),
                    'host_effective_current': score(set(found['ids']) & currentids, current_expected),
                    'native_explicit_metadata_current': score(native['ids'], current_expected),
                    'retrieval': found, 'native_filtered_retrieval': native,
                    'policy_note': 'Raw search includes all statuses. Host current filter is an adapter, not candidate default. Explicit native filters use imported metadata; neither understands Nozeli knowledge policy.'}
            # Pagination test independent of which keyword happens to match.
            probe = []
            for page in (1, 2):
                value, raw = await mcp_call(client, run, 'bm_search',
                    {'mode': 'text', 'project': 'evaluation', 'page': page,
                     'page_size': 5, 'output_format': 'json', 'filters': {'type': 'note'}},
                    f'pagination-five-{page}')
                payload = search_payload(value)
                probe.append({'page': page, 'ids': [row_id(h) for h in payload['results']] if payload else [],
                              'has_more': payload.get('has_more') if payload else None,
                              'is_error': raw['is_error']})
            summary['pagination_five'] = probe
            summary['pagination_beyond_five_reachable'] = len(set(probe[1]['ids'])-set(probe[0]['ids'])) > 0
            # Read EVERY input stable permalink, not a limited preview or result snippets.
            for row in rows:
                stable = row['id']
                value, raw = await mcp_call(client, run, 'bm_read',
                    {'identifier': stable, 'project': 'evaluation', 'output_format': 'json'}, f'read-{stable}')
                text = content_of(value)
                summary['stable_id_reads'][stable] = {'ok': not raw['is_error'] and text is not None,
                    'source_json_exact_in_read': text is not None and mapping[stable]['source_json'] in text,
                    'full_markdown_exact': text == original[stable],
                    'latency_s': raw['warm_mcp_roundtrip_seconds']}
            summary['source_preservation'] = {
                'all_files_byte_exact_after_index': all(Path(mapping[s]['file']).read_text(encoding='utf-8')==original[s] for s in allids),
                'all_stable_reads_contain_exact_source_record': all(x['source_json_exact_in_read'] for x in summary['stable_id_reads'].values()),
                'records_checked': len(rows)}
        # Stop MCP before mutations, reindex explicitly, then reconnect. This tests
        # external-file reconciliation, NOT automatic watcher responsiveness.
        target = rows[0]['id']
        path = run/'notes'/f'{target}.md'
        edited = original[target]+'\nExternalEditMarkerSevenNebula\n'
        path.write_text(edited, encoding='utf-8')
        summary['external_mutations']['edit_index'] = await cli(run, env, 'edit-index', 'reindex', '--search', '-p', 'evaluation')
        renamed = path.with_name(f'renamed-{target}.md')
        path.rename(renamed)
        summary['external_mutations']['rename_index'] = await cli(run, env, 'rename-index', 'reindex', '--search', '-p', 'evaluation')
        async with Client(StdioTransport(command=str(ROOT/'.venv/bin/basic-memory'), args=['mcp'],
                         env=env, cwd=str(run), keep_alive=False, log_file=run/'raw/mcp-mutations.stderr')) as client:
            value, raw = await mcp_call(client, run, 'bm_read', {'identifier': target, 'project': 'evaluation',
                                            'output_format': 'json'}, 'read-after-edit-rename')
            summary['external_mutations']['edit_visible_after_rename'] = 'ExternalEditMarkerSevenNebula' in (content_of(value) or '')
            summary['external_mutations']['stable_permalink_survives_external_rename'] = not raw['is_error'] and content_of(value) == edited
            summary['external_mutations']['marker_search'] = await paged_search(client, run, 'ExternalEditMarkerSevenNebula', 'external-marker')
        renamed.unlink()
        summary['external_mutations']['delete_index'] = await cli(run, env, 'delete-index', 'reindex', '--search', '-p', 'evaluation')
        async with Client(StdioTransport(command=str(ROOT/'.venv/bin/basic-memory'), args=['mcp'],
                         env=env, cwd=str(run), keep_alive=False, log_file=run/'raw/mcp-delete.stderr')) as client:
            value, raw = await mcp_call(client, run, 'bm_read', {'identifier': target, 'project': 'evaluation',
                                             'output_format': 'json'}, 'read-after-delete')
            summary['external_mutations']['deleted_read_error'] = raw['is_error']
            summary['external_mutations']['deleted_read_payload'] = value
            gone = await paged_search(client, run, None, 'after-delete', {'knowledge_id': target})
            summary['external_mutations']['deleted_from_search'] = target not in gone['ids'] and not gone['errors']
        # Restore original file, then genuinely destroy ONLY this new run's index
        # using candidate reset. This is not an incremental refresh masquerading
        # as a rebuild. No credentials or external/user paths are in the run.
        path.write_text(original[target], encoding='utf-8')
        summary['reset'] = await cli(run, env, 'reset-index', 'reset', '--force')
        summary['rebuild'] = await cli(run, env, 'rebuild-index', 'reindex', '--search', '--full', '-p', 'evaluation')
        async with Client(StdioTransport(command=str(ROOT/'.venv/bin/basic-memory'), args=['mcp'],
                         env=env, cwd=str(run), keep_alive=False, log_file=run/'raw/mcp-rebuild.stderr')) as client:
            rebuilt = await paged_search(client, run, None, 'rebuilt-all', {'type': 'note'})
            summary['rebuild_all_ids'] = score(rebuilt['ids'], allids)
            value, raw = await mcp_call(client, run, 'bm_read', {'identifier': target, 'project': 'evaluation',
                                             'output_format': 'json'}, 'read-after-rebuild')
            summary['rebuild_stable_id_full_read'] = not raw['is_error'] and content_of(value) == original[target]
        latest = {}
        for row in rows:
            key = (row['project'], row['instance'], row['work'])
            if key not in latest or row['revision'] > latest[key]['revision']:
                latest[key] = row
        summary['separate_work_report_revision_scenario'] = {
            'latest_work_report_ids': sorted(r['id'] for r in latest.values()),
            'older_work_report_ids': sorted(allids-{r['id'] for r in latest.values()}),
            'current_knowledge_ids': sorted(currentids),
            'note': 'Work report revision grouping is host-authored, not knowledge supersession. Each corpus id is a separate stable knowledge row; no outcome accept gate.'}
    except Exception as exc:
        import traceback
        summary['blocked'] = repr(exc)
        (run/'raw/exception.txt').write_text(traceback.format_exc(), encoding='utf-8')
    finally:
        monitor.running = False
        await monitoring
        summary['resources'] = monitor.metrics()
        summary['disk'] = {name: footprint(run/name) for name in ('state', 'notes', 'cache', 'raw')}
        events = [json.loads(line) for line in (run/'guard.jsonl').read_text().splitlines()] if (run/'guard.jsonl').exists() else []
        summary['guard'] = {'loaded_processes': sorted({e['pid'] for e in events if e['kind']=='guard_loaded'}),
                            'blocked_attempts': [e for e in events if e['kind']!='guard_loaded'],
                            'model_calls_completed': 0,
                            'basis': 'Fail-closed FastEmbed/ONNX constructor tripwire plus offline empty model cache and socket/DNS guard. Any blocked attempt is reported, never silently replaced.'}
        summary['data_paths'] = {name: str(run/name) for name in ('state', 'notes', 'cache', 'home', 'tmp', 'raw')}
        summary['database_files'] = [str(p) for p in (run/'state').rglob('*')
                                     if p.is_file() and ('.db' in p.name or '.sqlite' in p.name)]
        infrastructure_errors = []
        for diagnostic in sorted((run/'raw').glob('*.json')):
            payload = json.loads(diagnostic.read_text(encoding='utf-8'))
            if not isinstance(payload, dict):
                continue
            if payload.get('returncode', 0) != 0 or 'exception' in payload:
                infrastructure_errors.append(diagnostic.name)
            elif payload.get('is_error') and diagnostic.name != 'read-after-delete.json':
                infrastructure_errors.append(diagnostic.name)
        for result in summary['queries'].values():
            if result['retrieval']['errors'] or result['native_filtered_retrieval']['errors']:
                infrastructure_errors.append('query response/pagination contract failure')
        if infrastructure_errors and 'blocked' not in summary:
            summary['blocked'] = 'Candidate operations could not complete; inspect infrastructure_errors and raw diagnostics'
        summary['infrastructure_errors'] = infrastructure_errors
        summary['status'] = 'blocked' if 'blocked' in summary else 'completed'
        dump(run/'summary.json', summary)
    return summary


async def execute(args):
    corpus = ROOT.parent/'corpus.json'
    data = corpus.read_bytes()
    rows = json.loads(data)
    oracle_path = ROOT.parent/'oracle.json'
    oracle = json.loads(oracle_path.read_text())
    output = Path(args.output).resolve()
    report = {'candidate': 'basic-memory==1.0.0', 'corpus_sha256': hashlib.sha256(data).hexdigest(),
              'oracle_sha256': hashlib.sha256(oracle_path.read_bytes()).hexdigest(),
              'mode': 'Real local CLI text indexing and persistent stdio MCP text retrieval; no embeddings or LLMs',
              'platform': sys.platform, 'python': sys.version,
              'dependency_install_disk': footprint(ROOT/'.venv'), 'sizes': [],
              'setup_cache_disk': footprint(ROOT/'cache'),
              'setup_home_and_python_disk': footprint(ROOT/'home'),
              'first_install_timing': 'Not measured in initial setup; reproduction setup.py records command wall times',
              'limits': ['Windows and macOS unverified', 'No semantic extraction, embedding or reranking quality/cost evaluated',
                         'Local explicit reindex tested, realtime watcher and cloud/cross-device sync not exercised',
                         'Native filters require imported metadata; Nozeli authorization/truth/lifecycle policy is not native',
                         'Synthetic corpus only; source JSON is archival preservation, not automatic provenance interpretation',
                         'Warm MCP is not bare engine timing; cold CLI/startup timing is separate',
                         'Shared-machine measurements, not isolated CPU benchmarks']}
    for size in args.sizes:
        if size > len(rows):
            raise ValueError(f'corpus only contains {len(rows)} rows, requested {size}')
        result = await one_size(output/f'n{size}', rows[:size], oracle, report['corpus_sha256'])
        report['sizes'].append(result)
        report['status'] = 'blocked' if any(r['status'] == 'blocked' for r in report['sizes']) else 'completed'
        dump(output/'report.json', report)
    print(str(output/'report.json'))
    return 2 if report.get('status') == 'blocked' else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sizes', type=int, nargs='+', default=[10,100,1000])
    parser.add_argument('--output', default=str(ROOT/'runs'/time.strftime('%Y%m%d-%H%M%S'))+'-'+uuid.uuid4().hex[:8])
    parser.add_argument('--isolated-worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    # Never allow reset/reindex to reach a pre-existing user project.
    if not output.is_relative_to(ROOT/'runs'):
        parser.error('--output must be a NEW directory below basic-memory/runs/')
    if not args.isolated_worker:
        if output.exists():
            parser.error('output already exists; choose a new run directory')
        for name in ('home','cache','tmp'):
            (output/name).mkdir(parents=True, exist_ok=True)
        argsv = [str(ROOT/'.venv/bin/python'), str(Path(__file__).resolve()), '--isolated-worker',
                 '--output', str(output), '--sizes', *map(str,args.sizes)]
        os.execve(argsv[0], argsv, isolated_env(output))
    raise SystemExit(asyncio.run(execute(args)))


if __name__ == '__main__':
    main()
