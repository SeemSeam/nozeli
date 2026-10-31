import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {atomicJson, ownedDirectory, readJson, semver, compareVersions, detectInstallation, extractPackage, validatePackage, downloadFile, processIdentity, MAX_ARCHIVE} from './auto-update-files.mjs';
import {acquireInstallLock} from './auto-update-helper.mjs';
export {detectInstallation} from './auto-update-files.mjs';
export {acknowledgeUpdateHealth} from './auto-update-helper.mjs';

const FEED = 'https://api.github.com/repos/SeemSeam/nozeli/releases';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const safeMessage = error => String(error?.message || error).replace(/https?:\/\/[^\s]+/g, '[release endpoint]').slice(0, 300);
export function selectRelease(releases, currentVersion) {
  if (!Array.isArray(releases)) throw Error('Invalid release feed');
  return releases.filter(release => !release.draft && semver(release.tag_name) && compareVersions(release.tag_name, currentVersion) > 0).map(release => {
    const version = semver(release.tag_name).version;
    const name = 'Nozeli-' + version + '-linux-x64.tar.gz';
    const assets = release.assets || [];
    const archives = assets.filter(asset => asset.name === name);
    const manifests = assets.filter(asset => asset.name === 'SHA256SUMS.txt');
    if (archives.length !== 1 || manifests.length !== 1 || archives[0].size > MAX_ARCHIVE || manifests[0].size > 256 * 1024) return null;
    return {version, tag: release.tag_name, name, archive: archives[0].browser_download_url, manifest: manifests[0].browser_download_url};
  }).filter(Boolean).sort((a, b) => compareVersions(b.version, a.version))[0] || null;
}
export function manifestChecksum(text, name) {
  const matches = text.split(/\r?\n/).map(line => /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line)).filter(match => match?.[2] === name);
  if (matches.length !== 1) throw Error('Checksum manifest must contain exactly one matching archive');
  return matches[0][1].toLowerCase();
}
async function boundedText(response, max, signal) {
  if (!response.ok || !response.body) throw Error('Release request failed: HTTP ' + response.status);
  const chunks = []; let received = 0;
  for await (const chunk of response.body) {
    signal?.throwIfAborted(); received += chunk.length;
    if (received > max) { await response.body.cancel?.().catch(() => {}); throw Error('Release response exceeds size limit'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
export class AutoUpdater {
  constructor({currentVersion, appRoot, stateDir, canInstall, prepareShutdown, resumeShutdown, quit, onStatus = () => {}, enabled = true, checkInterval = 6 * 60 * 60 * 1000, idleInterval = 30000, dependencies = {}}) {
    if (!semver(currentVersion) || !path.isAbsolute(appRoot) || !path.isAbsolute(stateDir)) throw Error('Invalid updater configuration');
    this.options = {currentVersion, appRoot, stateDir, canInstall, prepareShutdown, resumeShutdown, quit, onStatus, checkInterval, idleInterval};
    this.fetch = dependencies.fetch || globalThis.fetch;
    this.feed = dependencies.feed || FEED;
    this.tagApiBase = dependencies.tagApiBase || 'https://api.github.com/repos/SeemSeam/nozeli';
    // Test endpoints are constructor-only, never supplied by renderer IPC.
    this.testEndpoint = dependencies.allowLoopback === true;
    this.spawn = dependencies.spawn || spawn;
    this.clock = dependencies.now || Date.now;
    this.state = {phase: 'stopped', currentVersion, availableVersion: null, progress: null, message: '', enabled, supported: false};
    this.initialized = false; this.running = null; this.installing = false; this.timer = null; this.idleTimer = null;
  }
  status() { return structuredClone(this.state); }
  async initialize() {
    if (this.initialized) return;
    await fs.mkdir(this.options.stateDir, {recursive: true, mode: 0o700});
    await ownedDirectory(this.options.stateDir);
    const preferences = await readJson(path.join(this.options.stateDir, 'preferences.json')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (preferences && typeof preferences.enabled === 'boolean') this.state.enabled = preferences.enabled;
    this.installation = await detectInstallation(this.options.appRoot);
    this.state.supported = Boolean(this.installation);
    this.initialized = true;
    // Persisted status is informational only. Candidates are never trusted across restarts.
    const prior = await readJson(path.join(this.options.stateDir, 'handoff.json')).catch(() => null);
    if (prior?.phase === 'rolled-back' && semver(prior.version)) {
      this.quarantinedVersion = prior.version;
      this.state.failedVersion = prior.version;
      this.state.message = 'Update ' + prior.version + ' failed startup and was rolled back; automatic retry is paused. Check manually to retry.';
    }
    if (prior && ['promoting', 'awaiting-health'].includes(prior.phase) && prior.installation?.root === this.installation?.root) {
      const helper = prior.helperIdentity && await processIdentity(prior.helperIdentity.pid);
      const parent = prior.parent && await processIdentity(prior.parent.pid);
      if ((!helper || helper.start !== prior.helperIdentity.start) && (!parent || parent.start !== prior.parent.start)) {
        const owner = await readJson(path.join(prior.installation.root, '.installer-lock/owner.json'));
        if (owner.token !== prior.token || owner.identity.uid !== process.getuid()) throw Error('Interrupted updater lock identity mismatch');
        this.recovery = prior;
        this.candidate = {path: prior.candidate, version: prior.version};
        this.state.message = 'Interrupted update requires safe idle rollback';
      }
    }
  }
  update(fields) {
    Object.assign(this.state, fields);
    this.options.onStatus(this.status());
    // Queue state persistence to prevent an older progress write winning a newer phase.
    const snapshot = this.status();
    this.persist = (this.persist || Promise.resolve()).catch(() => {}).then(() => atomicJson(path.join(this.options.stateDir, 'status.json'), snapshot)).catch(() => {});
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw Error('enabled must be boolean');
    await this.initialize();
    await atomicJson(path.join(this.options.stateDir, 'preferences.json'), {enabled});
    this.update({enabled});
    if (!enabled) this.cancel();
    else if (this.timer) void this.check({automatic: true});
    return this.status();
  }
  async start() {
    try {
      await this.initialize();
    } catch (error) {
      // Optional update storage must not prevent the core workspace from opening.
      // Preserve damaged/unsafe state for inspection; never reset preferences or
      // turn network access back on while initialization is failing.
      clearInterval(this.timer); clearInterval(this.idleTimer);
      this.timer = this.idleTimer = null;
      this.controller?.abort();
      this.update({phase: 'error', enabled: false, progress: null, message: 'Automatic updates disabled: ' + safeMessage(error)});
      return this.status();
    }
    if (this.timer) return this.status();
    this.update({phase: this.installation ? 'current' : 'unsupported', message: this.installation ? this.state.message : 'Source/development installation: update checks only; automatic installation unavailable'});
    this.timer = setInterval(() => { if (this.state.enabled) void this.check({automatic: true}); }, this.options.checkInterval); this.timer.unref?.();
    this.idleTimer = setInterval(() => { if (this.state.enabled) void this.installIfIdle(); }, this.options.idleInterval); this.idleTimer.unref?.();
    if (this.state.enabled) void this.check({automatic: true});
    return this.status();
  }
  stop() {
    clearInterval(this.timer); clearInterval(this.idleTimer); this.timer = this.idleTimer = null;
    this.cancel();
    if (!this.installing) this.update({phase: 'stopped'});
  }
  cancel() { if (!this.installing) this.controller?.abort(); }
  url(value, kind) {
    const url = new URL(value);
    if (this.testEndpoint && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) && url.protocol === 'http:' && !url.username && !url.password) return url.href;
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('Untrusted release URL');
    if (kind === 'feed' && url.origin === 'https://api.github.com' && url.pathname === '/repos/SeemSeam/nozeli/releases') return url.href;
    if (kind === 'asset' && url.origin === 'https://github.com' && url.pathname.startsWith('/SeemSeam/nozeli/releases/download/') && !url.pathname.includes('%')) return url.href;
    throw Error('Untrusted release URL');
  }
  async request(url, kind, signal) {
    const value = this.url(url, kind);
    // GitHub assets redirect to an HTTPS object store; fetch never carries credentials.
    const response = await this.fetch(value, {signal, credentials: 'omit', headers: {'User-Agent': 'Nozeli-updater', 'Accept': kind === 'feed' ? 'application/vnd.github+json' : 'application/octet-stream'}, redirect: 'follow'});
    if (response.url) {
      const final = new URL(response.url);
      if (!(this.testEndpoint && final.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(final.hostname)) && (final.protocol !== 'https:' || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(final.hostname))) throw Error('Unsafe release redirect');
    }
    return response;
  }
  async resolveTagCommit(tag, signal) {
    const base = new URL(this.tagApiBase);
    const loopback = this.testEndpoint && base.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname);
    if ((!loopback && base.href !== 'https://api.github.com/repos/SeemSeam/nozeli') || base.username || base.password || base.search || base.hash) throw Error('Untrusted tag API');
    const get = async suffix => {
      const response = await this.fetch(base.href.replace(/\/$/, '') + suffix, {signal, credentials: 'omit', headers: {'User-Agent': 'Nozeli-updater', Accept: 'application/vnd.github+json'}, redirect: 'error'});
      return JSON.parse(await boundedText(response, 65536, signal));
    };
    const reference = await get('/git/ref/tags/' + encodeURIComponent(tag));
    if (reference.ref !== 'refs/tags/' + tag) throw Error('GitHub tag reference does not match release');
    let object = reference.object;
    const seen = new Set();
    for (let depth = 0; depth < 8; depth++) {
      if (!object || !/^[a-f0-9]{40}$/.test(object.sha) || seen.has(object.sha)) throw Error('Invalid or cyclic GitHub tag identity');
      if (object.type === 'commit') return object.sha;
      if (object.type !== 'tag') throw Error('Release tag does not resolve to a commit');
      seen.add(object.sha);
      const annotated = await get('/git/tags/' + object.sha);
      if (annotated.sha !== object.sha) throw Error('Annotated tag identity mismatch');
      object = annotated.object;
    }
    throw Error('Annotated release tag exceeds peeling limit');
  }
  async check({automatic = false} = {}) {
    if (this.running) return this.running;
    if (this.installing) return this.status();
    this.running = this.performCheck({automatic}).finally(() => { this.running = null; });
    return this.running;
  }
  async performCheck({automatic = false} = {}) {
    let staging, archive, timeout;
    try {
      await this.initialize();
      // Only an explicit host/user check opts into retrying a rolled-back release.
      if (!automatic) this.quarantinedVersion = null;
      if (this.recovery && this.candidate) { await this.installIfIdle(); return this.status(); }
      this.controller = new AbortController();
      const signal = this.controller.signal;
      timeout = setTimeout(() => this.controller?.abort(Error('Update request timed out')), 30 * 60 * 1000); timeout.unref?.();
      this.update({phase: 'checking', progress: null, message: ''});
      // Bound API enumeration; GitHub's release list is newest-first. Fetch all pages up to
      // 1,000 releases rather than using /latest, which excludes alpha prereleases.
      const releases = [];
      for (let page = 1; page <= 10; page++) {
        const url = new URL(this.url(this.feed, 'feed'));
        url.searchParams.set('per_page', '100'); url.searchParams.set('page', String(page));
        const response = await this.fetch(url, {signal, credentials: 'omit', headers: {'User-Agent': 'Nozeli-updater', Accept: 'application/vnd.github+json'}, redirect: 'error'});
        const items = JSON.parse(await boundedText(response, 8 * 1024 * 1024, signal));
        if (!Array.isArray(items)) throw Error('Invalid releases response');
        releases.push(...items);
        if (items.length < 100) break;
        if (page === 10) throw Error('Release feed exceeds bounded enumeration');
      }
      const applicable = this.quarantinedVersion ? releases.filter(item => !semver(item.tag_name) || compareVersions(item.tag_name, this.quarantinedVersion) !== 0) : releases;
      const release = selectRelease(applicable, this.options.currentVersion);
      if (!release) {
        this.update(this.quarantinedVersion ? {phase: 'error', availableVersion: this.quarantinedVersion, message: 'Update ' + this.quarantinedVersion + ' failed startup and was rolled back; automatic retry is paused. Check manually to retry.'} : {phase: this.installation ? 'current' : 'unsupported', availableVersion: null, message: 'No newer applicable release'});
        return this.status();
      }
      this.update({availableVersion: release.version});
      if (!this.installation) { this.update({phase: 'unsupported', message: 'New release available; source/development installations are check-only'}); return this.status(); }
      const expectedCommit = await this.resolveTagCommit(release.tag, signal);
      if (this.candidate?.version === release.version && this.candidate.commit === expectedCommit) {
        await validatePackage(this.candidate.path, release.version, expectedCommit);
        this.update({phase: 'ready', progress: null, message: 'Verified staged update reused; waiting for safe idle restart'});
        await this.installIfIdle();
        return this.status();
      }
      const manifest = await boundedText(await this.request(release.manifest, 'asset', signal), 256 * 1024, signal);
      const expected = manifestChecksum(manifest, release.name);
      const nonce = crypto.randomUUID();
      archive = path.join(this.options.stateDir, 'download-' + nonce + '.tar.gz');
      this.update({phase: 'downloading', progress: {received: 0, total: 0}});
      let lastProgress = 0;
      await downloadFile({response: await this.request(release.archive, 'asset', signal), file: archive, expected, signal, onProgress: progress => {
        if (this.clock() - lastProgress > 200 || progress.received === progress.total) { lastProgress = this.clock(); this.update({progress}); }
      }});
      this.update({phase: 'staging', progress: null});
      const base = this.installation.kind === 'managed' ? path.join(this.installation.root, 'releases') : this.installation.root;
      staging = path.join(base, '.nozeli-staging-' + nonce);
      const extracted = await extractPackage(archive, staging, release.version, signal, expectedCommit);
      const candidate = path.join(base, '.nozeli-update-' + release.version + '-' + nonce);
      await fs.rename(extracted, candidate); await fs.rmdir(staging); staging = null;
      this.candidate = {path: candidate, version: release.version, commit: expectedCommit};
      this.update({phase: 'ready', message: 'Update downloaded and verified; waiting for safe idle restart'});
      await this.installIfIdle();
    } catch (error) {
      this.update({phase: this.controller?.signal.aborted ? 'current' : 'error', message: this.controller?.signal.aborted ? 'Update cancelled' : safeMessage(error), progress: null});
    } finally {
      clearTimeout(timeout); this.controller = null;
      if (archive) await fs.rm(archive, {force: true}).catch(() => {});
      if (staging) await fs.rm(staging, {recursive: true, force: true}).catch(() => {});
    }
    return this.status();
  }
  async installIfIdle() {
    if (!this.candidate || this.installing || !this.state.enabled) return this.status();
    const {canInstall, prepareShutdown, quit} = this.options;
    if (![canInstall, prepareShutdown, quit].every(callback => typeof callback === 'function')) { this.update({phase: 'waiting-idle', message: 'Host lifecycle guards are unavailable'}); return this.status(); }
    this.installing = true;
    let lock, helper, shutdownAttempted = false;
    try {
      const readiness = await canInstall();
      if (!readiness?.ready) { this.update({phase: 'waiting-idle', message: readiness?.reason || 'Waiting for idle and no unsaved work'}); return this.status(); }
      // Revalidate installation identity immediately before taking the shared installer lock.
      const current = await detectInstallation(this.options.appRoot);
      if (!current || current.release !== this.installation.release || current.root !== this.installation.root) throw Error('Installation identity changed');
      const token = crypto.randomBytes(32).toString('hex');
      if (this.recovery) {
        const staleLock = path.join(current.root, '.installer-lock');
        const stale = await readJson(path.join(staleLock, 'owner.json'));
        const live = this.recovery.helperIdentity && await processIdentity(this.recovery.helperIdentity.pid);
        if (stale.token !== this.recovery.token || live?.start === this.recovery.helperIdentity?.start) throw Error('Recovery installer still active');
        await fs.rm(staleLock, {recursive: true});
      }
      lock = await acquireInstallLock(current.root, token);
      shutdownAttempted = true;
      if (await prepareShutdown() !== true) { this.update({phase: 'waiting-idle', message: 'Shutdown guard declined update restart'}); return this.status(); }
      const finalReadiness = await canInstall();
      if (!finalReadiness?.ready) { this.update({phase: 'waiting-idle', message: finalReadiness?.reason || 'New work appeared before restart'}); return this.status(); }
      const journal = path.join(this.options.stateDir, 'handoff.json');
      await atomicJson(journal, {...(this.recovery || {}), token, installation: this.recovery?.installation || current, candidate: this.candidate.path, version: this.candidate.version, expectedCommit: this.candidate.commit, parent: await processIdentity(process.pid), phase: 'prepared', recovery: Boolean(this.recovery)});
      const script = fileURLToPath(new URL('./auto-update-helper.mjs', import.meta.url));
      helper = this.spawn(path.join(current.release, 'nozeli'), [script, journal], {env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, cwd: current.root, detached: true, stdio: 'ignore'});
      let helperError; helper.once('error', error => { helperError = error; }); helper.unref?.();
      const deadline = this.clock() + 15000;
      while (this.clock() < deadline) {
        if (helperError) throw helperError;
        const handoff = await readJson(journal);
        if (handoff.token !== token) throw Error('Helper handoff identity changed');
        if (handoff.phase === 'helper-ready') {
          this.update({phase: 'installing', message: 'Restarting to install verified update'});
          await quit();
          lock = null; // helper owns cleanup only after the host accepted quit
          return this.status();
        }
        await sleep(50);
      }
      throw Error('Update helper did not become ready');
    } catch (error) {
      this.update({phase: 'error', message: safeMessage(error)});
    } finally {
      if (lock) {
        if (helper?.pid) { try { process.kill(helper.pid, 'SIGTERM'); } catch {} }
        await fs.rm(lock, {recursive: true, force: true});
      }
      if (this.state.phase !== 'installing') {
        this.installing = false;
        if (shutdownAttempted) await this.options.resumeShutdown?.();
      }
    }
    return this.status();
  }
}
