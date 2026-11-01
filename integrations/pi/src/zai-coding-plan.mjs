/**
 * Nozeli-authored. Z.AI (GLM Coding Plan · ZCode "Individual Plan") browser
 * sign-in for the native Pi `zai` provider, registered as an additive OAuth
 * method next to the untouched native API-key auth.
 *
 * Protocol ported (2026-10-31) from the reviewed OMP snapshot pinned at
 * .build/omp/build-IodhZv/source (upstream repository
 * https://github.com/can1357/oh-my-pi, package @oh-my-pi/pi-ai, MIT license,
 * (c) Stencil Labs, Inc. and oh-my-pi contributors):
 *   - packages/ai/src/registry/oauth/zai.ts  (business login + key minting)
 *   - packages/catalog/src/compat/rules/auth/zai-coding-plan.kdl (client id,
 *     endpoints, zcode:// redirect, non-RFC JSON token body, credential paths)
 *   - packages/ai/test/zai-oauth.test.ts  (observed wire expectations)
 * Nozeli changes versus upstream, kept deliberately:
 *   - No OMP/Bun runtime and no native-scheme receiver: Nozeli NEVER registers
 *     or takes over the installed ZCode `zcode://` handler. The user pastes the
 *     final redirect URL (or `code#state`); a bare code is rejected because it
 *     cannot prove state binding.
 *   - Explicit affirmative consent before any network side effect; empty or
 *     unknown input cancels (the cancel option is the select default).
 *   - The minted key is dedicated to Nozeli under the name `nozeli`; existing
 *     `zcode-api-key` / `oh-my-pi` keys are only ever read while scanning for
 *     Nozeli's own entry, never mutated or reused.
 *   - Status-only errors: no response bodies, URLs, tokens or pasted callbacks
 *     are surfaced anywhere.
 *   - Cancellation is checked before every side-effecting step and before
 *     returning credentials; every HTTP call is bounded (timeout + signal,
 *     no redirects, capped response bytes).
 *   - Endpoints are pinned constants: ambient environment overrides are
 *     IGNORED in production. Overrides are honored only inside an explicit
 *     test instance (NOZELI_TEST_INSTANCE) and only for loopback http(s)
 *     endpoints (zcode: redirect stays scheme-checked), so inherited env can
 *     never re-point credential traffic elsewhere.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";

/** Matches OMP's NEVER_EXPIRES for durable, non-refreshable keys. */
const NEVER_EXPIRES = 8.64e15;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PASTED_INPUT_LIMIT = 8192;
/** Dedicated Z.ai API key name; never ZCode's `zcode-api-key` or OMP's `oh-my-pi`. */
const NOZELI_KEY_NAME = "nozeli";
/** Select-option ids must never equal pi's auto-answered browser-login id. */
const CONSENT_CANCEL_ID = "cancel";
const CONSENT_AGREE_ID = "consent";

const CONSENT_MESSAGE =
  "请确认 Z.AI（GLM Coding Plan）登录：Nozeli 将在浏览器完成授权，并创建/复用专用 API 密钥 “nozeli”（不改 ZCode 自身密钥，不接管 zcode:// 回调）。留空即取消。";

function envText(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

const PINNED = {
  clientId: "client_P8X5CMWmlaRO9gyO-KSqtg",
  authorizeUrl: "https://chat.z.ai/api/oauth/authorize",
  tokenUrl: "https://zcode.z.ai/api/v1/oauth/token",
  redirectUri: "zcode://zai-auth/callback",
  bizBase: "https://api.z.ai",
  businessLoginUrl: "https://api.z.ai/api/auth/z/login",
};

/** Explicit local-verification gate; the desktop env scrubber keeps it intact. */
const TEST_INSTANCE_ENV = "NOZELI_TEST_INSTANCE";

function isTestInstance(env) {
  return envText(env, TEST_INSTANCE_ENV) !== undefined;
}

/** Loopback http(s) URL without credentials — the only overridable endpoints. */
function isLoopbackHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Endpoint configuration. Production pins every endpoint: ambient environment
 * values are ignored outright. Overrides are honored only inside an explicit
 * test instance (NOZELI_TEST_INSTANCE) and only as loopback http(s) endpoints
 * (the redirect stays `zcode:`), so inherited env can never re-point
 * credential traffic at another host; a gated non-loopback override fails
 * loudly instead of silently falling back.
 */
export function zaiCodingPlanConfig(env = process.env) {
  const gated = isTestInstance(env);
  const endpoint = (name, pinned) => {
    const value = envText(env, name);
    if (value === undefined) return pinned;
    if (!gated) return pinned;
    if (!isLoopbackHttpUrl(value)) {
      throw new ZaiAuthError("test endpoint configuration", `${name} must be a loopback http(s) URL`);
    }
    return value;
  };
  const clientId = envText(env, "ZAI_OAUTH_CLIENT_ID");
  const redirectUri = envText(env, "ZAI_OAUTH_REDIRECT_URI");
  if (redirectUri !== undefined) {
    if (!gated || typeof redirectUri !== "string" || !redirectUri.startsWith("zcode:")) {
      // Never a production seam: only the official scheme, only in tests.
      if (!gated) return pinnedConfig();
      throw new ZaiAuthError("test endpoint configuration", "ZAI_OAUTH_REDIRECT_URI must keep the zcode: scheme");
    }
  }
  return {
    clientId: gated && clientId !== undefined ? clientId : PINNED.clientId,
    authorizeUrl: endpoint("ZAI_OAUTH_AUTHORIZE_URL", PINNED.authorizeUrl),
    tokenUrl: endpoint("ZAI_OAUTH_TOKEN_URL", PINNED.tokenUrl),
    redirectUri: redirectUri ?? PINNED.redirectUri,
    bizBase: endpoint("ZAI_BIZ_BASE", PINNED.bizBase).replace(/\/+$/, ""),
    businessLoginUrl: endpoint("ZAI_BUSINESS_LOGIN_URL", PINNED.businessLoginUrl),
    keyName: NOZELI_KEY_NAME,
  };
}

function pinnedConfig() {
  return { ...PINNED, bizBase: PINNED.bizBase.replace(/\/+$/, ""), keyName: NOZELI_KEY_NAME };
}

/** Operation- and status-only failure; never carries bodies, URLs or secrets. */
class ZaiAuthError extends Error {
  constructor(operation, detail = "") {
    super(`Z.AI sign-in failed during ${operation}${detail ? ` (${detail})` : ""}.`, {
      cause: undefined,
    });
    this.code = "PI_ZAI_AUTH_FAILED";
    this.operation = operation;
  }
}

class ZaiAuthCancelledError extends Error {
  constructor(stage = "login") {
    super(`Z.AI sign-in cancelled before ${stage} completed.`);
    this.code = "PI_ZAI_AUTH_CANCELLED";
  }
}

function throwIfCancelled(signal, stage) {
  if (signal?.aborted) {
    throw new ZaiAuthCancelledError(stage);
  }
}

function trimmedString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Z.ai's `{code, msg, data, success}` envelope: the token endpoint signals
 * success with code 0, the biz endpoints with 200 / success:true. Returns the
 * unwrapped data, or null when the envelope reports failure. `msg` is never
 * propagated out of this module.
 */
function unwrapEnvelope(body) {
  if (!body || typeof body !== "object") {
    return null;
  }
  const envelope = body;
  if ("code" in envelope || "success" in envelope) {
    const code = envelope.code;
    const ok =
      envelope.success === false
        ? false
        : code == null
          ? envelope.success !== false
          : typeof code === "number"
            ? code === 0 || code === 200
            : typeof code === "string"
              ? code === "0" || code === "200"
              : false;
    if (!ok) {
      return null;
    }
    return "data" in envelope ? envelope.data : envelope;
  }
  return body;
}

function asKeyArray(value) {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry && typeof entry === "object");
  }
  if (value && typeof value === "object") {
    for (const field of ["list", "keys", "apiKeys", "records"]) {
      if (Array.isArray(value[field])) {
        return value[field].filter((entry) => entry && typeof entry === "object");
      }
    }
  }
  return [];
}

/** Constant-time comparison for same-length hex strings. */
function statesMatch(expected, provided) {
  if (typeof provided !== "string" || provided.length !== expected.length) {
    return false;
  }
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(provided, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Validate the pasted authorization result against this transaction.
 *
 * Accepted forms (mirroring the OMP rule's manual path):
 *  - the full official callback `zcode://zai-auth/callback?code=…&state=…`
 *    (scheme, host and path must match the configured redirect exactly), or
 *  - compact `code#state`.
 * A bare code without state is rejected: it cannot prove callback binding.
 * The pasted text itself is never echoed or logged.
 */
export function parseZaiCallback(pasted, expectedState, redirectUri) {
  const raw = typeof pasted === "string" ? pasted.trim() : "";
  if (!raw || raw.length > PASTED_INPUT_LIMIT) {
    throw new ZaiAuthError("callback validation", "empty or oversized input");
  }
  let expectedHost = "zai-auth";
  let expectedPath = "/callback";
  try {
    const parsed = new URL(redirectUri);
    expectedHost = parsed.host;
    expectedPath = parsed.pathname.replace(/\/+$/, "") || "/";
  } catch {
    // Non-URL redirect configuration: only the code#state form can be checked.
  }
  if (raw.includes("://")) {
    let callback;
    try {
      callback = new URL(raw);
    } catch {
      throw new ZaiAuthError("callback validation", "unparseable redirect");
    }
    const path = callback.pathname.replace(/\/+$/, "") || "/";
    if (
      callback.protocol !== "zcode:" ||
      callback.host !== expectedHost ||
      path !== expectedPath.replace(/\/+$/, "")
    ) {
      throw new ZaiAuthError("callback validation", "unexpected redirect target");
    }
    const code = callback.searchParams.get("code");
    const state = callback.searchParams.get("state");
    if (!code || !state) {
      throw new ZaiAuthError("callback validation", "missing code or state");
    }
    if (!statesMatch(expectedState, state)) {
      throw new ZaiAuthError("callback validation", "state mismatch");
    }
    return { code, state };
  }
  const separator = raw.indexOf("#");
  if (separator <= 0) {
    throw new ZaiAuthError("callback validation", "a bare code cannot be verified; paste the redirect URL or code#state");
  }
  const code = raw.slice(0, separator).trim();
  const state = raw.slice(separator + 1).trim();
  if (!code || !state || !statesMatch(expectedState, state)) {
    throw new ZaiAuthError("callback validation", "state mismatch");
  }
  return { code, state };
}

/** Build the ZCode-matching authorize URL (no PKCE). */
export function zaiAuthorizeUrl(config, state) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    state,
  });
  return `${config.authorizeUrl}?${params.toString()}`;
}

/**
 * Create the pi-ai `OAuthAuth` for the ZCode browser flow.
 * `fetchImpl` (default: global fetch) and `env` are injectable for
 * deterministic local verification; production passes neither, so endpoints
 * stay pinned and env overrides stay test-gated (see zaiCodingPlanConfig).
 */
export function createZaiCodingPlanOAuth({ env = process.env, fetchImpl = fetch } = {}) {
  /** Bounded response read: never trust an unbounded body, even on 200. */
  async function readBounded(response, operation) {
    if (typeof response.body?.getReader === "function") {
      const reader = response.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new ZaiAuthError(operation, "oversized response");
        }
        chunks.push(value);
      }
      const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    }
    // Test doubles without a stream body.
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new ZaiAuthError(operation, "oversized response");
    }
    return text;
  }

  async function request(url, { method = "GET", body, authorization, signal, operation } = {}) {
    const response = await fetchImpl(url, {
      method,
      // Credential-bearing POSTs must never follow a redirect.
      redirect: "error",
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
      throw new ZaiAuthError(operation, `HTTP ${response.status}`);
    }
    const text = await readBounded(response, operation);
    if (!text) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ZaiAuthError(operation, "unparseable response");
    }
  }

  /** Exchange the short-lived OAuth access token for a durable biz token. */
  async function businessLogin(oauthAccessToken, config, signal) {
    const data = unwrapEnvelope(
      await request(config.businessLoginUrl, {
        method: "POST",
        body: { token: oauthAccessToken },
        signal,
        operation: "business login",
      }),
    );
    const bizToken = trimmedString(data?.access_token) ?? trimmedString(data?.accessToken);
    if (!bizToken) {
      throw new ZaiAuthError("business login", "missing token");
    }
    return bizToken;
  }

  /**
   * Provision the durable `id.secret` key: business login, default
   * organization/project resolution, find-or-create the Nozeli-named key,
   * then always fetch the full secret via the copy endpoint (list entries
   * mask it and the create response's inline secret is not authoritative).
   */
  async function mintNozeliKey(oauthAccessToken, config, signal) {
    const bizToken = await businessLogin(oauthAccessToken, config, signal);
    throwIfCancelled(signal, "key provisioning");
    const authorization = `Bearer ${bizToken}`;

    const customer = unwrapEnvelope(
      await request(`${config.bizBase}/api/biz/customer/getCustomerInfo`, {
        authorization,
        signal,
        operation: "account lookup",
      }),
    );
    const organizations = Array.isArray(customer?.organizations) ? customer.organizations : [];
    const organization = organizations.find((entry) => entry?.isDefault) ?? organizations[0];
    const projects = Array.isArray(organization?.projects) ? organization.projects : [];
    const project = projects.find((entry) => entry?.isDefault) ?? projects[0];
    const organizationId = trimmedString(organization?.organizationId);
    const projectId = trimmedString(project?.projectId);
    if (!organizationId || !projectId) {
      throw new ZaiAuthError("key provisioning", "no organization or project on account");
    }
    throwIfCancelled(signal, "key provisioning");

    const keysUrl = `${config.bizBase}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
    const existing = asKeyArray(
      unwrapEnvelope(
        await request(keysUrl, { authorization, signal, operation: "API key listing" }),
      ),
    ).find((key) => key.name === config.keyName);
    throwIfCancelled(signal, "key provisioning");

    const keyRecord = existing
      ? existing
      : unwrapEnvelope(
          await request(keysUrl, {
            method: "POST",
            body: { name: config.keyName },
            authorization,
            signal,
            operation: "API key creation",
          }),
        );
    const apiKey = trimmedString(keyRecord?.apiKey);
    if (!apiKey) {
      throw new ZaiAuthError("key provisioning", "missing key id");
    }
    throwIfCancelled(signal, "key provisioning");

    // Always copy: list entries mask the secret and the create response's
    // inline secret is unreliable across account states.
    const copied = unwrapEnvelope(
      await request(`${keysUrl}/copy/${encodeURIComponent(apiKey)}`, {
        authorization,
        signal,
        operation: "API key secret retrieval",
      }),
    );
    const secretKey = trimmedString(copied?.secretKey);
    if (!secretKey) {
      throw new ZaiAuthError("key provisioning", "missing key secret");
    }
    return `${apiKey}.${secretKey}`;
  }

  return {
    name: "Z.AI (GLM Coding Plan · Sign in)",
    isSubscription: true,
    loginLabel: "Sign in with Z.AI (GLM Coding Plan)",
    async login(interaction) {
      const signal = interaction?.signal;
      throwIfCancelled(signal, "consent");

      await interaction.notify({
        type: "info",
        message:
          "Z.AI (GLM Coding Plan) sign-in: continue in your browser, then paste the final redirect here. Nozeli creates or reuses only its dedicated 'nozeli' API key and never takes over the zcode:// handler.",
      });

      const consent = await interaction.prompt({
        type: "select",
        message: CONSENT_MESSAGE,
        options: [
          { id: CONSENT_CANCEL_ID, label: "取消登录（默认）" },
          {
            id: CONSENT_AGREE_ID,
            label: "同意并继续：浏览器授权＋管理 nozeli 专用密钥",
          },
        ],
      });
      if (consent !== CONSENT_AGREE_ID) {
        throw new ZaiAuthCancelledError("consent");
      }

      const config = zaiCodingPlanConfig(env);
      const state = randomBytes(32).toString("hex");
      const url = zaiAuthorizeUrl(config, state);
      throwIfCancelled(signal, "authorization");
      await interaction.notify({
        type: "auth_url",
        url,
        instructions:
          "Open the URL in your browser, finish Z.AI sign-in, then paste the final zcode:// redirect URL or code#state. Nozeli does not capture the zcode:// callback itself.",
      });

      const pasted = await interaction.prompt({
        type: "manual_code",
        message: "Paste the authorization redirect URL or code#state",
        placeholder: "zcode://zai-auth/callback?code=…&state=…（或 code#state）",
      });
      throwIfCancelled(signal, "token exchange");
      const { code, state: exchangeState } = parseZaiCallback(pasted, state, config.redirectUri);

      const tokenData = unwrapEnvelope(
        await request(config.tokenUrl, {
          method: "POST",
          body: {
            provider: "zai",
            code,
            redirect_uri: config.redirectUri,
            state: exchangeState,
          },
          signal,
          operation: "token exchange",
        }),
      );
      const oauthAccess =
        trimmedString(tokenData?.zai?.access_token) ?? trimmedString(tokenData?.zai?.accessToken);
      if (!oauthAccess) {
        throw new ZaiAuthError("token exchange", "missing access token");
      }
      const email = trimmedString(tokenData?.user?.email);
      const accountId = trimmedString(tokenData?.user?.id);

      const access = await mintNozeliKey(oauthAccess, config, signal);
      throwIfCancelled(signal, "credential return");
      return {
        type: "oauth",
        access,
        refresh: "",
        expires: NEVER_EXPIRES,
        ...(email ? { email } : {}),
        ...(accountId ? { accountId } : {}),
      };
    },
    /** The durable key does not expire or rotate; refresh is identity. */
    async refresh(credential) {
      return credential;
    },
    async toAuth(credential) {
      return { apiKey: typeof credential?.access === "string" ? credential.access : "" };
    },
  };
}

/**
 * The native Pi `zai` provider with the ZCode OAuth flow added additively:
 * every native field (models, transport, baseUrl, API-key auth) is preserved
 * verbatim; only `auth.oauth` is added.
 */
export function zaiProviderWithCodingPlan(options = {}) {
  const base = zaiProvider();
  return {
    ...base,
    auth: {
      ...base.auth,
      oauth: createZaiCodingPlanOAuth(options),
    },
  };
}

/**
 * pi-gui builtin extension registering the augmented native provider. Passed
 * as `builtinExtensions` so EVERY model runtime (settings snapshots and live
 * agent sessions) registers it through pi's own `registerProvider(Provider)`
 * native path — the stored credential therefore resolves for real requests,
 * not only for the settings UI.
 */
export function nozeliZaiCodingPlanExtension(options = {}) {
  return {
    name: "nozeli-zai-coding-plan",
    displayName: "Z.AI GLM Coding Plan 登录（Nozeli）",
    description:
      "Adds ZCode browser sign-in with a dedicated 'nozeli' API key to the native Pi Z.AI provider. Keeps native API-key setup; never registers or takes over the zcode:// callback handler.",
    factory: (pi) => {
      pi.registerProvider(zaiProviderWithCodingPlan(options));
    },
  };
}
