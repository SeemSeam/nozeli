#!/usr/bin/env python3
"""Read-only mechanical Nozeli release audit; no publishing or workflow polling."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile
from urllib.parse import quote


class Failure(Exception):
    pass


def run(args, root, binary=False):
    try:
        result = subprocess.run(args, cwd=root, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=90, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise Failure(f'{args[0]} unavailable or timed out: {exc}') from exc
    if result.returncode:
        # Never print command output that might contain authentication details.
        raise Failure(f'{args[0]} {args[1]} failed (exit {result.returncode}); inspect locally')
    return result.stdout if binary else result.stdout.decode('utf-8').strip()


class Audit:
    def __init__(self, args, root):
        self.args, self.root = args, root
        self.failures = 0
        self.repo = args.repo

    def check(self, condition, message):
        print(('PASS ' if condition else 'FAIL ') + message)
        self.failures += not condition

    def section(self, name, action):
        try:
            return action()
        except (Failure, OSError, ValueError, KeyError, TypeError, tarfile.TarError) as exc:
            self.check(False, f'{name}: {exc}')
            return None

    def git(self, *args):
        return run(['git', *args], self.root)

    def api(self, endpoint, raw=False):
        data = run(['gh', 'api', endpoint], self.root, binary=raw)
        return data if raw else json.loads(data)

    def text(self, name):
        return (self.root / name).read_text(encoding='utf-8')

    def metadata(self):
        package = json.loads(self.text('apps/desktop/package.json'))
        version = self.args.version or package['version']
        if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', version):
            raise Failure('invalid version (use version without leading v)')
        self.version, self.tag = version, 'v' + version
        self.names = [f'Nozeli-{version}-linux-x64.tar.gz',
                      f'Nozeli-{version}-source.tar.gz', 'USAGE.zh-CN.md']
        self.check(package['version'] == version, f'package version = {version}')
        self.check(package.get('private') is True, 'desktop package remains private (npm publish forbidden)')
        lock = json.loads(self.text('apps/desktop/package-lock.json'))
        self.check(lock.get('version') == version and lock.get('packages', {}).get('', {}).get('version') == version,
                   'lockfile top-level and root package versions match')
        changelog = self.text('CHANGELOG.md')
        heading = re.search(r'^##\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$', changelog, re.M)
        self.check(bool(heading and heading[1] == version), 'newest changelog version matches')
        if heading:
            entry = re.split(r'^##\s', changelog[heading.end():], maxsplit=1, flags=re.M)[0]
            self.check(bool(re.search(r'^[-*]\s+\S', entry, re.M)), 'current changelog contains concrete bullets (review semantics manually)')
        for name in ['docs/status.md', 'docs/release.md']:
            baseline = re.search(r'基线[^\n]*?`([^`]+)`', self.text(name))
            self.check(bool(baseline and baseline[1] == version), f'{name} current baseline matches')
        inventory = json.loads(self.text('apps/desktop/compliance-inventory.json'))
        self.inventory = inventory
        release = inventory.get('release', {})
        url = f'https://github.com/{self.repo}/releases/tag/{self.tag}'
        self.check(inventory.get('productVersion') == version and release.get('tag') == self.tag
                   and release.get('url') == url, 'inventory version, tag and URL match')
        readme = self.text('README.md')
        self.check(url in readme, 'README links current release')
        self.audit_pending = inventory.get('publicRedistributionAudit') == 'pending'
        self.check(inventory.get('publicRedistributionAudit') in ('pending', 'complete'), 'inventory audit status is explicit')
        pending = [item for item in inventory.get('obligations', []) if item.get('status') != 'signed-off']
        if self.audit_pending:
            self.check(bool(pending), 'pending audit retains open obligations')
            self.check('审计未完成' in readme and '分发审计状态：未完成' in self.text('docs/release.md'),
                       'README and release docs disclose pending audit')
            for item in pending:
                print(f"WARN AUDIT {item.get('id', 'unknown')}: {item.get('obligation', 'pending review')}")
            print('WARN AUDIT Public gate remains blocked; current explicit Alpha authorization must be reviewed manually.')
        else:
            self.check(not pending, 'complete audit has no unsigned obligations')
            for item in inventory.get('obligations', []):
                record = item.get('signoff') or {}
                self.check(bool(record.get('reviewer') and record.get('date') and record.get('summary') and record.get('evidence')),
                           f"signoff fields exist for {item.get('id')} (human authenticity requires review)")
        print('INFO Run node tools/check-repository.mjs --verify-hashes for evidence validation; --public is a separate honest gate.')
        return version

    def pushed(self):
        self.check(not self.git('status', '--porcelain', '--untracked-files=normal'), 'worktree clean, including untracked files')
        self.head = self.git('rev-parse', 'HEAD')
        upstream = self.git('rev-parse', '--symbolic-full-name', '@{upstream}')
        remote = self.git('config', '--get', 'branch.' + self.git('branch', '--show-current') + '.remote')
        merge = self.git('config', '--get', 'branch.' + self.git('branch', '--show-current') + '.merge')
        advertised = self.git('ls-remote', remote, merge).splitlines()
        self.check(bool(advertised and advertised[0].split()[0] == self.head),
                   f'HEAD matches live pushed upstream {upstream}')
        return self.head

    def ci(self, sha):
        endpoint = f'repos/{self.repo}/actions/workflows/ci.yml/runs?head_sha={sha}&per_page=100'
        runs = self.api(endpoint)['workflow_runs']
        matching = [r for r in runs if r.get('head_sha') == sha]
        if not matching:
            self.check(False, f'CI missing for intended SHA {sha}; no unrelated run accepted')
            return
        latest = max(matching, key=lambda r: (r.get('run_number', 0), r.get('run_attempt', 0)))
        ok = latest.get('status') == 'completed' and latest.get('conclusion') == 'success'
        self.check(ok, f"CI at {sha}: {latest.get('status')}/{latest.get('conclusion')} {latest.get('html_url')}")
        jobs = self.api(f"repos/{self.repo}/actions/runs/{latest['id']}/jobs?per_page=100")['jobs']
        gates = [j for j in jobs if j.get('name') == 'CI gate']
        self.check(bool(gates and all(j.get('conclusion') == 'success' for j in gates)), 'intended SHA has successful CI gate')

    def remote_file(self, name, ref):
        obj = self.api(f'repos/{self.repo}/contents/{name}?ref={quote(ref, safe="")}')
        return base64.b64decode(obj['content']).decode('utf-8')

    def checksum_map(self, text):
        entries = {}
        for line in text.splitlines():
            if not line.strip():
                continue
            match = re.fullmatch(r'([0-9a-fA-F]{64})[ \t]+\*?(.+)', line)
            if not match or match[2] in entries:
                raise Failure('malformed or duplicate checksum entry')
            name = match[2]
            if Path(name).name != name or name in ('.', '..'):
                raise Failure('checksum filenames must be plain asset names')
            entries[name] = match[1].lower()
        for name in self.names:
            self.check(name in entries, f'checksum coverage: {name}')
        return entries

    def published(self):
        self.tag_sha = self.git('rev-parse', '--verify', f'refs/tags/{self.tag}^{{commit}}')
        ref = self.api(f'repos/{self.repo}/git/ref/tags/{quote(self.tag, safe="")}')['object']
        for _ in range(8):
            if ref['type'] != 'tag':
                break
            ref = self.api(f"repos/{self.repo}/git/tags/{ref['sha']}")['object']
        self.check(ref.get('type') == 'commit' and ref.get('sha') == self.tag_sha,
                   'local and GitHub remote tag commit SHA match')
        self.git('merge-base', '--is-ancestor', self.tag_sha, self.head)
        self.check(True, 'clean pushed checkout contains release tag (later maintainer commits need not retag product)')
        commit = self.inventory.get('release', {}).get('commit')
        self.check(commit in (None, self.tag_sha), 'inventory commit is unset or matches tag (archive binding checked separately)')
        repo = self.api(f'repos/{self.repo}')
        default = repo['default_branch']
        self.check(default == 'main', 'default branch is expected protected main')
        comparison = self.api(f'repos/{self.repo}/compare/{self.tag_sha}...{quote(default, safe="")}')
        self.check(comparison.get('status') in ('ahead', 'identical'), 'remote default branch contains tag commit')
        readme = self.remote_file('README.md', default)
        self.check(f'https://github.com/{self.repo}/releases/tag/{self.tag}' in readme, 'homepage default-branch README links current release')
        if self.audit_pending:
            self.check('审计未完成' in readme, 'remote homepage discloses pending audit')
        release = self.api(f'repos/{self.repo}/releases/tags/{quote(self.tag, safe="")}')
        self.check(release.get('tag_name') == self.tag and not release.get('draft'), 'selected release is published (not latest-stable lookup)')
        if '-alpha' in self.version:
            self.check(release.get('prerelease') is True, 'Alpha release is marked prerelease')
        if self.audit_pending:
            self.check('-alpha' in self.version, 'pending-audit exception is not used for stable release')
            self.check(bool(re.search(r'audit|审计', release.get('body') or '', re.I)), 'release notes disclose audit status (review wording/authorization manually)')
        assets = release.get('assets', [])
        by_name = {asset['name']: asset for asset in assets}
        self.check(len(by_name) == len(assets), 'remote asset names are unique')
        for name in self.names + ['SHA256SUMS.txt']:
            self.check(name in by_name and by_name[name].get('size', 0) > 0, f'remote asset exists and is nonempty: {name}')
        manifest = by_name.get('SHA256SUMS.txt')
        self.remote_sums = None
        if manifest:
            if manifest.get('size', 0) > 65536:
                raise Failure('remote checksum manifest unexpectedly exceeds 64 KiB')
            data = run(['gh', 'api', '-H', 'Accept: application/octet-stream',
                        f"repos/{self.repo}/releases/assets/{manifest['id']}"], self.root, binary=True)
            self.remote_sums = self.checksum_map(data.decode('utf-8'))
        self.section('release commit CI', lambda: self.ci(self.tag_sha))
        print('INFO Release candidate check is separate: its public-audit failure is not CI success; inspect exact tag-ref run and logs manually.')

    def local_assets(self):
        directory = self.args.assets_dir.expanduser().resolve()
        sums = self.checksum_map((directory / 'SHA256SUMS.txt').read_text(encoding='utf-8'))
        if getattr(self, 'remote_sums', None) is not None:
            self.check(sums == self.remote_sums, 'local and remote checksum manifests agree')
        for name in self.names:
            digest = hashlib.sha256()
            local = directory / name
            if name == 'USAGE.zh-CN.md' and not local.exists():
                local = directory / '使用说明.md'
            with local.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            self.check(digest.hexdigest() == sums.get(name), f'local SHA-256: {name}')
        expected = f'Nozeli-{self.version}-linux-x64/RELEASE.json'
        found = 0
        with tarfile.open(directory / self.names[0], mode='r|gz') as archive:
            for member in archive:
                if member.name != expected:
                    continue
                found += 1
                if not member.isfile() or member.size > 65536:
                    raise Failure('RELEASE.json must be a small regular file')
                with archive.extractfile(member) as stream:
                    record = json.load(stream)
                commit = getattr(self, 'tag_sha', None) or self.git('rev-parse', 'HEAD')
                self.check(record.get('application') == 'Nozeli' and record.get('version') == self.version
                           and record.get('commit') == commit, 'portable RELEASE.json binds Nozeli version and intended commit')
        self.check(found == 1, 'portable archive contains exactly one expected RELEASE.json (streamed, not extracted)')
        print('INFO Local hashes do not prove remote tar bytes; download published assets separately and verify before reporting release complete.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=['prepare', 'dev', 'published'], default='prepare')
    parser.add_argument('--repo', default='SeemSeam/nozeli')
    parser.add_argument('--version', help='version without leading v; defaults to desktop package')
    parser.add_argument('--assets-dir', type=Path)
    parser.add_argument('--root', type=Path, help='git checkout; otherwise discover from current working directory')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo):
        parser.error('--repo must be OWNER/REPO')
    try:
        root = Path(run(['git', 'rev-parse', '--show-toplevel'], args.root or Path.cwd()))
    except Failure as exc:
        print(f'FAIL repository discovery: {exc}')
        return 1
    audit = Audit(args, root)
    version = audit.section('metadata', audit.metadata)
    head = None
    if args.phase != 'prepare':
        head = audit.section('clean/pushed state', audit.pushed)
    if args.phase == 'dev' and head:
        audit.section('development CI', lambda: audit.ci(head))
    if args.phase == 'published' and version:
        audit.section('published state', audit.published)
    if args.assets_dir and version:
        audit.section('local assets', audit.local_assets)
    print(f'RESULT {audit.failures} technical failure(s); audit warnings are independent and do not authorize publication.')
    return int(bool(audit.failures))


if __name__ == '__main__':
    sys.exit(main())
