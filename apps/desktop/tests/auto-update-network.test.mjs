// Consumer-visible regressions for the updater's network path: GitHub anonymous rate
// limits must be diagnosed from response headers (never inferred from a bare 403),
// transport failures must surface as errors, and check-only installations must not be
// mislabeled. Header shapes below were captured from real api.github.com responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AutoUpdater, releaseRequestError, formatResetTime, trustedRedirectTarget, trustedUpdaterRequest} from '../src/main/auto-update.mjs';

const RATE_LIMIT_RESET = 1794371556; // x-ratelimit-reset observed from api.github.com on the affected network.
const SKIP_LINUX_LAYOUT = process.platform !== 'linux' || process.arch !== 'x64' ? 'requires the Linux x64 installation layout; not Mac updater qualification' : false;

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-update-net-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}
function release(version) {
  return {tag_name: 'v' + version, assets: [{name: 'Nozeli-' + version + '-linux-x64.tar.gz', browser_download_url: 'https://github.com/SeemSeam/nozeli/releases/download/v' + version + '/archive', size: 100}, {name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/SeemSeam/nozeli/releases/download/v' + version + '/SHA256SUMS.txt', size: 100}]};
}
function rateLimited(status = 403) {
  return new Response(JSON.stringify({message: 'API rate limit exceeded for 203.0.113.7'}), {status, headers: {'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-used': '60', 'x-ratelimit-reset': String(RATE_LIMIT_RESET), 'content-type': 'application/json'}});
}
async function updaterWith(t, fetch) {
  const root = await temporary(t);
  const updater = new AutoUpdater({currentVersion: '1.0.0', appRoot: root, stateDir: path.join(root, 'state'), enabled: false, dependencies: {fetch}});
  return {root, updater};
}
test('header-confirmed rate limits report the anonymous quota cause and reset time', () => {
  const message = releaseRequestError(rateLimited()).message;
  assert.match(message, /Release request failed: HTTP 403/);
  assert.match(message, /GitHub anonymous rate limit exhausted \(shared per-network quota\)/);
  assert.ok(message.includes(formatResetTime(RATE_LIMIT_RESET)), message);
});
test('secondary rate limits report retry-after; unrelated statuses stay bare', () => {
  assert.match(releaseRequestError(new Response('slow down', {status: 429, headers: {'retry-after': '60'}})).message, /HTTP 429: GitHub rate limit engaged; retry after 60 seconds/);
  assert.equal(releaseRequestError(new Response('gone', {status: 404})).message, 'Release request failed: HTTP 404');
  assert.equal(releaseRequestError(new Response('broken', {status: 500})).message, 'Release request failed: HTTP 500');
  // A 403 with quota remaining is not a rate limit and must not be dressed up as one.
  assert.equal(releaseRequestError(new Response('denied', {status: 403, headers: {'x-ratelimit-remaining': '54', 'x-ratelimit-reset': String(RATE_LIMIT_RESET)}})).message, 'Release request failed: HTTP 403');
  assert.equal(releaseRequestError(new Response('denied', {status: 403})).message, 'Release request failed: HTTP 403');
});

test('rate-limited feed check surfaces cause and reset time to the consumer', async t => {
  const {updater} = await updaterWith(t, async () => rateLimited());
  const status = await updater.check();
  assert.equal(status.phase, 'error');
  assert.equal(status.supported, false);
  assert.match(status.message, /HTTP 403/);
  assert.match(status.message, /anonymous rate limit exhausted/);
  assert.ok(status.message.includes(formatResetTime(RATE_LIMIT_RESET)), status.message);
  assert.equal(status.progress, null);
  updater.stop(); await updater.persist;
});
test('feed 403 without rate-limit headers stays a bare HTTP failure', async t => {
  const {updater} = await updaterWith(t, async () => new Response('Forbidden', {status: 403}));
  const status = await updater.check();
  assert.equal(status.phase, 'error');
  assert.equal(status.message, 'Release request failed: HTTP 403');
  updater.stop(); await updater.persist;
});
test('transport failures surface as errors and never masquerade as HTTP rejections', async t => {
  const failure = Object.assign(new TypeError('fetch failed'), {cause: Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), {code: 'ECONNRESET'})});
  const {updater} = await updaterWith(t, async () => { throw failure; });
  const status = await updater.check();
  assert.equal(status.phase, 'error');
  assert.match(status.message, /fetch failed/);
  assert.ok(!/HTTP \d/.test(status.message), status.message);
  assert.equal(status.progress, null);
  updater.stop(); await updater.persist;
});


test('asset destinations stay allowlisted when the stack reports redirect URLs', async t => {
  let assetResponse = {ok: true, status: 200, url: 'https://evil.example.com/archive', headers: new Headers(), body: null};
  const {updater} = await updaterWith(t, async () => assetResponse);
  await assert.rejects(updater.request('https://github.com/SeemSeam/nozeli/releases/download/v1.0.1/archive', 'asset'), /Unsafe release redirect/);
  await assert.rejects(updater.request('https://evil.example.com/archive', 'asset'), /Untrusted release URL/);
  assetResponse = {ok: true, status: 200, url: 'https://objects.githubusercontent.com/archive', headers: new Headers(), body: null};
  const response = await updater.request('https://github.com/SeemSeam/nozeli/releases/download/v1.0.1/archive', 'asset');
  assert.equal(response.url, 'https://objects.githubusercontent.com/archive');
  updater.stop(); await updater.persist;
});

test('rate-limited manifest keeps version visibility and explains the throttle', {skip: SKIP_LINUX_LAYOUT}, async t => {
  const root = await temporary(t), releaseDir = path.join(root, 'app'), commit = 'a'.repeat(40);
  await fs.mkdir(releaseDir, {mode: 0o700});
  await fs.mkdir(path.join(releaseDir, 'resources/app'), {recursive: true});
  await fs.writeFile(path.join(releaseDir, 'INSTALLATION.json'), JSON.stringify({application: 'Nozeli', platform: 'linux', arch: 'x64', state: 'validated'}));
  await fs.writeFile(path.join(releaseDir, 'AppRun'), '', {mode: 0o755});
  const route = async input => {
    const url = String(input);
    if (url.includes('/git/ref/tags/')) return new Response(JSON.stringify({ref: 'refs/tags/v1.0.1-alpha.1', object: {sha: commit, type: 'commit'}}), {headers: {'content-type': 'application/json'}});
    if (url.includes('/releases/download/')) return rateLimited();
    return new Response(JSON.stringify([release('1.0.1-alpha.1')]), {headers: {'content-type': 'application/json'}});
  };
  const updater = new AutoUpdater({currentVersion: '1.0.0', appRoot: path.join(releaseDir, 'resources/app'), stateDir: path.join(root, 'state'), enabled: false, dependencies: {fetch: route}});
  const status = await updater.check();
  assert.equal(status.supported, true);
  assert.equal(status.phase, 'error');
  assert.equal(status.availableVersion, '1.0.1-alpha.1');
  assert.match(status.message, /anonymous rate limit exhausted/);
  assert.ok(status.message.includes(formatResetTime(RATE_LIMIT_RESET)), status.message);
  updater.stop(); await updater.persist;
});

test('session-guard allowlist admits GitHub hosts and updateTest loopback only', () => {
  assert.equal(trustedUpdaterRequest('https://api.github.com/repos/SeemSeam/nozeli/releases?per_page=100&page=1'), true);
  assert.equal(trustedUpdaterRequest('https://github.com/SeemSeam/nozeli/releases/download/v1.0.1/SHA256SUMS.txt'), true);
  assert.equal(trustedUpdaterRequest('https://release-assets.githubusercontent.com/github-production-release-asset/1?sp=r&sig=a'), true);
  assert.equal(trustedUpdaterRequest('https://objects.githubusercontent.com/x'), true);
  assert.equal(trustedUpdaterRequest('http://127.0.0.1:39601/releases', {allowLoopback: true}), true);
  assert.equal(trustedUpdaterRequest('http://localhost:9/x', {allowLoopback: true}), true);
  assert.equal(trustedUpdaterRequest('http://127.0.0.1:9/x'), false); // loopback needs the isolated-test flag
  assert.equal(trustedUpdaterRequest('https://evil.example.com/archive'), false);
  assert.equal(trustedUpdaterRequest('http://192.0.2.9/steal', {allowLoopback: true}), false); // external redirect hop observed live
  assert.equal(trustedUpdaterRequest('https://api.github.com@evil.example.com/'), false); // embedded userinfo
  assert.equal(trustedUpdaterRequest('not a url'), false);
  assert.equal(trustedRedirectTarget('http://127.0.0.1:9/x'), false); // final-URL check never admits plain http
});
