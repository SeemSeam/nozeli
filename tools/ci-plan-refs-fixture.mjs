#!/usr/bin/env node
// Verifies the trusted base/head resolver embedded in .github/workflows/ci.yml by
// replaying synthetic GitHub event payloads against a scratch git repository. The
// resolver heredoc is extracted from the workflow file itself, so this fixture
// always exercises the exact production logic instead of a copied twin.
// Usage (acceptance): node tools/ci-plan-refs-fixture.mjs
// Requires: node >= 22 and git. Performs no network calls of its own; the release
// case intentionally points at a nonexistent repository so the resolver's API
// fallback (force full) is exercised offline and online alike.
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const extractResolver = () => {
  const lines = readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8').split('\n');
  const stepIndex = lines.findIndex((line) => /^\s*id:\s*refs\s*$/.test(line));
  if (stepIndex < 0) throw new Error('ci.yml: no step with id: refs');
  const openIndex = lines.findIndex((line, index) => index > stepIndex && /<<'NODE'\s*$/.test(line));
  if (openIndex < 0) throw new Error('ci.yml: resolver step has no node heredoc');
  const indent = lines[openIndex].match(/^ */)[0].length;
  const body = [];
  for (let index = openIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === 'NODE' && line.startsWith(' '.repeat(indent))) break;
    body.push(line.length >= indent ? line.slice(indent) : '');
  }
  return `${body.join('\n')}\n`;
};

const scratch = mkdtempSync(path.join(os.tmpdir(), 'ci-plan-refs-fixture-'));
const failures = [];
try {
  const resolverPath = path.join(scratch, 'resolver.mjs');
  writeFileSync(resolverPath, extractResolver());
  const repo = path.join(scratch, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'}).trim();
  const commit = (message) => {
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'ci plan refs fixture');
  const mainBase = commit('main base');
  git('checkout', '-q', '-b', 'integration/fixture');
  const risky = commit('integration risky change');
  const leaf = commit('css leaf change');
  git('update-ref', 'refs/remotes/origin/main', mainBase);

  const runCase = (name, eventName, event, expect) => {
    const eventPath = path.join(scratch, `${name}-event.json`);
    const refsPath = path.join(scratch, `${name}-refs.json`);
    writeFileSync(eventPath, `${JSON.stringify(event)}\n`);
    const env = {...process.env, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: eventName, PLAN_REFS_PATH: refsPath};
    delete env.GITHUB_TOKEN;
    const child = spawnSync(process.execPath, [resolverPath], {cwd: repo, env, encoding: 'utf8'});
    if (child.status !== 0) {
      failures.push(`${name}: resolver exited ${child.status}`);
      console.log(`FAIL ${name}: exit=${child.status} stderr=${(child.stderr ?? '').trim()}`);
      return;
    }
    const refs = JSON.parse(readFileSync(refsPath, 'utf8'));
    const problem = expect(refs);
    if (problem) {
      failures.push(`${name}: ${problem}`);
      console.log(`FAIL ${name}: ${problem}`);
    } else {
      console.log(`PASS ${name}`);
    }
  };

  const zeros = '0'.repeat(40);
  const expectBase = (expectedBase, extra) => (refs) => {
    if (refs.head !== leaf) return `head ${refs.head} != leaf ${leaf}`;
    if (refs.forceFull) return `unexpected forceFull (${refs.reason})`;
    if (refs.base !== expectedBase) return `base ${refs.base} != ${expectedBase}`;
    return extra ? extra(refs) : null;
  };
  const expectForceFull = (reasonPattern, extra) => (refs) => {
    if (!refs.forceFull) return `expected forceFull, got base=${refs.base}`;
    if (!reasonPattern.test(refs.reason)) return `reason "${refs.reason}" does not match ${reasonPattern}`;
    return extra ? extra(refs) : null;
  };

  // integration/** pushes diff the branch's complete increment from merge-base(origin/main, HEAD),
  // never just the previous tip: `before` (risky) must NOT become the base here.
  runCase('push-integration-increment', 'push', {ref: 'refs/heads/integration/fixture', before: risky, after: leaf},
    expectBase(mainBase, (refs) => (refs.releaseBranch ? 'releaseFlag should be false' : null)));
  // First push of an integration branch (zero before) still gets the full increment baseline.
  runCase('push-integration-new-branch', 'push', {ref: 'refs/heads/integration/fixture', before: zeros, after: leaf},
    expectBase(mainBase));
  // Head already contained in main: fall back to `before`, requiring ancestry.
  git('update-ref', 'refs/remotes/origin/main', leaf);
  runCase('push-integration-contained', 'push', {ref: 'refs/heads/integration/fixture', before: risky, after: leaf},
    expectBase(risky));
  runCase('push-integration-contained-bad-before', 'push', {ref: 'refs/heads/integration/fixture', before: zeros, after: leaf},
    expectForceFull(/ancestor baseline/));
  // Protected main trusts its previous tip.
  runCase('push-main-before', 'push', {ref: 'refs/heads/main', before: risky, after: leaf},
    expectBase(risky));
  runCase('push-main-new-branch', 'push', {ref: 'refs/heads/main', before: zeros, after: leaf},
    expectForceFull(/before baseline/));
  runCase('push-head-mismatch', 'push', {ref: 'refs/heads/main', before: risky, after: mainBase},
    expectForceFull(/checked-out commit/));
  // push events carry before/after at the payload top level, not under a push object.
  runCase('push-payload-missing-refs', 'push', {ref: 'refs/heads/main'},
    expectForceFull(/before\/after/));
  // pull_request diffs the PR base against the checked-out merge head.
  runCase('pull-request-base', 'pull_request', {pull_request: {base: {sha: mainBase}}},
    expectBase(mainBase));
  runCase('workflow-dispatch-full', 'workflow_dispatch', {},
    expectForceFull(/manual dispatch/));
  // release/beta* resolves the latest published release via API; an unresolvable
  // repository must fall back to full instead of shrinking the release diff.
  runCase('push-release-baseline-unavailable', 'push',
    {ref: 'refs/heads/release/beta9-20261113', before: risky, after: leaf, repository: {full_name: 'nozeli/ci-plan-refs-fixture-absent'}},
    expectForceFull(/release baseline/, (refs) => (refs.releaseBranch ? null : 'releaseFlag should be true')));
  // Missing origin/main ref on an integration push must not guess a baseline.
  git('update-ref', '-d', 'refs/remotes/origin/main');
  runCase('push-integration-missing-main-ref', 'push', {ref: 'refs/heads/integration/fixture', before: risky, after: leaf},
    expectForceFull(/origin\/main/));

  if (failures.length) {
    console.error(`ci-plan-refs fixture: ${failures.length} case(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('ci-plan-refs fixture: all cases passed');
  }
} finally {
  rmSync(scratch, {recursive: true, force: true});
}
