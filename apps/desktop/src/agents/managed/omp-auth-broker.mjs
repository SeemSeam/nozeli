// Private compiled OMP owns the Nozeli vault and official OAuth refresh APIs.
// Bearer grants cross anonymous pipes only; credentials never reach the renderer.
import { spawn } from 'node:child_process';
import path from 'node:path';

export const OMP_BROKER_CLIENT_ENV = Object.freeze({ OMP_AUTH_BROKER_SNAPSHOT_TTL_MS: '0' });

import { resolveBundledOmpRuntime } from './omp-runtime.mjs';
import { scrubProviderEnv } from './omp-credentials.mjs';
const validGrant = grant => {
  if (!grant || typeof grant.url !== 'string' || typeof grant.token !== 'string' || !grant.token) throw new Error('Private OMP broker returned an invalid grant');
  const url = new URL(grant.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Private OMP broker URL must use HTTP(S)');
  return { url: grant.url, token: grant.token };
};

async function terminate(child) {
  if (!child || child.spawnFailed || child.exitCode != null || child.signalCode != null) return;
  await new Promise((resolve, reject) => {
    const onExit = () => { clearTimeout(term); clearTimeout(kill); resolve(); };
    child.once('exit', onExit);
    const term = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
    const kill = setTimeout(() => { child.removeListener('exit', onExit); reject(new Error('Owned OMP auth helper failed to exit after SIGKILL')); }, 6000);
    try { child.kill('SIGTERM'); } catch (error) { clearTimeout(term); clearTimeout(kill); child.removeListener('exit', onExit); reject(error); }
  });
}

function response(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => { clearTimeout(timer); child.stdout.removeListener('data', onData); child.removeListener('error', onError); child.removeListener('exit', onExit); };
    const fail = error => { cleanup(); reject(error); };
    const onError = error => { child.spawnFailed = true; fail(new Error(`Private OMP auth helper failed to start (${error.code ?? 'spawn'})`)); };
    const onExit = code => fail(new Error(`Private OMP auth helper exited before readiness (${code})`));
    const onData = chunk => {
      buffer += chunk.toString();
      if (buffer.length > 65536) return fail(new Error('Private OMP auth helper returned oversized output'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try { const result = JSON.parse(buffer.slice(0, newline)); cleanup(); if (result.error) reject(new Error(result.error)); else resolve(result.grant); }
      catch { fail(new Error('Private OMP auth helper returned invalid readiness output')); }
    };
    const timer = setTimeout(() => fail(new Error('Private OMP auth helper readiness timeout')), timeoutMs);
    child.stdout.on('data', onData); child.once('error', onError); child.once('exit', onExit);
  });
}

export class OmpAuthBrokerHost {
  constructor({ command, source, sourceEnv, spawnFn = spawn } = {}) {
    if (!source || !sourceEnv) throw new Error('OmpAuthBrokerHost requires private source and sourceEnv');
    Object.assign(this, { command, source, sourceEnv, spawnFn });
    this.child = null; this.starting = null; this.grant = null; this.stopped = false;
  }
  async acquire() {
    if (this.stopped) throw new Error('auth broker host already stopped');
    if (this.grant) return this.grant;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try { return await this.starting; } finally { this.starting = null; }
  }
  async start() {
    let child;
    try {
      const command = this.command ?? (await resolveBundledOmpRuntime()).brokerCommand;
      if (!path.isAbsolute(command)) throw new Error('Nozeli broker requires an absolute bundled executable');
      const layout = await this.source.describe();
      const root = layout.root ?? this.source.root;
      if (!root || !path.isAbsolute(root)) throw new Error('Nozeli broker requires private configuration root');
      const { env: scrubbedEnv } = scrubProviderEnv(this.sourceEnv);
      const env = { ...scrubbedEnv, NOZELI_CONFIG_ROOT: root, NOZELI_AGENT_DIR: path.join(root, 'omp'), ...OMP_BROKER_CLIENT_ENV };
      for (const key of ['PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'OMP_AUTH_BROKER_URL', 'OMP_AUTH_BROKER_TOKEN']) delete env[key];
      if (this.stopped) throw new Error('auth broker host stopped during acquisition');
      child = this.spawnFn(command, ['--nozeli-auth-broker'], { cwd: root, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      this.child = child;
      child.on('error', () => {});
      child.once('exit', () => { if (this.child === child) { this.child = null; this.grant = null; } });
      const grant = validGrant(await response(child));
      if (this.stopped || this.child !== child || child.exitCode != null || child.signalCode != null) throw new Error('Private OMP broker exited during acquisition');
      this.grant = grant;
      return grant;
    } catch (error) {
      this.grant = null;
      await terminate(child);
      if (this.child === child) this.child = null;
      throw error;
    }
  }
  async stop() {
    this.stopped = true; this.grant = null;
    const starting = this.starting;
    await terminate(this.child);
    if (starting) await starting.catch(() => {});
    this.child = null;
    return { exited: true };
  }
}

