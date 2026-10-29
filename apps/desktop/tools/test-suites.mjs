// Deterministic named test suites for the Nozeli desktop app.
//
// Usage:
//   node tools/test-suites.mjs <unit|integration|smoke|live|default> [--list]
//
// Design rules (see docs/testing.md):
// - File lists are explicit. No shell globs, no directory discovery: a test joins
//   a suite only by being named here, so `npm test` can never pick up an
//   accidental probe.
// - Missing prerequisites are hard failures with actionable messages. Suites
//   never silently skip files or shrink themselves when something is absent.
// - `live` requires explicit opt-in (NOZELI_TEST_LIVE=1) and only contains
//   deterministic local flows: the bundled native runtime against loopback
//   scripted HTTP. It never loads real accounts and never contacts a paid model.
// - Child processes are spawned portably via child_process.spawn (no shell), so
//   the runner works the same under npm scripts, CI, Xvfb, or a dev shell.
// - `node --test` suites run with --test-concurrency=2 by default (override
//   with NOZELI_TEST_CONCURRENCY) to bound forking and SQLite contention in CI.
// - Real child output is preserved under .test-output/ci/: the child's actual
//   TAP stream for node-test suites ({suite}.tap), raw combined output for
//   script suites ({suite}.log). The runner never recounts or fabricates.

import { spawn, spawnSync } from 'node:child_process';
import { finished } from 'node:stream/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const testsDir = path.join(appRoot, 'tests');

// ---------------------------------------------------------------------------
// Suite membership. Keep sorted. When adding a file, apply the boundaries from
// docs/testing.md:
//   unit         pure logic under plain Node; no real filesystem writes, no
//                child processes, no Git, no Electron, no native runtime.
//   integration  real temporary files/Git/storage under plain Node; every test
//                must create its own isolated mkdtemp root; no GUI, no model
//                provider, no prebuilt private runtime.
//   smoke        actual Electron app: startup, local file open, clean exit.
//                Headless by default; Xvfb compatible; ephemeral ports only.
//   live         actual bundled native OMP runtime with deterministic loopback
//                responses; explicit opt-in; no credentials, no network model.
// ---------------------------------------------------------------------------
const SUITES = {
  unit: {
    description: 'pure logic, plain Node, no fs writes / subprocesses / GUI / credentials',
    files: [
      'application-singleton.test.mjs',
      'archify-diagram.test.mjs',
      'attention-dialogue.test.mjs',
      'attention-ledger.test.mjs',
      'authorship-groups.test.mjs',
      'capture-sources.test.mjs',
      'code-file-support.test.mjs',
      'complex-routing-evidence.test.mjs',
      'configuration-notice.test.mjs',
      'conversation-input-state.test.mjs',
      'document-collaboration.test.mjs',
      'document-context-menu.test.mjs',
      'document-export.test.mjs',
      'drawing-delivery.test.mjs',
      'editor-adapter.test.mjs',
      'html-report.test.mjs',
      'isolated-preview.test.mjs',
      'lifecycle-flush-capability.test.mjs',
      'main-startup-recovery.test.mjs',
      'managed-context-delivery.test.mjs',
      'managed-context-reader.test.mjs',
      'managed-deviation-surface.test.mjs',
      'managed-frontdesk-surface.test.mjs',
      'managed-memory-retrieval-layers.test.mjs',
      'managed-progress.test.mjs',
      'managed-review-availability.test.mjs',
      'managed-review-draft.test.mjs',
      'managed-turn-metrics-streaming.test.mjs',
      'managed-turn-metrics.test.mjs',
      'managed-turn-usage-settlement-oct12.test.mjs',
      'managed-work-records.test.mjs',
      'native-review-renderer.test.mjs',
      'note-form-layout.test.mjs',
      'notification-retention.test.mjs',
      'omp-only-ipc.test.mjs',
      'project-file-refresh.test.mjs',
      'project-recovery-owner.test.mjs',
      'renderer-provider-terminal.test.mjs',
      'runtime-failure-message.test.mjs',
      'session-store.test.mjs',
      'settings-agents-ui.test.mjs',
      'surface-identity-state.test.mjs',
      'tag-markdown.test.mjs',
      'tag-numbering.test.mjs',
      'terminal-input.test.mjs',
      'terminal-screen.test.mjs',
      'tex-inference.test.mjs',
      'tex-workspace-persist.test.mjs',
      'worker-terminal-first-frame-oct12-deadline.test.mjs',
      'worker-terminal-first-frame-oct12.test.mjs',
      'worker2-long-context.test.mjs',
      'workspace-layout.test.mjs',
    ],
    runner: 'node-test',
    preflight: [nodeVersionCheck],
  },
  integration: {
    description: 'real temp files / Git / storage under plain Node; isolated mkdtemp roots; no GUI, no model provider',
    files: [
      'acceptance-request-control.test.mjs',
      'agent-legacy-quota.test.mjs',
      'agent-process-budget.test.mjs',
      'annotation-package.test.mjs',
      'attention-projection.test.mjs',
      'c1-installed-open-entry.test.mjs',
      'collab-controller-projection.test.mjs',
      'curation-presentation.test.mjs',
      'discussion-thread-transcript.test.mjs',
      'document-authorship.test.mjs',
      'document-image.test.mjs',
      'document-versions.test.mjs',
      'drawing-image-delivery.test.mjs',
      'execution-copy-gitignore.test.mjs',
      'execution-workspace-dependencies.test.mjs',
      'external-open-queue.test.mjs',
      'external-open-renderer-contract.test.mjs',
      'failed-surface-lifecycle.test.mjs',
      'file-availability.test.mjs',
      'file-tree-ops.test.mjs',
      'frozen-change-reader.test.mjs',
      'git-runtime.test.mjs',
      'guided-demo-host-safety.test.mjs',
      'host-files.test.mjs',
      'host-formatter.test.mjs',
      'host-language-service.test.mjs',
      'host-review.test.mjs',
      'html-candidate-transaction.test.mjs',
      'html-report-lifecycle.test.mjs',
      'image-host.test.mjs',
      'legacy-resident-freeze.test.mjs',
      'legacy-word.test.mjs',
      'managed-acceptance-frozen-bytes.test.mjs',
      'managed-adoption-history.test.mjs',
      'managed-cancel-command.test.mjs',
      'managed-controller.test.mjs',
      'managed-deviation.test.mjs',
      'managed-file-refresh.test.mjs',
      'managed-frontdesk-read.test.mjs',
      'managed-frontdesk-transfer.test.mjs',
      'managed-frontgoal-targets.test.mjs',
      'managed-input-boundaries.test.mjs',
      'managed-local-disposition.test.mjs',
      'managed-memory-version.test.mjs',
      'managed-merge-consent.test.mjs',
      'managed-native-restart.test.mjs',
      'managed-offline-history.test.mjs',
      'managed-offline-report-export.test.mjs',
      'managed-omp-backend.test.mjs',
      'managed-post-install-recovery.test.mjs',
      'managed-post-install-usage.test.mjs',
      'managed-problem-decisions.test.mjs',
      'managed-project-resident-handoff.test.mjs',
      'managed-projects.test.mjs',
      'managed-report-export.test.mjs',
      'managed-resident-handoff.test.mjs',
      'managed-review-candidate.test.mjs',
      'managed-review-projection.test.mjs',
      'managed-role-skills.test.mjs',
      'managed-submission.test.mjs',
      'managed-task-flow.test.mjs',
      'managed-todo-ipc.test.mjs',
      'managed-todo-management.test.mjs',
      'managed-token-usage-checkpoint.test.mjs',
      'managed-work-outcomes.test.mjs',
      'managed-work-todo-lifecycle.test.mjs',
      'managed-worker-delivery.test.mjs',
      'managed-workspace-disposition.test.mjs',
      'managed-workspace-publication-rollback.test.mjs',
      'managed-worktree-isolation.test.mjs',
      'material-store.test.mjs',
      'nozeli-config-worktree.test.mjs',
      'omp-bridge-endpoint.test.mjs',
      'omp-default-models.test.mjs',
      'omp-only-cutover.test.mjs',
      'omp-system-inheritance.test.mjs',
      'omp-terminal-bridge.test.mjs',
      'omp-tui-session.test.mjs',
      'omp-tui-tools-compat.test.mjs',
      'point-anchor-guards.test.mjs',
      'post-install-worker2-presentation.test.mjs',
      'privilege-broker.test.mjs',
      'process-launch-config.test.mjs',
      'project-git-edge.test.mjs',
      'project-git.test.mjs',
      'project-lifecycle-admission.test.mjs',
      'project-lifecycle-stale-remove-hold.test.mjs',
      'project-lifecycle.test.mjs',
      'project-navigation.test.mjs',
      'project-reload.test.mjs',
      'project-storage-initialization.test.mjs',
      'project-watcher.test.mjs',
      'provider-settings.test.mjs',
      'region-drawing.test.mjs',
      'release-retention.test.mjs',
      'renderer-tag-draft.test.mjs',
      'report-descriptor.test.mjs',
      'session-archives.test.mjs',
      'session-index.test.mjs',
      'shadow-versions-gc.test.mjs',
      'shadow-versions.test.mjs',
      'sheet-host.test.mjs',
      'storage-file-cutover.test.mjs',
      'storage-host-cutover.test.mjs',
      'storage-managed-cutover.test.mjs',
      'storage-worker-safety.test.mjs',
      'system-terminal-bridge.test.mjs',
      'tag-input-presentation.test.mjs',
      'tag-material-delivery.test.mjs',
      'tag-session-identity.test.mjs',
      'tag-stability.test.mjs',
      'task-permissions.test.mjs',
      'tex-source-link.test.mjs',
      'user-save-feedback.test.mjs',
      'word-authorship.test.mjs',
      'word-host.test.mjs',
      'work-changes-large.test.mjs',
      'work-changes.test.mjs',
      'workspace-capture-store.test.mjs',
      'workspace-layout-store.test.mjs',
      'workspace-native.test.mjs',
    ],
    runner: 'node-test',
    preflight: [nodeVersionCheck, gitCheck],
  },
  smoke: {
    description: 'lightweight CI smoke: actual Electron no-model startup, synthetic project registration, file browse, native edit, clean close, cold-restart persistence (headless by default, Xvfb compatible)',
    files: [
      'desktop-ci-smoke.mjs',
    ],
    runner: 'script',
    preflight: [nodeVersionCheck, rendererBuildCheck, electronInstallCheck],
  },
  live: {
    description: 'bundled native OMP runtime with deterministic loopback scripted responses; explicit opt-in; no credentials, no paid model',
    files: [
      'agent-resource-native.test.mjs',
      'omp-default-models-live.mjs',
      'omp-runtime-isolation.test.mjs',
      'omp-tui-attach-races.test.mjs',
    ],
    runner: 'node-test',
    preflight: [nodeVersionCheck, liveOptInCheck, gitCheck, ompRuntimeCheck, bwrapCheck, nodePtyAbiCheck],
  },
};

const COMPOSITE = {
  // Safe coherent default: everything that needs only Node + npm deps.
  default: ['unit', 'integration'],
};

// ---------------------------------------------------------------------------
// Preflight checks. Each returns null when satisfied or a string describing the
// missing prerequisite. Failures abort the run; nothing is skipped silently.
// ---------------------------------------------------------------------------
function nodeVersionCheck() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isInteger(major) || major < 22) {
    return `Node >= 22 is required (tests use node:test and node:sqlite); current: ${process.versions.node}`;
  }
  return null;
}

function commandAvailable(command, args) {
  const probe = spawnSync(command, args, { stdio: 'ignore', timeout: 15000, cwd: appRoot });
  return probe.error === undefined && probe.status === 0;
}

function gitCheck() {
  if (!commandAvailable('git', ['--version'])) {
    return 'system `git` is required on PATH (several integration tests drive a real repository; dugite covers the rest)';
  }
  return null;
}

function rendererBuildCheck() {
  const app = path.join(appRoot, 'dist', 'renderer', 'app.js');
  if (!fs.existsSync(app)) {
    return 'dist/renderer/app.js is missing: run `npm run build:renderer` before the smoke suite';
  }
  return null;
}

function electronInstallCheck() {
  const electronEntry = path.join(appRoot, 'node_modules', 'electron', 'index.js');
  if (!fs.existsSync(electronEntry)) {
    return 'Electron is not installed: run `npm ci` in apps/desktop first (postinstall also rebuilds node-pty)';
  }
  return null;
}

function liveOptInCheck() {
  if (process.env.NOZELI_TEST_LIVE !== '1') {
    return [
      'live suite not enabled: this suite drives the real bundled native OMP runtime.',
      'It is deterministic (loopback scripted HTTP only, no credentials, no paid model),',
      'but it must never run unattended. Re-run with NOZELI_TEST_LIVE=1 to opt in.',
    ].join(' ');
  }
  return null;
}

function ompRuntimeCheck() {
  const omp = path.join(appRoot, 'runtime', 'omp', 'omp');
  if (!fs.existsSync(omp)) {
    return `bundled native runtime not found at runtime/omp/omp: run \`npm run build:omp\` first (was: ${omp})`;
  }
  return null;
}

function bwrapCheck() {
  if (!commandAvailable('bwrap', ['--version'])) {
    return 'bubblewrap (`bwrap`) is required on PATH: the native agent sandbox launches through it (e.g. apt install bubblewrap)';
  }
  return null;
}

// node-pty is rebuilt for Electron by postinstall (electron-rebuild). The
// dependency uses node-addon-api (N-API), whose binaries are ABI-stable across
// Node and Electron, so plain-Node live tests can still load it. Probe anyway:
// if a rebuild ever produces an Electron-only binary, fail loudly instead of
// letting the live suite crash test-by-test.
function nodePtyAbiCheck() {
  const probe = spawnSync(
    process.execPath,
    ['-e', "require('node-pty'); console.log('ok')"],
    { cwd: appRoot, encoding: 'utf8', timeout: 30000 },
  );
  if (probe.status !== 0 || !probe.stdout.includes('ok')) {
    return [
      'node-pty does not load under plain Node (likely an Electron-only ABI after a rebuild).',
      'Reinstall dependencies with `npm ci` (postinstall rebuild) — do not skip or trim the live suite.',
    ].join(' ');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
function fail(message) {
  console.error(`[test-suites] PREREQUISITE MISSING: ${message}`);
  process.exit(2);
}

function resolveSuite(name) {
  if (SUITES[name]) return [name];
  if (COMPOSITE[name]) return COMPOSITE[name];
  return null;
}

// spawn + wait without a shell; keeps output streaming to the parent terminal.
function awaitExit(child) {
  return new Promise((resolve) => {
    child.on('error', (error) => {
      console.error(`[test-suites] failed to start child process: ${error.message}`);
      process.exit(2);
    });
    child.once('exit', (code, signal) => {
      if (signal) {
        console.error(`[test-suites] child terminated by ${signal}`);
        process.exit(1);
      }
      resolve(code);
    });
  });
}

function artifactPath(name, extension) {
  const dir = path.join(appRoot, '.test-output', 'ci');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.${extension}`);
}

function testConcurrency() {
  const raw = process.env.NOZELI_TEST_CONCURRENCY ?? '2';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    fail(`NOZELI_TEST_CONCURRENCY must be a positive integer, got: ${raw}`);
  }
  return value;
}

function suiteEnvironment(name) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key) || /^(?:GH_|GITHUB_|GIT_CONFIG_|CCB_|CODEX_|OMP_|PI_)/.test(key) || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'NOZELI_CONFIG_ROOT', 'NOZELI_USER_DATA'].includes(key)) delete env[key];
  }
  const home = fs.mkdtempSync(path.join(path.dirname(artifactPath(name, 'tap')), `env-${name}-`));
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  return env;
}

async function runNodeTest(suite, name) {
  const args = [
    '--test',
    `--test-concurrency=${testConcurrency()}`,
    ...suite.files.map((file) => path.join(testsDir, file)),
  ];
  const tap = artifactPath(name, 'tap');
  console.error(`[test-suites] suite=${name} runner="node --test" files=${suite.files.length} concurrency=${testConcurrency()}`);
  console.error(`[test-suites] tap=${path.relative(process.cwd(), tap)}`);
  const child = spawn(process.execPath, args, { cwd: appRoot, env: suiteEnvironment(name) });
  const stream = fs.createWriteStream(tap, { flags: 'w' });
  // Tee the real child TAP stream to the terminal and the artifact verbatim.
  child.stdout.on('data', (chunk) => {
    stream.write(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.once('exit', () => stream.end());
  const code = await awaitExit(child);
  await finished(stream); // a failed evidence write is a real runner failure
  return code;
}


async function main() {
  const args = process.argv.slice(2);
  const KNOWN_FLAGS = new Set(['--list']);
  const unknown = args.filter((arg) => arg.startsWith('--') && !KNOWN_FLAGS.has(arg));
  if (unknown.length) {
    console.error(`[test-suites] unknown option(s): ${unknown.join(', ')}. Known: --list`);
    process.exit(2);
  }
  const listOnly = args.includes('--list');
  const names = args.filter((arg) => !arg.startsWith('--'));
  const requested = names.length ? names : ['default'];
  const expanded = [];
  for (const name of requested) {
    const suites = resolveSuite(name);
    if (!suites) {
      console.error(`[test-suites] unknown suite "${name}". Known: ${[...Object.keys(SUITES), ...Object.keys(COMPOSITE)].join(', ')}`);
      process.exit(2);
    }
    expanded.push(...suites);
  }

  if (listOnly) {
    for (const name of expanded) {
      console.log(`# ${name}: ${SUITES[name].description}`);
      for (const file of SUITES[name].files) console.log(`${file}`);
    }
    return;
  }

  for (const name of expanded) {
    const suite = SUITES[name];
    // Existence guard: a stale entry in a list is a hard error, never a skip.
    for (const file of suite.files) {
      const abs = path.join(testsDir, file);
      if (!fs.existsSync(abs)) {
        fail(`suite "${name}" lists tests/${file} but that file does not exist — update tools/test-suites.mjs`);
      }
    }
    for (const check of suite.preflight) {
      const problem = check();
      if (problem) fail(problem);
    }

    if (suite.runner === 'node-test') {
      const code = await runNodeTest(suite, name);
      if (code !== 0) {
        console.error(`[test-suites] suite=${name} FAILED (exit ${code})`);
        process.exit(code);
      }
      console.error(`[test-suites] suite=${name} PASSED (${suite.files.length} files)`);
    } else {
      // Sequential standalone scripts (smoke): each script owns its own
      // Electron lifecycle and asserts its own exit code.
      for (const [index, file] of suite.files.entries()) {
        const abs = path.join(testsDir, file);
        console.error(`[test-suites] suite=${name} script=${file}`);
        const log = artifactPath(name, 'log');
        console.error(`[test-suites] log=${path.relative(process.cwd(), log)}`);
        const child = spawn(process.execPath, [abs], { cwd: appRoot, env: suiteEnvironment(name) });
        const stream = fs.createWriteStream(log, { flags: index === 0 ? 'w' : 'a' });
        // Preserve each script's real combined output under a header line so a
        // multi-file suite keeps one honest artifact.
        stream.write(`# script: ${file}\n`);
        child.stdout.on('data', (chunk) => { stream.write(chunk); process.stdout.write(chunk); });
        child.stderr.on('data', (chunk) => { stream.write(chunk); process.stderr.write(chunk); });
        child.once('exit', () => stream.end());
        const code = await awaitExit(child);
        await finished(stream); // a failed evidence write is a real runner failure
        if (code !== 0) {
          console.error(`[test-suites] suite=${name} FAILED at ${file} (exit ${code})`);
          process.exit(code);
        }
        console.error(`[test-suites] suite=${name} ${file} PASSED`);
      }
      console.error(`[test-suites] suite=${name} PASSED (${suite.files.length} scripts)`);
    }
  }
}


main().catch((error) => {
  console.error(`[test-suites] runner error: ${error?.stack || error}`);
  process.exit(2);
});
