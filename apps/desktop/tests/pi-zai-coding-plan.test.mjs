// Z.AI (GLM Coding Plan · ZCode) sign-in regression — adapter + host surface.
//
// Deterministic and offline: the adapter (integrations/pi/src/zai-coding-plan.mjs)
// runs against a scripted fetch with the wire shapes recorded from OMP's
// test/zai-oauth.test.ts at the pinned snapshot .build/omp/build-IodhZv/source
// (MIT, (c) Stencil Labs / oh-my-pi contributors; see the module header for
// the ported-files list). The end-to-end worker-protocol coverage lives in
// tests/pi-zai-coding-plan-live.mjs (live suite; needs the built Pi runtime).
//
// No real OAuth is performed anywhere; real-account login stays explicitly
// unverified (see docs/pi-integration-execution.md).
// Run: node --test tests/pi-zai-coding-plan.test.mjs  (needs integrations/pi npm ci)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createZaiCodingPlanOAuth,
  parseZaiCallback,
  zaiAuthorizeUrl,
  zaiCodingPlanConfig,
  zaiProviderWithCodingPlan,
  nozeliZaiCodingPlanExtension,
} from '../../../integrations/pi/src/zai-coding-plan.mjs';
import { ProviderSettings, loginDisplay } from '../src/agents/managed/provider-settings.mjs';
import { EventEmitter } from 'node:events';

const REDIRECT_URI = 'zcode://zai-auth/callback';
const KEYS_URL = 'https://api.z.ai/api/biz/v1/organization/org-1/projects/proj-1/api_keys';

// ---- scripted wire (OMP test vectors) ----
const tokenEnvelope = data => ({ code: 0, msg: 'ok', data });
const bizEnvelope = data => ({ code: 200, msg: 'Operation successful', success: true, data });

function makeFetch(script) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const record = {
      url: String(url),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: init.headers?.Authorization ?? null,
    };
    requests.push(record);
    const handler = script[record.url];
    const reply = typeof handler === 'function' ? handler(record) : handler;
    if (!reply) throw new Error('unexpected fetch ' + record.url);
    // {__status, __body, __text} lets scenarios script non-200s and raw bodies.
    const status = Number.isInteger(reply.__status) ? reply.__status : 200;
    const body = Number.isInteger(reply.__status) ? (reply.__body ?? {}) : reply;
    const raw = typeof reply.__text === 'string' ? reply.__text : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => raw };
  };
  return { fetchImpl, requests };
}

const defaultScript = ({ existingKeys = [] } = {}) => ({
  'https://zcode.z.ai/api/v1/oauth/token': () =>
    tokenEnvelope({ token: 'zcode-jwt', zai: { access_token: 'oauth-access-token' }, user: { email: 'user@example.com', id: 'user-42' } }),
  'https://api.z.ai/api/auth/z/login': () => bizEnvelope({ access_token: 'biz-token', expires_in: 3600 }),
  'https://api.z.ai/api/biz/customer/getCustomerInfo': () =>
    bizEnvelope({ organizations: [{ organizationId: 'org-1', isDefault: true, projects: [{ projectId: 'proj-1', isDefault: true }] }] }),
  [KEYS_URL]: record =>
    record.method === 'GET'
      ? bizEnvelope(existingKeys)
      : bizEnvelope({ name: 'nozeli', apiKey: 'created-key', secretKey: 'inline-ignored' }),
  [`${KEYS_URL}/copy/created-key`]: () => bizEnvelope({ apiKey: 'created-key', secretKey: 'real-secret' }),
  [`${KEYS_URL}/copy/existing-key`]: () => bizEnvelope({ apiKey: 'existing-key', secretKey: 'real-secret' }),
});

/** Interaction double: records prompts/notifications; answers read live. */
function makeInteraction({ consent = 'consent', pasted = null, onPrompt } = {}) {
  const prompts = [];
  const events = [];
  const controller = new AbortController();
  const interaction = {
    signal: controller.signal,
    controller,
    prompts,
    events,
    pasted,
    async prompt(prompt) {
      prompts.push(prompt);
      if (onPrompt) await onPrompt(prompt);
      if (prompt.type === 'select') return consent;
      if (prompt.type === 'manual_code') {
        // Block like a real UI until the test supplies the pasted answer
        // (driveLogin sets it after reading the auth_url event), or until
        // the transaction aborts.
        await new Promise(resolve => {
          const tick = () => {
            if (interaction.pasted != null || interaction.signal.aborted) resolve();
            else setTimeout(tick, 2);
          };
          tick();
        });
        return interaction.pasted ?? '';
      }
      return '';
    },
    notify(event) { events.push(event); },
  };
  return interaction;
}

/** Runs a login to completion, feeding the state-bound pasted answer. */
async function driveLogin({ fetchImpl, interaction }) {
  // Observe the outcome immediately so an early rejection (e.g. cancellation
  // fired at the paste prompt) is never an unhandled rejection while this
  // helper waits for the auth_url event.
  const settled = createZaiCodingPlanOAuth({ fetchImpl }).login(interaction).then(
    value => ({ value }),
    caught => ({ caught }),
  );
  const urlEvent = await new Promise(resolve => {
    const check = () => {
      const found = interaction.events.find(event => event.type === 'auth_url');
      if (found) resolve(found); else setTimeout(check, 5);
    };
    check();
  });
  interaction.pasted = `auth-code#${new URL(urlEvent.url).searchParams.get('state')}`;
  const outcome = await settled;
  if (outcome.caught) throw outcome.caught;
  return outcome.value;
}

test('authorize URL matches the ZCode request: no PKCE, exact redirect and state', () => {
  const config = zaiCodingPlanConfig({});
  const url = new URL(zaiAuthorizeUrl(config, 'abc123'));
  assert.equal(url.origin + url.pathname, 'https://chat.z.ai/api/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'client_P8X5CMWmlaRO9gyO-KSqtg');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('state'), 'abc123');
  assert.equal(url.searchParams.get('code_challenge'), null);
  assert.equal(url.searchParams.get('code_challenge_method'), null);
  assert.equal(url.searchParams.get('scope'), null);
});

test('callback validation: exact scheme/host/path and state; bare codes rejected', () => {
  const state = 'a'.repeat(64);
  assert.deepEqual(parseZaiCallback(`${REDIRECT_URI}?code=auth-code&state=${state}`, state, REDIRECT_URI), { code: 'auth-code', state });
  assert.deepEqual(parseZaiCallback(`auth-code#${state}`, state, REDIRECT_URI), { code: 'auth-code', state });
  for (const bad of [
    'auth-code', // bare code: cannot prove callback binding
    `${REDIRECT_URI}?code=auth-code`, // missing state
    `${REDIRECT_URI}?code=auth-code&state=${'b'.repeat(64)}`, // state mismatch
    'zcode://other-host/callback?code=auth-code&state=' + state, // wrong host
    `zcode://zai-auth/other?code=auth-code&state=${state}`, // wrong path
    `https://chat.z.ai/api/oauth/authorize?code=auth-code&state=${state}`, // wrong scheme
    `#${state}`, // empty code
    '',
    'x'.repeat(9000),
  ]) {
    assert.throws(() => parseZaiCallback(bad, state, REDIRECT_URI), /Z\.AI sign-in failed during callback validation/, bad.slice(0, 40));
  }
});

test('login requires explicit consent before any network side effect', async () => {
  const { fetchImpl, requests } = makeFetch(defaultScript());
  for (const consent of ['cancel', '', 'yes-please', null]) {
    const interaction = makeInteraction({ consent, pasted: 'auth-code#state' });
    await assert.rejects(
      createZaiCodingPlanOAuth({ fetchImpl }).login(interaction),
      error => error.code === 'PI_ZAI_AUTH_CANCELLED',
    );
    assert.equal(interaction.events.filter(event => event.type === 'auth_url').length, 0, 'no browser URL before consent');
  }
  assert.equal(requests.length, 0, 'no HTTP before consent');
  // The consent prompt itself names the dedicated key and offers cancel.
  const interaction = makeInteraction({ consent: 'cancel' });
  await createZaiCodingPlanOAuth({ fetchImpl }).login(interaction).catch(() => {});
  const select = interaction.prompts.at(0);
  assert.equal(select.type, 'select');
  assert.match(select.message, /nozeli/);
  assert.equal(select.options[0].id, 'cancel', 'cancel is the default option, so empty input cancels');
  assert.ok(!select.options.some(option => option.id === 'browser'), 'never auto-answers pi browser-login');
});

test('pre-aborted signal cancels before prompting', async () => {
  const { fetchImpl, requests } = makeFetch(defaultScript());
  const interaction = makeInteraction({});
  interaction.controller.abort(new Error('stop'));
  await assert.rejects(createZaiCodingPlanOAuth({ fetchImpl }).login(interaction), error => error.code === 'PI_ZAI_AUTH_CANCELLED');
  assert.equal(interaction.prompts.length, 0);
  assert.equal(requests.length, 0);
});

test('happy path: exchange, business login, mint dedicated nozeli key via copy', async () => {
  const { fetchImpl, requests } = makeFetch(defaultScript());
  const interaction = makeInteraction({});
  const creds = await driveLogin({ fetchImpl, interaction });
  assert.equal(creds.type, 'oauth');
  assert.equal(creds.access, 'created-key.real-secret');
  assert.equal(creds.refresh, '');
  assert.equal(creds.expires, 8.64e15);
  assert.equal(creds.email, 'user@example.com');
  assert.equal(creds.accountId, 'user-42');
  const state = new URL(interaction.events.find(event => event.type === 'auth_url').url).searchParams.get('state');
  assert.deepEqual(
    requests.map(request => `${request.method} ${request.url}`),
    [
      'POST https://zcode.z.ai/api/v1/oauth/token',
      'POST https://api.z.ai/api/auth/z/login',
      'GET https://api.z.ai/api/biz/customer/getCustomerInfo',
      `GET ${KEYS_URL}`,
      `POST ${KEYS_URL}`,
      `GET ${KEYS_URL}/copy/created-key`,
    ],
  );
  assert.deepEqual(requests[0].body, { provider: 'zai', code: 'auth-code', redirect_uri: REDIRECT_URI, state });
  assert.deepEqual(requests[1].body, { token: 'oauth-access-token' });
  assert.deepEqual(requests[4].body, { name: 'nozeli' });
  for (const request of requests.slice(2)) assert.equal(request.authorization, 'Bearer biz-token');
  // The durable key becomes the request bearer; refresh is identity.
  const oauth = createZaiCodingPlanOAuth({ fetchImpl });
  assert.deepEqual(await oauth.toAuth(creds), { apiKey: 'created-key.real-secret' });
  assert.deepEqual(await oauth.refresh(creds), creds);
});

test('reuse: existing nozeli key is reused, masked list secret never trusted', async () => {
  const { fetchImpl, requests } = makeFetch(defaultScript({
    existingKeys: [
      { name: 'zcode-api-key', apiKey: 'zcode-key', secretKey: '*****aaaa' },
      { name: 'oh-my-pi', apiKey: 'omp-key', secretKey: '*****bbbb' },
      { name: 'nozeli', apiKey: 'existing-key', secretKey: '*****pz5Y' },
    ],
  }));
  const creds = await driveLogin({ fetchImpl, interaction: makeInteraction({}) });
  assert.equal(creds.access, 'existing-key.real-secret', 'secret must come from copy, not the masked list value');
  assert.ok(!requests.some(request => request.method === 'POST' && request.url === KEYS_URL), 'no create when a nozeli key exists');
  assert.equal(requests.at(-1).url, `${KEYS_URL}/copy/existing-key`);
});

test('default organization and project are resolved from the nested customer response', async () => {
  const script = defaultScript();
  script['https://api.z.ai/api/biz/customer/getCustomerInfo'] = () =>
    bizEnvelope({
      organizations: [
        { organizationId: 'org-other', isDefault: false, projects: [{ projectId: 'proj-x', isDefault: true }] },
        { organizationId: 'org-default', isDefault: true, projects: [{ projectId: 'proj-a', isDefault: false }, { projectId: 'proj-default', isDefault: true }] },
      ],
    });
  const { fetchImpl, requests } = makeFetch(script);
  const error = await driveLogin({ fetchImpl, interaction: makeInteraction({}) }).catch(caught => caught);
  assert.ok(error instanceof Error, 'the default-org keys URL is unrouted in the script, proving selection');
  assert.ok(
    requests.some(request => request.url.includes('/organization/org-default/projects/proj-default/api_keys')),
    'keys URL targets the isDefault org/project',
  );
});

test('failure envelopes and HTTP errors surface operation/status only, never bodies or secrets', async () => {
  const secrets = ['oauth-access-token', 'biz-token', 'real-secret', 'created-key', 'token rejected', 'Authorization Token illegal'];
  const runFailure = async mutate => {
    const script = defaultScript();
    mutate(script);
    const { fetchImpl } = makeFetch(script);
    const interaction = makeInteraction({});
    const error = await driveLogin({ fetchImpl, interaction }).catch(caught => caught);
    assert.ok(error instanceof Error);
    const visible = [
      error.message,
      ...interaction.events.map(event => `${event.message ?? ''} ${event.instructions ?? ''}`),
      ...interaction.prompts.map(prompt => `${prompt.message} ${prompt.placeholder ?? ''}`),
    ].join('\n');
    for (const secret of secrets) assert.ok(!visible.includes(secret), `leaked ${secret}`);
    return error;
  };

  const tokenRejected = await runFailure(script => {
    script['https://zcode.z.ai/api/v1/oauth/token'] = () => ({ code: 1, msg: 'token rejected' });
  });
  assert.equal(tokenRejected.code, 'PI_ZAI_AUTH_FAILED');
  assert.match(tokenRejected.message, /token exchange/);

  const businessRejected = await runFailure(script => {
    script['https://api.z.ai/api/auth/z/login'] = () => ({ code: 401, success: false, msg: 'Authorization Token illegal' });
  });
  assert.match(businessRejected.message, /business login/);

  const missingToken = await runFailure(script => {
    script['https://zcode.z.ai/api/v1/oauth/token'] = () => tokenEnvelope({ token: 'zcode-jwt', user: {} });
  });
  assert.match(missingToken.message, /missing access token/);

  const noAccount = await runFailure(script => {
    script['https://api.z.ai/api/biz/customer/getCustomerInfo'] = () => bizEnvelope({ organizations: [] });
  });
  assert.match(noAccount.message, /no organization or project/);
});

test('pasted callback with a mismatched state never reaches the token endpoint', async () => {
  const { fetchImpl, requests } = makeFetch(defaultScript());
  const interaction = makeInteraction({ pasted: `${REDIRECT_URI}?code=auth-code&state=${'f'.repeat(64)}` });
  const error = await createZaiCodingPlanOAuth({ fetchImpl }).login(interaction).catch(caught => caught);
  assert.equal(error.code, 'PI_ZAI_AUTH_FAILED');
  assert.match(error.message, /callback validation/);
  assert.equal(requests.length, 0);
});

test('cancellation during the exchange phase stops all HTTP and returns no credential', async () => {
  const { fetchImpl, requests } = makeFetch(defaultScript());
  const interaction = makeInteraction({
    onPrompt: prompt => {
      if (prompt.type === 'manual_code') interaction.controller.abort(new Error('user cancelled'));
    },
  });
  await assert.rejects(driveLogin({ fetchImpl, interaction }));
  assert.equal(requests.length, 0, 'aborted before the token exchange');
});

test('provider shape: native zai fields preserved, OAuth additive, extension registers natively', async () => {
  const provider = zaiProviderWithCodingPlan();
  const native = zaiProviderWithCodingPlan();
  assert.equal(provider.id, 'zai');
  assert.equal(provider.name, 'Z.AI');
  assert.equal(provider.baseUrl, 'https://api.z.ai/api/coding/paas/v4');
  assert.equal(provider.auth.apiKey.name, 'Z.AI API key');
  assert.equal(typeof provider.auth.apiKey.login, 'function');
  assert.equal(provider.auth.oauth.name, 'Z.AI (GLM Coding Plan · Sign in)');
  assert.equal(provider.auth.oauth.isSubscription, true);
  assert.deepEqual((await provider.getModels()).map(model => model.id), (await native.getModels()).map(model => model.id));
  let registered = null;
  nozeliZaiCodingPlanExtension().factory({ registerProvider: value => { registered = value; } });
  assert.equal(registered.id, 'zai');
  assert.ok(registered.auth.oauth);
  assert.equal(nozeliZaiCodingPlanExtension().name, 'nozeli-zai-coding-plan');
});

// ---- host surface for native provider API keys ----
function nativeKeyWorker() {
  const worker = {
    requests: [],
    credentials: [
      { provider: 'zai', name: 'Z.AI', type: 'none', hasAuth: false, oauthSupported: true, apiKeySetupSupported: true },
      { provider: 'openai', name: 'OpenAI', type: 'api_key', hasAuth: true, oauthSupported: true, apiKeySetupSupported: true },
      { provider: 'anthropic', name: 'Anthropic', type: 'oauth', hasAuth: true, oauthSupported: true, apiKeySetupSupported: false },
      { provider: 'custom-src', name: 'Custom', type: 'none', hasAuth: false, oauthSupported: false, apiKeySetupSupported: false },
    ],
    async request(method, params) {
      worker.requests.push({ method, params });
      if (method === 'authList') return { credentials: worker.credentials };
      if (method === 'authSetKey') {
        worker.credentials = worker.credentials.map(row => row.provider === params.provider ? { ...row, type: 'api_key', hasAuth: true } : row);
        return { provider: params.provider, type: 'api_key' };
      }
      throw Error('unexpected method ' + method);
    },
  };
  return worker;
}

test('host native-key surface lists worker-declared capabilities and never echoes the key', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-native-key-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worker = nativeKeyWorker();
  const settings = new ProviderSettings({ source: { root, agentDir: path.join(root, 'pi') }, worker });

  const providers = await settings.nativeKeyProviders();
  assert.deepEqual(providers.map(row => row.id), ['zai', 'openai'], 'only runtime-declared API-key-capable native providers');
  assert.equal(providers.find(row => row.id === 'zai').credential, 'none');
  assert.equal(providers.find(row => row.id === 'openai').configured, true);

  const saved = await settings.saveNativeKey({ provider: 'zai', key: 'TEST_ONLY_NOT_A_SECRET' });
  assert.deepEqual(saved, { saved: true, provider: 'zai', type: 'api_key' });
  assert.ok(!JSON.stringify(saved).includes('TEST_ONLY_NOT_A_SECRET'), 'reply never carries the key');
  assert.equal(worker.requests.at(-1).method, 'authSetKey');

  // A stored OAuth subscription is never silently clobbered by a key write.
  worker.credentials = worker.credentials.map(row => row.provider === 'zai' ? { ...row, type: 'oauth', hasAuth: true } : row);
  await assert.rejects(settings.saveNativeKey({ provider: 'zai', key: 'TEST_ONLY_NOT_A_SECRET' }), /订阅登录/);
  for (const invalid of [{ provider: 'no se' }, { provider: 'zai', key: '' }, { provider: 'zai', key: ' spaced ' }, { provider: 'zai' }, { extra: 1 }]) {
    await assert.rejects(async () => settings.saveNativeKey(invalid), /无效|API密钥/);
  }
});

test('endpoint configuration: pinned in production, loopback-only overrides under the explicit test gate', () => {
  const hostile = {
    ZAI_OAUTH_CLIENT_ID: 'attacker-client',
    ZAI_OAUTH_AUTHORIZE_URL: 'https://evil.example.test/authorize',
    ZAI_OAUTH_TOKEN_URL: 'https://evil.example.test/token',
    ZAI_BIZ_BASE: 'https://evil.example.test',
    ZAI_BUSINESS_LOGIN_URL: 'https://evil.example.test/login',
    ZAI_OAUTH_REDIRECT_URI: 'https://evil.example.test/callback',
  };
  // Production: ambient overrides are ignored outright, everything stays pinned.
  const pinned = zaiCodingPlanConfig(hostile);
  assert.equal(pinned.clientId, 'client_P8X5CMWmlaRO9gyO-KSqtg');
  assert.equal(pinned.authorizeUrl, 'https://chat.z.ai/api/oauth/authorize');
  assert.equal(pinned.tokenUrl, 'https://zcode.z.ai/api/v1/oauth/token');
  assert.equal(pinned.bizBase, 'https://api.z.ai');
  assert.equal(pinned.businessLoginUrl, 'https://api.z.ai/api/auth/z/login');
  assert.equal(pinned.redirectUri, REDIRECT_URI);
  // Test instance: loopback http(s) endpoints are honored (plus client id).
  const gated = zaiCodingPlanConfig({
    ...hostile,
    NOZELI_TEST_INSTANCE: '1',
    ZAI_OAUTH_AUTHORIZE_URL: 'http://127.0.0.1:9/api/oauth/authorize',
    ZAI_OAUTH_TOKEN_URL: 'http://127.0.0.1:9/api/v1/oauth/token',
    ZAI_BIZ_BASE: 'http://localhost:9',
    ZAI_BUSINESS_LOGIN_URL: 'http://127.0.0.1:9/api/auth/z/login',
    ZAI_OAUTH_REDIRECT_URI: 'zcode://zai-auth/callback',
  });
  assert.equal(gated.authorizeUrl, 'http://127.0.0.1:9/api/oauth/authorize');
  assert.equal(gated.tokenUrl, 'http://127.0.0.1:9/api/v1/oauth/token');
  assert.equal(gated.bizBase, 'http://localhost:9');
  assert.equal(gated.businessLoginUrl, 'http://127.0.0.1:9/api/auth/z/login');
  assert.equal(gated.clientId, 'attacker-client', 'client id override is test-gated too');
  // Gated non-loopback, credentialed loopback and non-zcode redirects fail loudly.
  assert.throws(() => zaiCodingPlanConfig({ NOZELI_TEST_INSTANCE: '1', ZAI_OAUTH_TOKEN_URL: 'https://evil.example.test/token' }), /loopback/);
  assert.throws(() => zaiCodingPlanConfig({ NOZELI_TEST_INSTANCE: '1', ZAI_BIZ_BASE: 'http://user:pass@127.0.0.1:9' }), /loopback/);
  assert.throws(() => zaiCodingPlanConfig({ NOZELI_TEST_INSTANCE: '1', ZAI_OAUTH_REDIRECT_URI: 'https://evil.example.test/cb' }), /zcode/);
});

test('HTTP hardening: every request forbids redirects, response bytes are capped, failures sanitized', async () => {
  const redirects = [];
  const base = makeFetch(defaultScript());
  const recording = async (url, init = {}) => {
    redirects.push(init.redirect);
    return base.fetchImpl(url, init);
  };
  await driveLogin({ fetchImpl: recording, interaction: makeInteraction({}) });
  assert.ok(redirects.length >= 6 && redirects.every(value => value === 'error'), 'every request must send redirect:error');

  const redirected = defaultScript();
  redirected['https://zcode.z.ai/api/v1/oauth/token'] = () => ({ __status: 302, __body: { code: 0, data: {} } });
  const error302 = await driveLogin({ fetchImpl: makeFetch(redirected).fetchImpl, interaction: makeInteraction({}) }).catch(caught => caught);
  assert.equal(error302.code, 'PI_ZAI_AUTH_FAILED');
  assert.match(error302.message, /HTTP 302/);

  const oversized = defaultScript();
  oversized['https://zcode.z.ai/api/v1/oauth/token'] = () => ({ __text: 'y'.repeat(1024 * 1024 + 1) });
  const errorBig = await driveLogin({ fetchImpl: makeFetch(oversized).fetchImpl, interaction: makeInteraction({}) }).catch(caught => caught);
  assert.equal(errorBig.code, 'PI_ZAI_AUTH_FAILED');
  assert.match(errorBig.message, /oversized response/);
});

// ---- host login/mutation race and consent projection ----
function loginWorker() {
  const worker = { events: new EventEmitter(), requests: [], credentials: [] };
  worker.acquire = async () => ({});
  worker.stop = async () => ({ exited: true });
  worker.request = async (method, params = {}) => {
    worker.requests.push({ method, params });
    if (method === 'authList') return { credentials: worker.credentials };
    if (method === 'providerList') return { providers: [] };
    if (method === 'models') return { models: [] };
    if (method === 'authLogin') return new Promise(() => {}); // login stays running
    if (method === 'cancel') return { stopped: true, settings: true };
    if (method === 'respond') return { sent: true };
    if (method === 'authSetKey') {
      worker.credentials = [{ provider: params.provider, type: 'api_key', hasAuth: true }];
      return { provider: params.provider, type: 'api_key' };
    }
    throw Error('unexpected method ' + method);
  };
  return worker;
}

async function loginFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-zai-login-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const worker = loginWorker();
  const settings = new ProviderSettings({ source: { root, agentDir: path.join(root, 'pi') }, worker });
  return { worker, settings };
}

test('host race guard: credential mutations for a provider with an active login are refused before any worker write', async t => {
  const { worker, settings } = await loginFixture(t);
  const started = await settings.startLogin({ provider: 'zai' });
  assert.equal(started.state, 'running');

  await assert.rejects(settings.saveNativeKey({ provider: 'zai', key: 'TEST_ONLY_NOT_A_SECRET' }), /登录/);
  await assert.rejects(settings.saveApi({
    operation: 'create', provider: 'zai', baseUrl: 'https://api.example.test/v1', api: 'openai-completions',
    models: [{ id: 'm' }], credential: { action: 'replace', value: 'TEST_ONLY_NOT_A_SECRET' },
  }), /登录/);
  await assert.rejects(settings.remove({ provider: 'zai', confirm: 'zai' }), /登录/);
  assert.ok(!worker.requests.some(request => request.method === 'authSetKey' || request.method === 'providerUpsert' || request.method === 'providerRemove'),
    'no credential-affecting worker call may leave the host while the login runs');

  await settings.cancelLogin({ id: started.id });
  // Once the login settles and an OAuth credential exists, the stored type —
  // not a stale pre-login read — decides: still no silent clobber.
  worker.credentials = [{ provider: 'zai', type: 'oauth', hasAuth: true }];
  await assert.rejects(settings.saveNativeKey({ provider: 'zai', key: 'TEST_ONLY_NOT_A_SECRET' }), /订阅登录/);
});

test('host consent projection: trusted consent select is shown with explicit numbering; foreign select text never rendered', async t => {
  const { settings } = await loginFixture(t);
  const started = await settings.startLogin({ provider: 'zai' });
  worker_events: {
    const worker = settings.worker;
    worker.events.emit('interaction', {
      id: 'w-1', provider: 'zai', kind: 'select',
      message: '请确认 Z.AI（GLM Coding Plan）登录：Nozeli 将创建/复用专用密钥 “nozeli”。',
      options: [{ id: 'cancel', label: '取消登录（默认）' }, { id: 'consent', label: '同意并继续' }],
    });
    const shown = settings.loginStatus().output;
    assert.match(shown, /请确认/);
    assert.match(shown, /nozeli/);
    assert.match(shown, /1\. 取消登录（默认）/);
    assert.match(shown, /2\. 同意并继续/);
    assert.ok(loginDisplay(shown).includes('请确认'), 'consent line survives output filtering');
    // Bridge-shaped input consent (the real wire shape) projects as well.
    worker.events.emit('interaction', { id: 'w-2', provider: 'zai', kind: 'input', message: '请确认 Z.AI 登录：创建/复用 nozeli 专用密钥\n1. 取消\n2. 同意' });
    assert.ok(settings.loginStatus().output.includes('请确认'));
    // Arbitrary provider-controlled select text is never rendered.
    worker.events.emit('interaction', { id: 'w-3', provider: 'zai', kind: 'select', message: 'secret provider narrative', options: [{ id: 'a', label: 'A' }] });
    const after = settings.loginStatus().output;
    assert.ok(!after.includes('secret provider narrative'));
    assert.match(after, /1\. A/);
  }
  await settings.cancelLogin({ id: started.id });
});
