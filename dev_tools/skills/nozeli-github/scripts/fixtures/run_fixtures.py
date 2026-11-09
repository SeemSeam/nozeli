#!/usr/bin/env python3
"""Behavior fixtures for check_release_state.py.

Every scenario builds a throwaway git repository plus release assets and runs
the checker exactly the way a maintainer would — as a subprocess against
fixture data, never importing or inspecting checker source. Assertions target
the observable exit code and PASS/FAIL output lines only.

Coverage: linux-only Alpha history stays green while dual-platform Beta drafts
gain required mac assets (local checksums + in-zip RELEASE.json binding), the
draft phase accepts a true draft release and rejects missing mac assets or an
already-published release.

Usage: python3 dev_tools/skills/nozeli-github/scripts/fixtures/run_fixtures.py [--keep]
Requires: python3 and git. No network, no gh, no GitHub access; the gh API is
simulated by gh_stub.py through a PATH-injected wrapper.
"""
import argparse
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

CHECKER = Path(__file__).resolve().parent.parent / 'check_release_state.py'
GH_STUB = Path(__file__).resolve().parent / 'gh_stub.py'
REPO_NAME = 'fixture/nozeli'
LINUX_PLATFORMS = ['linux-x64-wayland', 'linux-x64-x11']
DUAL_PLATFORMS = LINUX_PLATFORMS + ['macos-arm64-local']


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def git(root, *args):
    return subprocess.run(['git', *args], cwd=root, check=True,
                          stdout=subprocess.PIPE, text=True).stdout.strip()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def build_repository(root, version, platforms, targeted=None):
    url = f'https://github.com/{REPO_NAME}/releases/tag/v{version}'
    write(root / 'apps/desktop/package.json', json.dumps(
        {'name': 'nozeli-desktop', 'version': version, 'private': True}, indent=2) + '\n')
    write(root / 'apps/desktop/package-lock.json', json.dumps(
        {'version': version, 'packages': {'': {'version': version}}}, indent=2) + '\n')
    write(root / 'CHANGELOG.md', f'# Changelog\n\n## {version}\n\n- Fixture change with concrete detail.\n')
    write(root / 'docs/status.md', f'# Status\n\n当前基线 `{version}`。\n')
    write(root / 'docs/release.md', f'# Release\n\n当前基线 `{version}`；分发审计状态：未完成。\n')
    write(root / 'README.md', f'# Fixture\n\n发行链接 {url}。审计未完成：六项义务待签收。\n')
    inventory = {
        'productVersion': version,
        'publicRedistributionAudit': 'pending',
        'obligations': [{'id': 'fixture-source', 'obligation': 'fixture corresponding-source obligation',
                         'status': 'pending'}],
        'release': {'tag': f'v{version}', 'url': url, 'commit': None, 'platformsExercised': platforms,
                    **({'platformsTargeted': targeted} if targeted is not None else {})},
    }
    write(root / 'apps/desktop/compliance-inventory.json',
          json.dumps(inventory, ensure_ascii=False, indent=2) + '\n')
    git(root, 'init', '-b', 'main')
    git(root, 'config', 'user.email', 'fixture@example.invalid')
    git(root, 'config', 'user.name', 'Fixture Builder')
    git(root, 'add', '-A')
    git(root, 'commit', '-m', 'fixture release metadata')
    return git(root, 'rev-parse', 'HEAD')


def build_assets(directory, version, head, with_mac, mac_commit=None):
    """Public-asset layout: ASCII manifest names, builder-local 使用说明.md only."""
    directory.mkdir(parents=True, exist_ok=True)
    label = f'Nozeli-{version}-linux-x64'
    record = json.dumps({'application': 'Nozeli', 'version': version, 'platform': 'linux',
                         'arch': 'x64', 'commit': head}, indent=2) + '\n'
    with tarfile.open(directory / f'{label}.tar.gz', 'w:gz') as archive:
        info = tarfile.TarInfo(f'{label}/RELEASE.json')
        info.size = len(record.encode('utf-8'))
        info.mtime = 0
        archive.addfile(info, io.BytesIO(record.encode('utf-8')))
    (directory / f'Nozeli-{version}-source.tar.gz').write_bytes(b'fixture source archive payload\n')
    write(directory / '使用说明.md', f'# Nozeli {version} 使用说明\n')
    names = [f'{label}.tar.gz', f'Nozeli-{version}-source.tar.gz', 'USAGE.zh-CN.md']
    entries = {f'{label}.tar.gz': digest(directory / f'{label}.tar.gz'),
               f'Nozeli-{version}-source.tar.gz': digest(directory / f'Nozeli-{version}-source.tar.gz'),
               # Public ASCII alias of the byte-identical builder-local file.
               'USAGE.zh-CN.md': digest(directory / '使用说明.md')}
    if with_mac:
        mac_record = {'application': 'Nozeli', 'version': version, 'platform': 'darwin', 'arch': 'arm64',
                      'commit': mac_commit or head, 'format': 'app-zip', 'codesign': 'ad-hoc',
                      'notarized': False, 'developerId': False}
        with zipfile.ZipFile(directory / f'Nozeli-{version}-macos-arm64.zip', 'w') as archive:
            archive.writestr('Nozeli.app/Contents/MacOS/Nozeli', b'\xcf\xfa\xed\xfe fixture arm64 mach-o\n')
            archive.writestr('Nozeli.app/Contents/Resources/RELEASE.json',
                             json.dumps(mac_record, indent=2) + '\n')
        write(directory / 'USAGE-macos.zh-CN.md', f'# Nozeli {version} macOS 使用说明\n')
        entries[f'Nozeli-{version}-macos-arm64.zip'] = digest(directory / f'Nozeli-{version}-macos-arm64.zip')
        entries['USAGE-macos.zh-CN.md'] = digest(directory / 'USAGE-macos.zh-CN.md')
        names += [f'Nozeli-{version}-macos-arm64.zip', 'USAGE-macos.zh-CN.md']
    manifest = ''.join(f'{entries[name]}  {name}\n' for name in names)
    write(directory / 'SHA256SUMS.txt', manifest)
    return manifest


def gh_endpoint_map(version, head, manifest, asset_names, draft=True):
    asset_list = [{'name': name, 'size': max(1, len(manifest) if name == 'SHA256SUMS.txt' else 64), 'id': index + 1}
                  for index, name in enumerate(asset_names)]
    sums_id = next(asset['id'] for asset in asset_list if asset['name'] == 'SHA256SUMS.txt')
    return {
        f'repos/{REPO_NAME}/git/ref/tags/v{version}': {'object': {'type': 'commit', 'sha': head}},
        f'repos/{REPO_NAME}/releases?per_page=100': [
            {'tag_name': 'v0.0.9', 'draft': False, 'prerelease': False, 'assets': []},
            {'tag_name': f'v{version}', 'draft': draft, 'prerelease': True,
             'body': 'fixture notes; audit/审计 status disclosed as pending',
             'assets': asset_list},
        ],
        f'repos/{REPO_NAME}/actions/workflows/ci.yml/runs?head_sha={head}&per_page=100': {
            'workflow_runs': [{'id': 7, 'run_number': 3, 'run_attempt': 1, 'head_sha': head,
                               'status': 'completed', 'conclusion': 'success',
                               'html_url': 'https://fixture.invalid/run/7'}]},
        'repos/fixture/nozeli/actions/runs/7/jobs?per_page=100': {
            'jobs': [{'name': 'CI gate', 'conclusion': 'success'}]},
        f'repos/{REPO_NAME}/releases/assets/{sums_id}': manifest,  # octet-stream download
    }


def install_gh_stub(bin_dir, map_path):
    bin_dir.mkdir(parents=True, exist_ok=True)
    wrapper = bin_dir / 'gh'
    wrapper.write_text('#!/usr/bin/env python3\n'
                       'import os, sys\n'
                       f'os.execv(sys.executable, [sys.executable, {str(GH_STUB)!r}, *sys.argv[1:]])\n',
                       encoding='utf-8')
    wrapper.chmod(0o755)
    env = dict(os.environ)
    env['PATH'] = f'{bin_dir}{os.pathsep}{env.get("PATH", "")}'
    env['NOZELI_FIXTURE_GH_MAP'] = str(map_path)
    return env


def run_checker(repo, phase, assets_dir, env=None):
    command = [sys.executable, str(CHECKER), '--phase', phase, '--repo', REPO_NAME,
               '--root', str(repo)]
    if assets_dir is not None:
        command += ['--assets-dir', str(assets_dir)]
    finished = subprocess.run(command, cwd=repo, env=env or os.environ.copy(),
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, timeout=180)
    return finished.returncode, finished.stdout


SCENARIOS = [
    dict(name='alpha-linux-only-local-assets', version='0.1.0-alpha.6', platforms=LINUX_PLATFORMS,
         phase='prepare', mac=False, remote=None, expect=0,
         contains=['PASS local SHA-256: Nozeli-0.1.0-alpha.6-linux-x64.tar.gz',
                   'PASS portable RELEASE.json binds Nozeli version and intended commit',
                   'PASS portable archive contains exactly one expected RELEASE.json (streamed, not extracted)'],
         excludes=['macos-arm64']),
    dict(name='beta-dual-platform-local-assets', version='0.1.0-beta.1', platforms=LINUX_PLATFORMS,
         targeted=['linux-x64', 'macos-arm64'], phase='prepare', mac=True, remote=None, expect=0,
         contains=['PASS checksum coverage: Nozeli-0.1.0-beta.1-macos-arm64.zip',
                   'PASS checksum coverage: USAGE-macos.zh-CN.md',
                   'PASS local SHA-256: Nozeli-0.1.0-beta.1-macos-arm64.zip',
                   'PASS mac zip contains the Nozeli executable entry',
                   'PASS mac zip RELEASE.json binds Nozeli version and intended commit',
                   'PASS mac zip RELEASE.json declares darwin arm64',
                   'PASS mac zip RELEASE.json records ad-hoc signing without notarization'],
         excludes=[]),
    dict(name='beta-dual-platform-wrong-commit', version='0.1.0-beta.1', platforms=DUAL_PLATFORMS,
         phase='prepare', mac=True, mac_commit='0' * 40, remote=None, expect=1,
         contains=['FAIL mac zip RELEASE.json binds Nozeli version and intended commit'],
         excludes=[]),
    dict(name='beta-draft-complete', version='0.1.0-beta.1', platforms=LINUX_PLATFORMS,
         targeted=['linux-x64', 'macos-arm64'],
         phase='draft', mac=True, remote=dict(draft=True, drop_mac=False), expect=0,
         contains=['PASS exactly one release entry carries tag v0.1.0-beta.1',
                   'PASS selected release is still a draft (publication happens only by explicit maintainer action)',
                   'PASS prerelease version is marked prerelease',
                   'PASS remote asset exists and is nonempty: Nozeli-0.1.0-beta.1-macos-arm64.zip',
                   'PASS local and remote checksum manifests agree',
                   'PASS intended SHA has successful CI gate'],
         excludes=[]),
    dict(name='beta-draft-missing-mac-asset', version='0.1.0-beta.1', platforms=LINUX_PLATFORMS,
         targeted=['linux-x64', 'macos-arm64'],
         phase='draft', mac=False, remote=dict(draft=True, drop_mac=False), expect=1,
         contains=['FAIL remote asset exists and is nonempty: Nozeli-0.1.0-beta.1-macos-arm64.zip'],
         excludes=[]),
    dict(name='beta-draft-already-public', version='0.1.0-beta.1', platforms=LINUX_PLATFORMS,
         targeted=['linux-x64', 'macos-arm64'],
         phase='draft', mac=True, remote=dict(draft=False, drop_mac=False), expect=1,
         contains=['FAIL selected release is still a draft (publication happens only by explicit maintainer action)'],
         excludes=[]),
    dict(name='alpha-draft-linux-only', version='0.1.0-alpha.6', platforms=LINUX_PLATFORMS,
         phase='draft', mac=False, remote=dict(draft=True, drop_mac=False), expect=0,
         contains=['PASS selected release is still a draft (publication happens only by explicit maintainer action)',
                   'PASS remote asset exists and is nonempty: Nozeli-0.1.0-alpha.6-linux-x64.tar.gz'],
         excludes=['macos-arm64']),
]


def run_scenario(workspace, scenario):
    root = workspace / 'repo'
    head = build_repository(root, scenario['version'], scenario['platforms'], scenario.get('targeted'))
    assets = None
    env = None
    if scenario.get('mac') is not None:
        assets = workspace / 'assets'
        manifest = build_assets(assets, scenario['version'], head,
                                with_mac=scenario['mac'], mac_commit=scenario.get('mac_commit'))
    remote = scenario.get('remote')
    if remote is not None:
        bare = workspace / 'origin.git'
        subprocess.run(['git', 'init', '--bare', '-b', 'main', str(bare)], check=True,
                       stdout=subprocess.DEVNULL)
        git(root, 'remote', 'add', 'origin', str(bare))
        git(root, 'push', '-u', 'origin', 'main')
        git(root, 'tag', f'v{scenario["version"]}')
        git(root, 'push', 'origin', f'v{scenario["version"]}')
        public_names = [f'Nozeli-{scenario["version"]}-linux-x64.tar.gz',
                        f'Nozeli-{scenario["version"]}-source.tar.gz', 'USAGE.zh-CN.md']
        if scenario['mac']:
            public_names += [f'Nozeli-{scenario["version"]}-macos-arm64.zip', 'USAGE-macos.zh-CN.md']
        public_names += ['SHA256SUMS.txt']
        mapping = gh_endpoint_map(scenario['version'], head, manifest, public_names,
                                  draft=remote['draft'])
        map_path = workspace / 'gh_map.json'
        write(map_path, json.dumps(mapping, indent=2))
        env = install_gh_stub(workspace / 'bin', map_path)
    code, output = run_checker(root, scenario['phase'], assets, env)
    problems = []
    if code != scenario['expect']:
        problems.append(f'exit {code}, expected {scenario["expect"]}')
    for fragment in scenario['contains']:
        if fragment not in output:
            problems.append(f'missing output line: {fragment!r}')
    for fragment in scenario['excludes']:
        if fragment in output:
            problems.append(f'unexpected output mentioning: {fragment!r}')
    return problems, code, output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--keep', action='store_true', help='keep the temporary fixture workspace')
    args = parser.parse_args()
    failures = 0
    for scenario in SCENARIOS:
        workspace = Path(tempfile.mkdtemp(prefix=f'nozeli-checker-{scenario["name"]}-'))
        try:
            problems, code, output = run_scenario(workspace, scenario)
        except Exception as exc:  # Fixture infrastructure failure is itself a failing scenario.
            problems, code, output = [f'fixture error: {exc!r}'], -1, ''
        finally_pass = not problems
        failures += not finally_pass
        print(('PASS ' if finally_pass else 'FAIL ') + scenario['name'])
        for problem in problems:
            print(f'      {problem}')
        if problems:
            print('      --- checker output ---')
            for line in output.splitlines():
                print('      ' + line)
        if args.keep:
            print(f'      kept: {workspace}')
        elif not problems:
            shutil.rmtree(workspace, ignore_errors=True)
    print(f'RESULT {failures} fixture failure(s) across {len(SCENARIOS)} scenarios')
    return int(bool(failures))


if __name__ == '__main__':
    sys.exit(main())
