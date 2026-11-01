// Z.AI (GLM Coding Plan · ZCode) sign-in — real private Node worker protocol
// against local deterministic authorization endpoints (live suite: actual Pi
// SDK owner runtime, loopback scripted HTTP only, no browser, no real Z.AI
// account, no paid traffic, no credential reads).
//
// Drives the production OwnerRuntime (integrations/pi/src/bridge.mjs + the
// vendored pi-sdk-driver + the real ModelRuntime and auth.json persistence)
// over its JSONL interaction contract:
//   consent select -> browser URL frame -> pasted zcode:// callback ->
//   token exchange + business login + nozeli key mint against 127.0.0.1.
//
// Prerequisites (also enforced by the live-suite preflight):
//   cd integrations/pi && npm ci && npm run build
//   NOZELI_TEST_LIVE=1 node --test tests/pi-zai-coding-plan-live.mjs
// Real-account OAuth is intentionally NOT exercised here; that stays a
// user-participating manual smoke (see docs/pi-integration-execution.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { OwnerRuntime } from '../../../integrations/pi/src/bridge.mjs';

const REDIRECT_URI = 'zcode://zai-auth/callback';
const tokenEnvelope = data => ({ code: 0, msg: 'ok', data });
const bizEnvelope = data => ({ code: 200, msg: 'Operation successful', success: true, data });

function localZaiEndpoints() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined, authorization: req.headers.authorization ?? null });
      const send = payload => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (req.method === 'POST' && req.url === '/api/v1/oauth/token') {
        return send(tokenEnvelope({ token: 'zcode-jwt', zai: { access_token: 'oauth-access-token' }, user: { email: 'user@example.com', id: 'user-42' } }));
      }
      if (req.method === 'POST' && req.url === '/api/auth/z/login') return send(bizEnvelope({ access_token: 'biz-token' }));
      if (req.method === 'GET' && req.url === '/api/biz/customer/getCustomerInfo') {
        return send(bizEnvelope({ organizations: [{ organizationId: 'org-1', isDefault: true, projects: [{ projectId: 'proj-1', isDefault: true }] }] }));
      }
      if (req.method === 'GET' && req.url === '/api/biz/v1/organization/org-1/projects/proj-1/api_keys') return send(bizEnvelope([]));
      if (req.method === 'POST' && req.url === '/api/biz/v1/organization/org-1/projects/proj-1/api_keys') return send(bizEnvelope({ name: 'nozeli', apiKey: 'created-key', secretKey: 'inline-ignored' }));
      if (req.method === 'GET' && req.url === '/api/biz/v1/organization/org-1/projects/proj-1/api_keys/copy/created-key') return send(bizEnvelope({ secretKey: 'real-secret' }));
      res.writeHead(404); res.end('unrouted');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(done => { server.closeAllConnections(); server.close(() => done()); }),
  })));
}

async function workerFixture(t, endpoints) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-zai-worker-'));
  const agentDir = path.join(root, 'pi');
  const cwd = path.join(root, 'project');
  await Promise.all([fs.mkdir(agentDir, { recursive: true }), fs.mkdir(cwd, { recursive: true })]);
  const overrides = {
    // The explicit local-verification gate: without it the adapter pins every
    // endpoint to production and ignores the loopback overrides below.
    NOZELI_TEST_INSTANCE: '1',
    ZAI_OAUTH_AUTHORIZE_URL: `${endpoints.base}/api/oauth/authorize`,
    ZAI_OAUTH_TOKEN_URL: `${endpoints.base}/api/v1/oauth/token`,
    ZAI_BIZ_BASE: endpoints.base,
    ZAI_BUSINESS_LOGIN_URL: `${endpoints.base}/api/auth/z/login`,
  };
  const saved = {};
  for (const [name, value] of Object.entries(overrides)) { saved[name] = process.env[name]; process.env[name] = value; }
  const frames = [];
  const waitFor = predicate => new Promise(resolve => {
    const check = () => {
      const found = frames.find(predicate);
      if (found) resolve(found); else setTimeout(check, 10);
    };
    check();
  });
  const runtime = new OwnerRuntime({ send: frame => frames.push(frame) });
  t.after(() => runtime.stop().catch(() => {}));
  t.after(() => endpoints.close());
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  return { runtime, frames, waitFor, agentDir, cwd };
}

test('worker protocol: zai lists OAuth natively alongside built-ins, logins against local endpoints, key reaches auth.json and the model catalog', async t => {
  const endpoints = await localZaiEndpoints();
  const { runtime, frames, waitFor, agentDir, cwd } = await workerFixture(t, endpoints);

  // 1. Inventory comes from the real runtime: native OAuth built-ins preserved,
  //    zai gains OAuth while keeping native API-key setup.
  const before = await runtime.authList({ agentDir, cwd });
  const rows = new Map(before.credentials.map(row => [row.provider, row]));
  for (const provider of ['anthropic', 'github-copilot', 'kimi-coding', 'meta', 'openai', 'openai-codex', 'openrouter', 'xai']) {
    assert.equal(rows.get(provider)?.oauthSupported, true, `${provider} OAuth must stay available`);
  }
  assert.equal(rows.get('zai')?.oauthSupported, true, 'zai OAuth registered through the native path');
  assert.equal(rows.get('zai')?.apiKeySetupSupported, true, 'native zai API-key setup preserved');
  assert.equal(rows.get('zai')?.hasAuth, false);

  // 2. Full login over the JSONL interaction contract.
  const loginPromise = runtime.authLogin({ provider: 'zai', agentDir, cwd });
  const consent = await waitFor(frame => frame.event === 'interaction' && frame.interaction.kind === 'input');
  assert.match(consent.interaction.message, /nozeli/, 'consent names the dedicated key');
  assert.match(consent.interaction.message, /取消/, 'cancel is offered');
  await runtime.respond({ id: consent.interaction.id, answer: { text: '2' } });

  const urlFrame = await waitFor(frame => frame.event === 'interaction' && frame.interaction.kind === 'url');
  const authorizeUrl = new URL(urlFrame.interaction.url);
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, `${endpoints.base}/api/oauth/authorize`);
  assert.equal(authorizeUrl.searchParams.get('redirect_uri'), REDIRECT_URI);
  const state = authorizeUrl.searchParams.get('state');
  assert.ok(state);

  const manual = await waitFor(frame => frame.event === 'interaction' && frame.interaction.kind === 'input' && frame.interaction.id !== consent.interaction.id);
  await runtime.respond({ id: manual.interaction.id, answer: { text: `${REDIRECT_URI}?code=auth-code&state=${state}` } });

  assert.deepEqual(await loginPromise, { provider: 'zai', ok: true });
  assert.ok(frames.find(frame => frame.event === 'native' && frame.eventData?.type === 'authStatus' && frame.eventData.state === 'done'), 'authStatus done reaches the host');

  // 3. Wire shape against the deterministic endpoints.
  assert.deepEqual(endpoints.requests.map(request => `${request.method} ${request.url}`), [
    'POST /api/v1/oauth/token',
    'POST /api/auth/z/login',
    'GET /api/biz/customer/getCustomerInfo',
    'GET /api/biz/v1/organization/org-1/projects/proj-1/api_keys',
    'POST /api/biz/v1/organization/org-1/projects/proj-1/api_keys',
    'GET /api/biz/v1/organization/org-1/projects/proj-1/api_keys/copy/created-key',
  ]);
  assert.deepEqual(endpoints.requests[0].body, { provider: 'zai', code: 'auth-code', redirect_uri: REDIRECT_URI, state });
  assert.deepEqual(endpoints.requests[4].body, { name: 'nozeli' });
  assert.equal(endpoints.requests[5].authorization, 'Bearer biz-token');

  // 4. Private Pi persistence: the durable key lands in auth.json as the
  //    provider credential (type oauth, access = id.secret).
  const stored = JSON.parse(await fs.readFile(path.join(agentDir, 'auth.json'), 'utf8'));
  assert.equal(stored.zai.type, 'oauth');
  assert.equal(stored.zai.access, 'created-key.real-secret');
  const after = await runtime.authList({ agentDir, cwd });
  const zaiAfter = after.credentials.find(row => row.provider === 'zai');
  assert.equal(zaiAfter.hasAuth, true);
  assert.equal(zaiAfter.type, 'oauth');

  // 5. The credential is operative in the model catalog, not only the GUI.
  const models = await runtime.modelsList({ agentDir, cwd, provider: 'zai' });
  assert.ok(models.models.length >= 5, 'native zai model definitions stay registered');
  assert.ok(models.models.every(model => model.authed === true), 'stored credential marks zai models available');

  // 6. No credential ever crosses back to the host.
  const frameText = JSON.stringify(frames);
  for (const secret of ['created-key.real-secret', 'real-secret', 'biz-token', 'oauth-access-token']) {
    assert.ok(!frameText.includes(secret), `host frames must not contain ${secret}`);
  }
});

test('worker protocol: cancellation aborts HTTP, settles the interaction and frees the single-flight slot', async t => {
  const endpoints = await localZaiEndpoints();
  const { runtime, waitFor, agentDir, cwd } = await workerFixture(t, endpoints);

  const first = runtime.authLogin({ provider: 'zai', agentDir, cwd });
  const consent = await waitFor(frame => frame.event === 'interaction' && frame.interaction.kind === 'input');
  // A second concurrent login is refused while the first is in flight.
  await assert.rejects(runtime.authLogin({ provider: 'zai', agentDir, cwd }), error => error.code === 'PI_BUSY');
  // Host cancel: rejects the pending prompt and aborts the transaction.
  const cancelled = runtime.cancel({});
  await assert.rejects(first, error => error.code === 'PI_INTERACTION_CANCELLED' || error.code === 'PI_ZAI_AUTH_CANCELLED');
  assert.deepEqual(await cancelled, { stopped: true, settings: true });
  assert.equal(endpoints.requests.length, 0, 'cancelled before any HTTP side effect');

  // The slot is free again: a fresh login completes against the same runtime,
  // and the compact code#state pasted form is accepted.
  const second = runtime.authLogin({ provider: 'zai', agentDir, cwd });
  const consent2 = await waitFor(frame => frame.event === 'interaction' && frame.interaction.kind === 'input' && frame.interaction.id !== consent.interaction.id);
  await runtime.respond({ id: consent2.interaction.id, answer: { text: '2' } });
  const urlFrame2 = await waitFor(frame => frame.event === 'interaction' && frame.interaction.kind === 'url');
  const state2 = new URL(urlFrame2.interaction.url).searchParams.get('state');
  const manual2 = await waitFor(frame => frame.event === 'interaction' && frame.interaction.kind === 'input' && frame.interaction.id !== consent.interaction.id && frame.interaction.id !== consent2.interaction.id);
  await runtime.respond({ id: manual2.interaction.id, answer: { text: `auth-code#${state2}` } });
  assert.deepEqual(await second, { provider: 'zai', ok: true });
  assert.ok(endpoints.requests.length > 0);
});

test('worker boundary: credential mutations for the logged-in provider are refused mid-login, others unaffected', async t => {
  const endpoints = await localZaiEndpoints();
  const { runtime, waitFor, agentDir, cwd } = await workerFixture(t, endpoints);

  const first = runtime.authLogin({ provider: 'zai', agentDir, cwd });
  const consent = await waitFor(frame => frame.event === 'interaction' && frame.interaction.kind === 'input');

  // Same provider: refused at the worker boundary before any credential write.
  await assert.rejects(
    runtime.authSetKey({ provider: 'zai', apiKey: 'TEST_ONLY_NOT_A_SECRET', agentDir, cwd }),
    error => error.code === 'PI_AUTH_IN_FLIGHT',
  );
  await assert.rejects(
    runtime.providerRemove({ provider: 'zai', agentDir, cwd }),
    error => error.code === 'PI_AUTH_IN_FLIGHT',
  );
  assert.equal(endpoints.requests.length, 0, 'no HTTP side effect during the refused writes');

  // An unrelated provider is not blocked by the login (no cross-provider lock).
  assert.deepEqual(
    await runtime.authSetKey({ provider: 'openai', apiKey: 'TEST_ONLY_NOT_A_SECRET', agentDir, cwd }),
    { provider: 'openai', type: 'api_key' },
  );

  // The login itself is untouched; cancelling settles it and frees the guards.
  const cancelled = runtime.cancel({});
  await assert.rejects(first, error => error.code === 'PI_INTERACTION_CANCELLED' || error.code === 'PI_ZAI_AUTH_CANCELLED');
  assert.deepEqual(await cancelled, { stopped: true, settings: true });
  const after = await runtime.authList({ agentDir, cwd });
  const zai = after.credentials.find(row => row.provider === 'zai');
  assert.equal(zai.hasAuth, false, 'the refused native-key write never landed');
});
