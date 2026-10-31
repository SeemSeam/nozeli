/**
 * Nozeli-authored. Owner runtime bridge: adapts the vendored pi-gui
 * PiSdkDriver/SessionSupervisor (the real session owner) to the worker's
 * JSONL IPC contract.
 *
 * Reused upstream core (vendor/pi-gui @ eddfb19367b3ec4e59314eddfa83ed5aa6989f03
 * + patches/0001, patches/0002):
 *  - SessionSupervisor: session create/open, single-writer leases, persistence,
 *    busy refusal, cancel, model/thinking changes, reload, close.
 *  - RuntimeSupervisor: provider settings (custom providers, API keys, login).
 *  - catalogs/session-driver: storage + driver contracts (memory storage here).
 * Deliberately NOT exercised by this worker (authority stays with the host):
 *  - message queueing (no `deliverAs` is ever sent; busy → PI_BUSY),
 *  - durable catalogs (in-process memory storage only),
 *  - thread-title generation, desktop extensions, MCP config surface,
 *  - any process spawning (the worker IS the process).
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createMemoryCatalogStorage, seedResumeSession } from "./catalog-memory.mjs";
import { createFactChannel } from "./facts.mjs";
import { createNativeQuestionBridge } from './questions.mjs';
import {
  createHostToolBridge,
  createInteractionBridge,
  normalizeHostTools,
} from "./tools.mjs";

const VENDOR_DRIVER_ENTRY = fileURLToPath(
  new URL("../dist/vendor/pi-gui/packages/pi-sdk-driver/index.js", import.meta.url),
);

// Native SDK thinking vocabulary (pi-ai THINKING_LEVEL_OPTIONS order). Used
// only for input syntax validation; per-model support and clamping stay with
// the native session (getAvailableThinkingLevels / clampThinkingLevel).
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

// Service model-list discovery bounds. Explicit user action only; bounded
// size/time/pages; redirects are rejected so credentials never leave the
// configured origin; listing never proves inference entitlement.
const DISCOVERY_TIMEOUT_MS = 15000;
const DISCOVERY_MAX_BYTES = 2 * 1024 * 1024;
const DISCOVERY_MAX_PAGES = 10;
const DISCOVERY_MAX_MODELS = 1000;

let vendorCache = null;

async function loadVendor() {
  if (vendorCache) {
    return vendorCache;
  }
  if (!existsSync(VENDOR_DRIVER_ENTRY)) {
    throw Object.assign(
      new Error(
        `Vendored pi-gui driver is not built at ${VENDOR_DRIVER_ENTRY}. Run: node integrations/pi/prepare-runtime.mjs`,
      ),
      { code: "PI_RUNTIME_NOT_PREPARED" },
    );
  }
  const driverModule = await import(pathToFileURL(VENDOR_DRIVER_ENTRY).href);
  const pi = await import("@earendil-works/pi-coding-agent");
  vendorCache = {
    createPiSdkDriver: driverModule.createPiSdkDriver,
    createAgentSessionRuntimeWithNpmFallback:
      driverModule.createAgentSessionRuntimeWithNpmFallback,
    SessionManager: pi.SessionManager,
  };
  return vendorCache;
}

export function parseModelSelector(selector) {
  if (selector == null) {
    return null;
  }
  if (typeof selector === "string") {
    const trimmed = selector.trim();
    if (!trimmed) {
      return null;
    }
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) {
      throw Object.assign(
        new Error(`model selector must be "provider/modelId": ${JSON.stringify(selector)}`),
        { code: "PI_INVALID_PARAMS" },
      );
    }
    return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
  }
  if (typeof selector === "object") {
    const modelId = selector.modelId ?? selector.id ?? selector.model;
    if (!selector.provider || !modelId) {
      throw Object.assign(
        new Error("model selector object requires provider and modelId"),
        { code: "PI_INVALID_PARAMS" },
      );
    }
    return {
      provider: selector.provider,
      modelId,
      ...(selector.baseUrl ? { baseUrl: selector.baseUrl } : {}),
      ...(selector.apiKey ? { apiKey: selector.apiKey } : {}),
      ...(selector.api ? { api: selector.api } : {}),
      ...(selector.contextWindow ? { contextWindow: selector.contextWindow } : {}),
      ...(selector.effort ? { effort: selector.effort } : {}),
    };
  }
  throw Object.assign(new Error("invalid model selector"), { code: "PI_INVALID_PARAMS" });
}

function workspaceIdFor(cwd) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

function workspaceRefFor(cwd) {
  return {
    workspaceId: workspaceIdFor(cwd),
    path: cwd,
    displayName: path.basename(cwd) || cwd,
  };
}

function mapError(error, fallbackCode = "PI_INTERNAL") {
  if (error?.code?.startsWith("PI_")) {
    return error;
  }
  const message = error?.message ?? String(error);
  if (/already streaming/.test(message)) {
    return Object.assign(new Error(message), { code: "PI_BUSY" });
  }
  if (/is held by/.test(message)) {
    return Object.assign(new Error(message), { code: "PI_SESSION_LEASED" });
  }
  if (/Unknown model/.test(message)) {
    return Object.assign(new Error(message), { code: "PI_NO_MODEL" });
  }
  if (/conflicts with a built-in provider/.test(message)) {
    return Object.assign(new Error(message), { code: "PI_PROVIDER_CONFLICT" });
  }
  if (/API key setup is not supported/.test(message)) {
    return Object.assign(new Error(message), { code: "PI_AUTH_UNSUPPORTED" });
  }
  return Object.assign(new Error(message), { code: error?.code ?? fallbackCode });
}

function safeOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

async function readBounded(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error("discovery response exceeded size bound"), {
        code: "DISCOVERY_TOO_LARGE",
      });
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function discoveryFailure(code, origin, fetchedAt, protocol) {
  // Sanitized DTO: no response bodies, headers, URLs or credentials echoed.
  return {
    status: "failed",
    protocol,
    fetchedAt,
    models: [],
    entitlement: "unknown",
    error: { code, message: "model listing request failed at the configured endpoint" },
    ...(origin ? { origin } : {}),
  };
}

// Paginated service model listing. Completion is tracked separately from the
// cursor: a final page that reports has_more:false is a SUCCESS even when an
// earlier page set a cursor; DISCOVERY_PAGINATION is reported only when the
// page bound is hit while more pages remain. fetchPage(url, headers) returns
// {status, ok, text} and throws on network/redirect/timeout/oversize.
export async function collectServiceModels({ listUrl, headers, fetchPage }) {
  const models = [];
  const seen = new Set();
  let after = null;
  let exhausted = false;
  const failure = code => ({
    status: "failed",
    models: [],
    error: { code, message: "model listing request failed at the configured endpoint" },
  });
  for (let page = 0; page < DISCOVERY_MAX_PAGES; page++) {
    const url = new URL(listUrl);
    if (after) url.searchParams.set("after", after);
    let response;
    try {
      response = await fetchPage(url, headers);
    } catch (error) {
      return failure(
        error?.code === "DISCOVERY_TOO_LARGE" ? "DISCOVERY_TOO_LARGE" : "DISCOVERY_NETWORK",
      );
    }
    if (response.status === 404 || response.status === 405) {
      return {
        status: "unsupported",
        models: [],
        error: {
          code: "DISCOVERY_LISTING_UNSUPPORTED",
          message: "endpoint does not expose a model listing API",
        },
      };
    }
    if (response.status === 401 || response.status === 403) {
      return failure("DISCOVERY_UNAUTHORIZED");
    }
    if (!response.ok) {
      return failure("DISCOVERY_ENDPOINT");
    }
    let payload;
    try {
      payload = JSON.parse(response.text);
    } catch {
      return failure("DISCOVERY_MALFORMED");
    }
    const rows = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload)
          ? payload
          : null;
    if (!rows) {
      return failure("DISCOVERY_MALFORMED");
    }
    for (const row of rows) {
      const id = typeof row === "string" ? row : typeof row?.id === "string" ? row.id : null;
      if (!id || !id.trim() || id.length > 200 || /[\x00-\x1f\x7f]/.test(id)) continue;
      const modelId = id.trim();
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      const name =
        typeof row?.name === "string" && row.name.trim() && row.name.length <= 200
          ? row.name.trim()
          : undefined;
      models.push({ id: modelId, ...(name ? { name } : {}) });
      if (models.length >= DISCOVERY_MAX_MODELS) break;
    }
    if (models.length >= DISCOVERY_MAX_MODELS) {
      exhausted = true;
      break;
    }
    const more = payload?.has_more === true;
    const lastId =
      typeof payload?.last_id === "string" && payload.last_id ? payload.last_id : null;
    if (!more || !lastId) {
      exhausted = true;
      break;
    }
    // Cursor pagination stays on the originally authorized origin: the URL is
    // derived from listUrl, only the opaque cursor changes.
    after = lastId;
  }
  return exhausted ? { status: "succeeded", models } : failure("DISCOVERY_PAGINATION");
}

async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** dataURL string | {type:'image',mimeType,data} | {mimeType,dataBase64|data} | {mimeType,path} */
async function normalizeImages(images) {
  if (!images) {
    return [];
  }
  if (!Array.isArray(images)) {
    throw Object.assign(new Error("images must be an array"), { code: "PI_INVALID_PARAMS" });
  }
  const attachments = [];
  for (const image of images) {
    if (typeof image === "string") {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(image.trim());
      if (!match) {
        throw Object.assign(
          new Error("image strings must be data URLs (data:<mime>;base64,<data>)"),
          { code: "PI_INVALID_PARAMS" },
        );
      }
      attachments.push({ kind: "image", mimeType: match[1], data: match[2] });
      continue;
    }
    if (!image || typeof image !== "object") {
      throw Object.assign(new Error("invalid image attachment"), { code: "PI_INVALID_PARAMS" });
    }
    if (typeof image.mimeType === "string" && typeof image.dataBase64 === "string") {
      attachments.push({ kind: "image", mimeType: image.mimeType, data: image.dataBase64 });
      continue;
    }
    if (typeof image.mimeType === "string" && typeof image.data === "string") {
      attachments.push({ kind: "image", mimeType: image.mimeType, data: image.data });
      continue;
    }
    if (typeof image.path === "string") {
      const buffer = await readFile(image.path);
      attachments.push({
        kind: "image",
        mimeType: image.mimeType ?? "image/png",
        data: buffer.toString("base64"),
      });
      continue;
    }
    throw Object.assign(new Error("invalid image attachment"), { code: "PI_INVALID_PARAMS" });
  }
  return attachments;
}

function systemPromptExtension(instructions, context) {
  return {
    name: "nozeli-owner-system-prompt",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", async () => ({ systemPrompt: [instructions, context?.()?.taskAnchor].filter(Boolean).join('\n') }));
    },
  };
}

function countStats(entries) {
  const stats = {
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    totalEntries: entries.length,
  };
  for (const entry of entries) {
    if (entry?.type !== "message") {
      continue;
    }
    const role = entry.message?.role;
    if (role === "user") stats.userMessages += 1;
    else if (role === "assistant") stats.assistantMessages += 1;
    else if (role === "toolResult") stats.toolResults += 1;
  }
  return stats;
}

export class OwnerRuntime {
  constructor({ send }) {
    this.send = send;
    this.facts = createFactChannel({ send });
    this.tools = createHostToolBridge({ send, onHostControl: (reason = {}) => {
      const turn = this.promptInFlight;
      if (!turn || turn.settled) return;
      if (reason.error) turn.hostToolError = reason.error;
      else if (reason.cancelled) turn.cancelRequested = true;
      else turn.hostControl = true;
      // abort() synchronously fences the native loop before awaiting idle.
      // Never await it inside the executing tool: that would wait on itself.
      const stopping = this.nativeRuntime.session.abort();
      void stopping.catch(error => this.facts.failTurn(error?.message ?? String(error)));
    } });
    this.interactions = createInteractionBridge({ send });
    this.questions = createNativeQuestionBridge({ send });
    this.storage = createMemoryCatalogStorage();
    this.driver = null;
    this.sessionRef = null;
    this.cwd = null;
    this.agentDir = null;
    this.snapshot = null;
    this.promptInFlight = null;
    this.unsubscribeDriver = null;
    this.sessionConfig = { definitions: [], nativeTools: undefined, instructions: undefined };
    this.journalEntries = new Map();
    this.nativeRuntime = null;
  }

  async ensureInitialized({ home, agentDir, cwd } = {}) {
    const resolvedAgentDir =
      agentDir ??
      process.env.PI_CODING_AGENT_DIR ??
      (home ? path.resolve(home, "config") : undefined) ??
      (process.env.NOZELI_PI_OWNER_HOME
        ? path.resolve(process.env.NOZELI_PI_OWNER_HOME, "config")
        : undefined);
    if (!resolvedAgentDir) {
      throw Object.assign(
        new Error("agentDir is required (params.agentDir, params.home, PI_CODING_AGENT_DIR, or NOZELI_PI_OWNER_HOME)"),
        { code: "PI_INVALID_PARAMS" },
      );
    }
    process.env.PI_CODING_AGENT_DIR ??= path.resolve(resolvedAgentDir);
    this.agentDir ??= path.resolve(resolvedAgentDir);
    await mkdir(this.agentDir, { recursive: true });
    const vendor = await loadVendor();
    if (!this.driver) {
      const runtimeImpl = async (options) => {
        const config = this.sessionConfig;
        const merged = { ...options };
        if (config.definitions.length > 0) {
          merged.customTools = [...(options.customTools ?? []), ...config.definitions];
        }
        if (config.nativeTools === "none") {
          merged.tools = [];
        } else if (Array.isArray(config.nativeTools)) {
          merged.tools = [
            ...new Set([...config.nativeTools, ...config.definitions.map((tool) => tool.name)]),
          ];
        }
        if (config.instructions !== undefined) {
          merged.resourceLoaderOptions = {
            ...(options.resourceLoaderOptions ?? {}),
            extensionFactories: [
              ...(options.resourceLoaderOptions?.extensionFactories ?? []),
              systemPromptExtension(config.instructions, () => this.promptInFlight?.beforeAgentContext),
            ],
          };
        }
        const runtime = await vendor.createAgentSessionRuntimeWithNpmFallback(merged);
        this.nativeRuntime = runtime;
        return runtime;
      };
      this.driver = vendor.createPiSdkDriver({
        agentDir: this.agentDir,
        catalogStorage: this.storage,
        createAgentSessionRuntimeImpl: runtimeImpl,
        onNativeSessionEvent: (ref, event) => this.facts.onNativeSessionEvent(ref, event),
        openUrl: (url) =>
          this.send({ event: "native", eventData: { type: "openUrl", url } }),
      });
    }
    if (cwd) {
      this.cwd ??= path.resolve(cwd);
    }
  }

  onDriverEvent(event) {
    if (
      event?.type === "sessionOpened" ||
      event?.type === "sessionUpdated" ||
      event?.type === "runCompleted"
    ) {
      if (event.snapshot) {
        this.snapshot = event.snapshot;
      }
    } else if (event?.type === "runFailed") {
      this.facts.failTurn(event.error?.message ?? "run failed");
    }
  }

  effectiveNow() {
    const config = this.snapshot?.config ?? {};
    const session = this.nativeRuntime?.session;
    const provider = session?.model?.provider ?? config.provider;
    const modelId = session?.model?.id ?? config.modelId;
    const effort = session?.thinkingLevel ?? config.thinkingLevel ?? null;
    return {
      ...(provider && modelId
        ? { model: `${provider}/${modelId}`, provider, modelId }
        : {}),
      ...(effort ? { effort } : {}),
    };
  }

  async applyProviderConfig({ cwd, model }) {
    if (!model?.provider) {
      return;
    }
    const workspace = workspaceRefFor(cwd ?? this.cwd ?? process.cwd());
    const runtimeSupervisor = this.driver.runtimeSupervisor;
    if (model.baseUrl) {
      if (!model.modelId) {
        throw Object.assign(
          new Error("modelId is required together with baseUrl"),
          { code: "PI_INVALID_PARAMS" },
        );
      }
      try {
        await runtimeSupervisor.setCustomProvider(workspace, {
          providerId: model.provider,
          baseUrl: model.baseUrl,
          ...(model.apiKey ? { apiKey: model.apiKey } : {}),
          ...(model.api ? { api: model.api } : {}),
          models: [
            {
              id: model.modelId,
              ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
            },
          ],
        });
      } catch (error) {
        throw mapError(error, "PI_PROVIDER_CONFLICT");
      }
    } else if (model.apiKey) {
      try {
        await runtimeSupervisor.setProviderApiKey(workspace, model.provider, model.apiKey);
      } catch (error) {
        throw mapError(error, "PI_AUTH_UNSUPPORTED");
      }
    }
  }

  async start(params) {
    await this.ensureInitialized(params);
    if (this.sessionRef) {
      throw Object.assign(new Error("owner already holds a session"), {
        code: "PI_OWNER_EXISTS",
      });
    }
    if (typeof params?.cwd !== "string" || !params.cwd) {
      throw Object.assign(new Error("cwd is required"), { code: "PI_INVALID_PARAMS" });
    }
    this.cwd = path.resolve(params.cwd);
    const { SessionManager } = await loadVendor();

    const model = parseModelSelector(params.model ?? null);
    await this.applyProviderConfig({ cwd: this.cwd, model });

    this.sessionConfig = {
      definitions: [
        ...this.tools.definitionsFor(normalizeHostTools(params.tools ?? [])),
        ...(params.nativeTools === 'none' || Array.isArray(params.nativeTools) && !params.nativeTools.includes('ask') ? [] : this.questions.definitions()),
      ],
      nativeTools:
        params.nativeTools === "none"
          ? "none"
          : Array.isArray(params.nativeTools)
            ? params.nativeTools.filter(
                (name, index, all) =>
                  typeof name === "string" && name && all.indexOf(name) === index,
              )
            : undefined,
      instructions: typeof params.instructions === "string" ? params.instructions : undefined,
    };

    let sessionFile = null;
    let sessionId = null;
    let resume = false;
    let probeEntries = null;
    if (typeof params.sessionFile === "string" && params.sessionFile) {
      sessionFile = path.resolve(params.sessionFile);
      if (!existsSync(sessionFile)) {
        throw Object.assign(new Error(`session file not found: ${sessionFile}`), {
          code: "PI_SESSION_FILE_NOT_FOUND",
        });
      }
    } else if (typeof params.sessionId === "string" && params.sessionId) {
      sessionFile = SessionManager.findById(this.cwd, params.sessionId) ?? null;
      if (!sessionFile) {
        throw Object.assign(
          new Error(`session ${params.sessionId} not found under ${this.agentDir}`),
          { code: "PI_SESSION_FILE_NOT_FOUND" },
        );
      }
    }
    const workspace = workspaceRefFor(this.cwd);
    let snapshot;
    if (sessionFile) {
      const probe = SessionManager.open(sessionFile);
      sessionId = probe.getSessionId();
      if (params.sessionId && sessionId !== params.sessionId) {
        throw Object.assign(
          new Error(
            `session identity mismatch: file holds ${sessionId}, requested ${params.sessionId}`,
          ),
          { code: "PI_SESSION_IDENTITY" },
        );
      }
      resume = true;
      await seedResumeSession(this.storage, {
        workspaceId: workspace.workspaceId,
        cwd: this.cwd,
        sessionId,
        sessionFile,
      });
      snapshot = await this.driver.openSession({ workspaceId: workspace.workspaceId, sessionId });
      probeEntries = probe.getEntries();
    } else {
      snapshot = await this.driver.createSession(workspace, {
        title: typeof params.role === "string" && params.role ? params.role : "nozeli",
        ...(model?.provider && model?.modelId
          ? { initialModel: { provider: model.provider, modelId: model.modelId } }
          : {}),
        ...(params.effort ? { initialThinkingLevel: params.effort } : {}),
      });
      sessionId = snapshot.ref.sessionId;
    }

    this.sessionRef = { workspaceId: workspace.workspaceId, sessionId };
    this.snapshot = snapshot;
    this.facts.setSessionId(sessionId);
    this.unsubscribeDriver?.();
    this.unsubscribeDriver = this.driver.subscribe(this.sessionRef, (event) =>
      this.onDriverEvent(event),
    );

    const resolvedSessionFile =
      (await this.driver.getSessionFilePath(this.sessionRef)) ?? sessionFile ?? undefined;
    const entries = resume ? (probeEntries ?? []) : [];
    const hasPrompted = entries.some(
      (entry) => entry?.type === "message" && entry.message?.role === "user",
    );
    const config = snapshot.config ?? {};
    const effort = this.effectiveNow().effort ?? null;
    await this.flush();
    return {
      sessionId,
      sessionFile: resolvedSessionFile,
      resume,
      model:
        config.provider && config.modelId
          ? { provider: config.provider, modelId: config.modelId }
          : null,
      effort,
      effective: this.effectiveNow(),
      hasPrompted,
      ...(resume ? { entries } : {}),
    };
  }

  async prompt(params) {
    if (!this.sessionRef) {
      throw Object.assign(new Error("session not started"), { code: "PI_NOT_STARTED" });
    }
    if (this.promptInFlight) {
      throw Object.assign(new Error("a prompt is already in flight"), { code: "PI_BUSY" });
    }
    if (typeof params?.text !== "string" || !params.text) {
      throw Object.assign(new Error("text is required"), { code: "PI_INVALID_PARAMS" });
    }
    const attachments = await normalizeImages(params.images);
    const turn = {
      turnId: randomUUID(),
      requestId: typeof params.requestId === "string" ? params.requestId : undefined,
      jobId: params.job && typeof params.job.id !== "undefined" ? params.job.id : undefined,
      beforeAgentContext: params.beforeAgentContext,
      sessionId: this.sessionRef.sessionId,
      settled: false,
      aborted: false,
      notifySettled: null,
    };
    this.facts.beginTurn(turn);
    this.tools.setTurn(turn);
    this.questions.setTurn(turn);
    const settlePromise = new Promise((resolve) => {
      turn.notifySettled = resolve;
    });
    this.promptInFlight = turn;
    try {
      try {
        await this.driver.sendUserMessage(this.sessionRef, {
          text: params.text,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        if (!turn.settled) {
          await Promise.race([settlePromise, new Promise((resolve) => {
            const timer = setTimeout(resolve, 15000);timer.unref();
          })]);
        }
      } catch (error) {
        this.facts.failTurn(error?.message ?? String(error));
        throw mapError(error, "PI_PROMPT_FAILED");
      }
      if (!turn.settled) throw Object.assign(new Error('Pi run settlement was not observed; no automatic replay'), { code: 'PI_SETTLEMENT_UNKNOWN' });
      await this.flush();
      if (turn.hostToolError) throw Object.assign(new Error(turn.hostToolError.message ?? String(turn.hostToolError)), {code:'PI_HOST_TOOL_FAILED',cause:turn.hostToolError});
      const aborted = turn.aborted || turn.cancelRequested === true;
      if (this.facts.state.turnErrorMessage && !aborted) throw Object.assign(new Error(this.facts.state.turnErrorMessage), { code: 'PI_PROVIDER_FAILED' });
      return {
        text: this.facts.state.lastAssistantText ?? '',
        completion: turn.hostControl ? 'host-control' : aborted ? 'aborted' : 'provider-completed',
        metrics: { ...(this.facts.state.turnUsage ? { usage: this.facts.state.turnUsage } : {}), ...(this.snapshot?.usage ? { sessionUsage: this.snapshot.usage } : {}) },
        effective: this.effectiveNow(), projectedNative: true,
      };
    } finally {
      // An unknown settlement stays fenced; a known provider failure may recover.
      if (turn.settled) {
        this.promptInFlight = null;
        this.facts.endTurn();
        this.tools.setTurn(null);
        this.questions.setTurn(null);
      }
    }
  }

  async cancel(params) {
    if (!this.sessionRef) {
      this.interactions.cancelAll();
      return {stopped:true,settings:true};
    }
    const current = this.promptInFlight;
    if (!current) {
      return { stopped: false };
    }
    if (params?.requestId && params.requestId !== current.requestId) {
      return { stopped: false, mismatch: true };
    }
    this.questions.cancelAll();
    if (!current.settled) current.cancelRequested = true;
    await this.driver.cancelCurrentRun(this.sessionRef);
    if (!current.settled) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 10000);
        current.notifySettled = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    return { stopped: true, requestId: current.requestId };
  }

  async respond(params) {
    const id = params?.id;
    if (typeof id !== "string" || !id) {
      throw Object.assign(new Error("respond requires id"), { code: "PI_INVALID_PARAMS" });
    }
    const payload = {
      answer: params.answer,
      cancel: params.cancel === true,
      ...(params.result !== undefined ? { result: params.result } : {}),
      ...(params.error ? { error: params.error } : {}),
    };
    if (this.questions.resolveReverse(id, payload)) {
      return { accepted: true, kind: 'question' };
    }
    if (this.tools.resolveReverse(id, payload)) {
      return { accepted: true, kind: "tool" };
    }
    if (this.interactions.resolveReverse(id, payload)) {
      return { accepted: true, kind: "interaction" };
    }
    throw Object.assign(new Error(`unknown reverse RPC id ${id}`), {
      code: "PI_INTERACTION_UNKNOWN",
    });
  }

  async model(params) {
    if (!this.sessionRef) {
      throw Object.assign(new Error("session not started"), { code: "PI_NOT_STARTED" });
    }
    if (this.promptInFlight) {
      throw Object.assign(new Error("cannot switch model while a prompt runs"), {
        code: "PI_BUSY",
      });
    }
    const selector = parseModelSelector(params?.selector);
    if (!selector?.provider || !selector?.modelId) {
      throw Object.assign(new Error("model requires a selector"), { code: "PI_INVALID_PARAMS" });
    }
    if (
      params.effort !== undefined &&
      params.effort !== null &&
      !THINKING_LEVELS.includes(params.effort)
    ) {
      throw Object.assign(
        new Error(`effort must be one of ${THINKING_LEVELS.join(", ")}`),
        { code: "PI_INVALID_PARAMS" },
      );
    }
    await this.applyProviderConfig({ cwd: this.cwd, model: selector });
    // refreshProvider re-resolves the selector against the session's own
    // runtime so credential/model-source edits reach existing sessions without
    // creating a new session or replaying input.
    await this.driver.setSessionModel(this.sessionRef, {
      provider: selector.provider,
      modelId: selector.modelId,
      ...(params.refreshProvider === true ? { refresh: true } : {}),
    });
    if (params.effort) {
      await this.driver.setSessionThinkingLevel(this.sessionRef, params.effort);
    }
    const effective = this.effectiveNow();
    const requested = params.effort ? { effort: params.effort } : null;
    const clamped =
      requested && effective.effort && effective.effort !== requested.effort
        ? { requested: requested.effort, effective: effective.effort, reason: "native-clamp" }
        : null;
    return {
      model: effective.provider ? { provider: effective.provider, modelId: effective.modelId } : null,
      effort: effective.effort ?? null,
      effective,
      ...(requested ? { requested } : {}),
      ...(clamped ? { clamped } : {}),
      thinkingLevels: await this.safeThinkingLevels(),
    };
  }

  async safeThinkingLevels() {
    // Native per-model capability straight from the live session. Older
    // dist bundles without getSessionThinkingLevels report null (unknown),
    // never an invented tier list.
    if (!this.sessionRef || typeof this.driver.getSessionThinkingLevels !== "function") {
      return null;
    }
    try {
      const levels = await this.driver.getSessionThinkingLevels(this.sessionRef);
      return Array.isArray(levels) ? levels.slice() : null;
    } catch {
      return null;
    }
  }

  async reload() {
    if (!this.sessionRef) {
      throw Object.assign(new Error("session not started"), { code: "PI_NOT_STARTED" });
    }
    if (this.promptInFlight) {
      throw Object.assign(new Error("cannot reload while a prompt runs"), { code: "PI_BUSY" });
    }
    await this.driver.reloadSession(this.sessionRef);
    const file = await this.resolvedSessionFile();
    const manager = (await loadVendor()).SessionManager.open(file);
    return {
      reloaded: true,
      entryCount: manager.getEntries().length,
      leafId: manager.getLeafId(),
    };
  }

  async compact() {
    if (!this.sessionRef) throw Object.assign(new Error('session not started'), {code:'PI_NOT_STARTED'});
    if (this.promptInFlight) throw Object.assign(new Error('cannot compact an active prompt'), {code:'PI_BUSY'});
    await this.driver.compactSession(this.sessionRef);
    const saved = await this.flush();
    return {compacted:true,sessionId:this.sessionRef.sessionId,entryCount:saved.entryCount,leafId:saved.leafId};
  }

  async resolvedSessionFile() {
    const file =
      (await this.driver.getSessionFilePath(this.sessionRef)) ?? null;
    if (!file) {
      throw Object.assign(new Error("session file is not tracked"), {
        code: "PI_SESSION_FILE_NOT_FOUND",
      });
    }
    return file;
  }

  async flush() {
    if (!this.sessionRef) {
      throw Object.assign(new Error("session not started"), { code: "PI_NOT_STARTED" });
    }
    const file = await this.resolvedSessionFile();
    const handle = await open(file, 'r');
    let bytes;
    try { await handle.sync(); bytes = await handle.readFile(); } finally { await handle.close(); }
    const entries = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type !== 'session');
    for (const entry of entries) {
      if (typeof entry.id !== 'string') throw Object.assign(new Error('Pi journal entry has no native identity'), {code:'PI_JOURNAL_INVALID'});
      const encoded = JSON.stringify(entry), prior = this.journalEntries.get(entry.id);
      if (prior && prior !== encoded) throw Object.assign(new Error('Pi journal entry identity changed'), {code:'PI_JOURNAL_COLLISION'});
      if (!prior) {
        this.facts.onNativeSessionEvent(this.sessionRef, {type:'entry_appended',entry});
        this.journalEntries.set(entry.id, encoded);
      }
    }
    const stats = await stat(file), digest = createHash('sha256').update(bytes).digest('hex');
    const manager = (await loadVendor()).SessionManager.open(file);
    return {
      sessionFile: file,
      entryCount: entries.length,
      persistedEntryCount: manager.getEntries().length,
      leafId: manager.getLeafId(),
      seq: this.facts.currentSeq(),
      mtimeMs: stats.mtimeMs,
      sha256File: digest,
    };
  }

  async status() {
    if (!this.sessionRef) {
      return { started: false };
    }
    let entryCount = null;
    let leafId = null;
    try {
      const file = await this.resolvedSessionFile();
      const manager = (await loadVendor()).SessionManager.open(file);
      entryCount = manager.getEntries().length;
      leafId = manager.getLeafId();
    } catch {
      // status stays best-effort
    }
    const config = this.snapshot?.config ?? {};
    return {
      started: true,
      sessionId: this.sessionRef.sessionId,
      sessionFile: await this.resolvedSessionFile().catch(() => null),
      model:
        config.provider && config.modelId
          ? { provider: config.provider, modelId: config.modelId }
          : null,
      effort: config.thinkingLevel ?? null,
      effective: this.effectiveNow(),
      thinkingLevels: await this.safeThinkingLevels(),
      hasPrompted: true,
      busy: Boolean(this.promptInFlight),
      entryCount,
      leafId,
      seq: this.facts.currentSeq(),
    };
  }

  async stop() {
    this.questions.cancelAll();
    if (this.sessionRef) {
      const current = this.promptInFlight;
      if (current && !current.settled) await this.cancel({requestId:current.requestId});
      await this.driver.closeSession(this.sessionRef);
      await this.flush();
      this.unsubscribeDriver?.();
      this.unsubscribeDriver = null;
      this.promptInFlight = null;
      this.facts.endTurn();
      this.tools.setTurn(null);
      this.sessionRef = null;
    }
    return { confirmationComplete: true };
  }

  // ---- provider settings (usable without start) ----

  runtimeSupervisor() {
    if (!this.driver?.runtimeSupervisor) {
      throw Object.assign(new Error("runtime not initialized"), { code: "PI_NOT_STARTED" });
    }
    return this.driver.runtimeSupervisor;
  }

  async modelsList(params) {
    await this.ensureInitialized(params);
    const workspace = workspaceRefFor(path.resolve(params?.cwd ?? this.cwd ?? process.cwd()));
    const snapshot = await this.runtimeSupervisor().getRuntimeSnapshot(workspace);
    const models = snapshot.models
      .filter((model) => !params?.provider || model.providerId === params.provider)
      .map((model) => ({
        provider: model.providerId,
        modelId: model.modelId,
        name: model.label,
        selector: `${model.providerId}/${model.modelId}`,
        reasoning: model.reasoning === true,
        ...(Array.isArray(model.thinkingLevels) ? { thinkingLevels: model.thinkingLevels } : {}),
        supportsImages: model.supportsImages === true,
        authed: model.available === true,
        scope: model.scope,
      }));
    return { models };
  }

  async providerList(params) {
    await this.ensureInitialized(params);
    const providers = await this.runtimeSupervisor().listCustomProviders();
    return {
      providers: providers.map((entry) => ({
        provider: entry.providerId,
        baseUrl: entry.baseUrl,
        hasApiKey: entry.apiKey !== undefined,
        ...(entry.api ? { api: entry.api } : {}),
        models: entry.models.map((model) => ({
          id: model.id,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          ...(model.name ? { name: model.name } : {}),
          ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        })),
      })),
    };
  }

  async providerUpsert(params) {
    await this.ensureInitialized(params);
    if (
      typeof params?.provider !== "string" ||
      !params.provider ||
      typeof params.baseUrl !== "string" ||
      !Array.isArray(params.models) ||
      params.models.length === 0
    ) {
      throw Object.assign(
        new Error("providerUpsert requires provider, baseUrl, models[{id}]"),
        { code: "PI_INVALID_PARAMS" },
      );
    }
    for (const model of params.models) {
      if (typeof model?.id !== "string" || !model.id) {
        throw Object.assign(new Error("models require string ids"), {
          code: "PI_INVALID_PARAMS",
        });
      }
      if (model.name !== undefined && (typeof model.name !== "string" || !model.name || model.name.length > 200)) {
        throw Object.assign(new Error("model name must be 1..200 chars"), {
          code: "PI_INVALID_PARAMS",
        });
      }
      if (model.reasoning !== undefined && typeof model.reasoning !== "boolean") {
        throw Object.assign(new Error("model reasoning must be boolean"), {
          code: "PI_INVALID_PARAMS",
        });
      }
    }
    const workspace = workspaceRefFor(path.resolve(params.cwd ?? this.cwd ?? process.cwd()));
    const supervisor = this.runtimeSupervisor();
    let apiKey = typeof params.apiKey === "string" && params.apiKey.trim() ? params.apiKey.trim() : undefined;
    if (!apiKey && params.preserveApiKey === true) {
      // Retained credentials are resolved here, inside the trusted worker and
      // against the very record being replaced: the key never crosses IPC and
      // an omitted key can never degrade into the "unused" placeholder.
      const existing = (await supervisor.listCustomProviders()).find(
        (entry) => entry.providerId === params.provider,
      );
      if (!existing || existing.apiKey === undefined) {
        throw Object.assign(
          new Error("no stored credential to keep for this provider"),
          { code: "PI_CREDENTIAL_KEEP_UNAVAILABLE" },
        );
      }
      const previousOrigin = safeOrigin(existing.baseUrl);
      const nextOrigin = safeOrigin(params.baseUrl);
      if (previousOrigin && nextOrigin && previousOrigin !== nextOrigin && params.confirmNewOrigin !== true) {
        throw Object.assign(
          new Error(
            "API address origin changed; reusing the stored credential at a different origin requires explicit confirmation",
          ),
          { code: "PI_CREDENTIAL_ORIGIN_CHANGE" },
        );
      }
      apiKey = existing.apiKey;
    }
    try {
      await supervisor.setCustomProvider(workspace, {
        providerId: params.provider,
        baseUrl: params.baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(params.api ? { api: params.api } : {}),
        models: params.models.map((model) => ({
          id: model.id,
          ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
          ...(model.name ? { name: model.name } : {}),
          ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        })),
      });
    } catch (error) {
      throw mapError(error, "PI_PROVIDER_CONFLICT");
    }
    return {
      provider: params.provider,
      baseUrl: params.baseUrl,
      hasApiKey: apiKey !== undefined,
      models: params.models.map((m) => m.id),
    };
  }

  /**
   * Actual service model-list discovery. Explicit user action only.
   *
   * Path semantics mirror the native chat client for the configured protocol
   * so a successful list really is the endpoint that would serve inference:
   *  - openai-completions / openai-responses: GET {baseUrl}/models (Bearer),
   *    exactly the prefix the chat client appends /chat/completions to;
   *  - anthropic-messages: GET {baseUrl}/v1/models (x-api-key), exactly the
   *    root the chat client appends /v1/messages to (gateway prefixes kept).
   * Bounded time/size/pages; redirects rejected so credentials never follow a
   * cross-origin hop; 404/405 report an unsupported listing endpoint while
   * 401/403 stay authorization failures. A listed model is NOT proof of
   * inference entitlement, and no chat/completion request is ever sent.
   */
  async providerDiscoverModels(params) {
    await this.ensureInitialized(params);
    let baseUrl;
    let api;
    let apiKey;
    if (typeof params?.provider === "string" && params.provider) {
      const entry = (await this.runtimeSupervisor().listCustomProviders()).find(
        (candidate) => candidate.providerId === params.provider,
      );
      if (!entry) {
        throw Object.assign(new Error("saved source not found"), {
          code: "PI_SOURCE_NOT_FOUND",
        });
      }
      baseUrl = entry.baseUrl;
      api = entry.api ?? "openai-completions";
      apiKey = entry.apiKey;
    } else {
      if (typeof params?.baseUrl !== "string" || !params.baseUrl) {
        throw Object.assign(
          new Error("providerDiscoverModels requires provider or baseUrl"),
          { code: "PI_INVALID_PARAMS" },
        );
      }
      baseUrl = params.baseUrl;
      api = params.api ?? "openai-completions";
      if (typeof params.apiKey === "string" && params.apiKey.trim()) {
        apiKey = params.apiKey.trim();
      }
    }
    if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(api)) {
      throw Object.assign(new Error("unsupported discovery protocol"), {
        code: "PI_INVALID_PARAMS",
      });
    }
    const root = baseUrl.replace(/\/+$/, "");
    let listUrl;
    let headers;
    if (api === "anthropic-messages") {
      listUrl = `${root}/v1/models?limit=100`;
      headers = {
        accept: "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        "anthropic-version": "2023-06-01",
      };
    } else {
      listUrl = `${root}/models?limit=100`;
      headers = {
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      };
    }
    const fetchedAt = new Date().toISOString();
    const origin = safeOrigin(listUrl);
    const collected = await collectServiceModels({
      listUrl,
      headers,
      fetchPage: async (url, requestHeaders) => {
        const response = await fetch(url, {
          method: "GET",
          headers: requestHeaders,
          redirect: "error",
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
        return {
          status: response.status,
          ok: response.ok,
          text: await readBounded(response, DISCOVERY_MAX_BYTES),
        };
      },
    });
    if (collected.status === "succeeded") {
      return {
        status: "succeeded",
        protocol: api,
        fetchedAt,
        models: collected.models,
        entitlement: "unknown",
      };
    }
    if (collected.status === "unsupported") {
      return {
        status: "unsupported",
        protocol: api,
        fetchedAt,
        models: [],
        entitlement: "unknown",
        error: collected.error,
      };
    }
    return discoveryFailure(collected.error.code, origin, fetchedAt, api);
  }

  async providerRemove(params) {
    await this.ensureInitialized(params);
    const workspace = workspaceRefFor(path.resolve(params?.cwd ?? this.cwd ?? process.cwd()));
    await this.runtimeSupervisor().deleteCustomProvider(workspace, params.provider);
    return { removed: true };
  }

  async authSetKey(params) {
    await this.ensureInitialized(params);
    if (typeof params?.provider !== "string" || typeof params?.apiKey !== "string" || !params.apiKey.trim()) {
      throw Object.assign(new Error("authSetKey requires provider and apiKey"), {
        code: "PI_INVALID_PARAMS",
      });
    }
    const workspace = workspaceRefFor(path.resolve(params.cwd ?? this.cwd ?? process.cwd()));
    try {
      await this.runtimeSupervisor().setProviderApiKey(workspace, params.provider, params.apiKey);
    } catch (error) {
      throw mapError(error, "PI_AUTH_UNSUPPORTED");
    }
    return { provider: params.provider, type: "api_key" };
  }

  async authDisable(params) {
    await this.ensureInitialized(params);
    const workspace = workspaceRefFor(path.resolve(params?.cwd ?? this.cwd ?? process.cwd()));
    await this.runtimeSupervisor().logout(workspace, params.provider);
    return { removed: true };
  }

  async authList(params) {
    await this.ensureInitialized(params);
    const workspace = workspaceRefFor(path.resolve(params?.cwd ?? this.cwd ?? process.cwd()));
    const snapshot = await this.runtimeSupervisor().getRuntimeSnapshot(workspace);
    return {
      credentials: snapshot.providers.map((provider) => ({
        provider: provider.id,
        name: provider.name ?? provider.id,
        type: provider.authType,
        hasAuth: provider.hasAuth === true,
        authSource: provider.authSource,
        oauthSupported: provider.oauthSupported === true,
        apiKeySetupSupported: provider.apiKeySetupSupported === true,
      })),
    };
  }

  async authLogin(params) {
    await this.ensureInitialized(params);
    const workspace = workspaceRefFor(path.resolve(params.cwd ?? this.cwd ?? process.cwd()));
    let provider = params.provider;
    if (!provider) {
      const snapshot = await this.runtimeSupervisor().getRuntimeSnapshot(workspace);
      const options = snapshot.providers.filter(row => row.oauthSupported).map(row => ({id:row.id,label:row.name??row.id}));
      if (!options.length) throw Object.assign(new Error('No OAuth providers are available'), {code:'PI_AUTH_UNSUPPORTED'});
      provider = await this.interactions.ask({kind:'select',options});
      if (!options.some(row => row.id === provider)) throw Object.assign(new Error('Unknown OAuth provider'), {code:'PI_INVALID_PARAMS'});
    }
    const notify = (eventData) => this.send({ event: "native", eventData });
    try {
      await this.runtimeSupervisor().login(workspace, provider, {
        onAuth: (info) => this.send({event:'interaction',interaction:{id:randomUUID(),provider,kind:'url',url:info.url,message:info.instructions}}),
        onPrompt: (prompt) =>
          this.interactions.ask({
            provider,
            kind: "input",
            message: prompt.message,
            placeholder: prompt.placeholder,
          }),
        onManualCodeInput: () =>
          this.interactions.ask({ provider, kind: "input", message: "manual code" }),
        onProgress: (message) =>
          notify({ type: "authStatus", provider, state: "progress", message }),
      });
    } catch (error) {
      throw mapError(error, "PI_AUTH_FAILED");
    }
    notify({ type: "authStatus", provider, state: "done" });
    return { provider, ok: true };
  }
}
