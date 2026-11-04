/**
 * Nozeli-authored. Fact channel: converts raw Pi AgentSessionEvents (delivered
 * by the patched vendored SessionSupervisor through onNativeSessionEvent) into
 * the worker's transport-neutral outbound frames:
 *
 *   {event:'entry', sessionId, seq, entry, requestId?, jobId?, turnId?}
 *   {event:'admitted', requestId, sessionId, turnId?}
 *   {event:'native', eventData:{type, sessionId?, turnId?, ...}}
 *
 * Entries are forwarded VERBATIM (Pi journal entries with their real id /
 * parentId / timestamp); nothing is synthesized, previewed, or deduplicated.
 * Streaming message snapshots are marked projected:true so the host can treat
 * them as projection frames and key durable rows on entry events only.
 */

function toJson(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}

function messageText(message) {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}
// Bounded sanitized scalar helpers for structured failure evidence. Never
// message-text classification: the host consumes these FIELDS; the display
// string stays separate.
const scalar = (value, max) => (typeof value === "string" && value.length <= max ? value : null);
const boundedText = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);
// Bounded non-negative integer for native retry counters (attempt counts,
// attempt ceilings, delays). Never invented or coerced from other shapes.
const boundedCount = value =>
  Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;

// Structured per-attempt evidence extracted from the JOURNALED failed
// assistant message: provider/model/api identities, stop reasons and
// diagnostic codes. The provider error text is already a display string
// composed by pi-ai; classification must not depend on it.
function providerFailureOf(message) {
  if (!message || message.role !== "assistant" || message.stopReason !== "error") {
    return null;
  }
  const diagnostics = Array.isArray(message.diagnostics) ? message.diagnostics : [];
  const diagnosticCodes = [];
  for (const diagnostic of diagnostics) {
    const code = diagnostic?.error?.code;
    if ((typeof code === "number" && Number.isInteger(code)) || (typeof code === "string" && /^[A-Za-z0-9_. -]{1,64}$/.test(code))) {
      diagnosticCodes.push(code);
    }
    if (diagnosticCodes.length >= 8) break;
  }
  return {
    stopReason: scalar(message.stopReason, 32),
    ...(scalar(message.rawStopReason, 64) ? { rawStopReason: scalar(message.rawStopReason, 64) } : {}),
    ...(scalar(message.provider, 64) ? { provider: scalar(message.provider, 64) } : {}),
    ...(scalar(message.model, 200) ? { model: scalar(message.model, 200) } : {}),
    ...(scalar(message.api, 64) ? { api: scalar(message.api, 64) } : {}),
    ...(diagnosticCodes.length ? { diagnosticCodes } : {}),
    ...(boundedText(message.errorMessage, 512) ? { errorMessage: boundedText(message.errorMessage, 512) } : {}),
    at: new Date().toISOString(),
  };
}

const MESSAGE_EVENT_NAMES = {
  message_start: "message_start",
  message_update: "message_update",
  message_end: "message_end",
};

export function createFactChannel({ send }) {
  let turn = null;
  let seq = 0;
  let sessionSingletonId = null;
  const usageEntries = new Set();
  const state = {
    lastAssistantText: "",
    turnUsage: null,
    turnErrorMessage: null,
    completion: null,
    admitted: false,
    runActive: false,
    // Structured evidence of the latest JOURNALED failed assistant attempt
    // in this turn (null until one lands, reset per turn). Classification
    // downstream reads these fields, never the composed error text.
    turnProviderFailure: null,
    // Actual native SDK auto-retry evidence for this turn, mirrored ONLY
    // from the SDK's own auto_retry_start/auto_retry_end events (bounded
    // counters; error text is dropped at the boundary). Null until the
    // native loop actually retries.
    turnAutoRetry: null,
    // Native agent-loop intent to retry the failed run itself (agent_end
    // willRetry). A host must not classify a will-retry attempt as settled.
    willRetry: false,
  };

  function trackEntry(entry) {
    if (entry?.type !== "message") {
      return;
    }
    const message = entry.message;
    if (message?.role === "user") {
      state.lastAssistantText = "";
      return;
    }
    if (message?.role === "assistant") {
      state.lastAssistantText = messageText(message);
      if (turn && message.usage && !usageEntries.has(entry.id)) {
        usageEntries.add(entry.id);
        state.turnUsage ??= {};
        for (const [key, value] of Object.entries(message.usage)) {
          if (typeof value === 'number' && Number.isFinite(value)) state.turnUsage[key] = (state.turnUsage[key] ?? 0) + value;
          else if (key === 'cost' && value && typeof value === 'object') {
            state.turnUsage.cost ??= {};
            for (const [name, amount] of Object.entries(value)) if (typeof amount === 'number' && Number.isFinite(amount)) state.turnUsage.cost[name] = (state.turnUsage.cost[name] ?? 0) + amount;
          }
        }
      }
      // A successful native retry supersedes its failed assistant attempt.
      state.turnErrorMessage = typeof message.errorMessage === 'string' ? message.errorMessage : message.stopReason === 'error' ? 'Pi provider ended with an error' : null;
      if (message.stopReason === "error") {
        state.turnProviderFailure = providerFailureOf(message);
      } else if (message.stopReason === "stop" || message.stopReason === "toolUse") {
        state.turnProviderFailure = null;
      }
    }
  }

  function entryFrame(event) {
    const frame = { event: "entry", seq: (seq += 1), entry: toJson(event.entry) };
    frame.sessionId = turn?.sessionId ?? sessionSingletonId;
    if (turn?.requestId) {
      frame.requestId = turn.requestId;
      if (turn.jobId !== undefined) {
        frame.jobId = turn.jobId;
      }
    }
    if (turn?.turnId) {
      frame.turnId = turn.turnId;
    }
    send(frame);
    trackEntry(event.entry);
  }

  function native(eventData) {
    send({ event: "native", eventData });
  }

  // Host-authored delivery/compaction facts: metadata only (identities,
  // digests, byte counts, phases). Never user text, material bodies, or
  // projection envelopes — those stay inspectable at the host, not in logs.
  function delivery(eventData) {
    const frame = { event: "native", eventData: { ...eventData } };
    frame.eventData.sessionId ??= turn?.sessionId ?? sessionSingletonId ?? undefined;
    if (turn?.turnId) frame.eventData.turnId ??= turn.turnId;
    if (turn?.requestId && frame.eventData.type !== 'nozeliCompaction') frame.eventData.requestId ??= turn.requestId;
    send(frame);
  }

  function onNativeSessionEvent(sessionRef, event) {
    const sessionId = sessionRef?.sessionId;
    if (sessionSingletonId && sessionId && sessionSingletonId !== sessionId) return;
    sessionSingletonId ??= sessionId;
    const turnId = turn?.turnId;
    switch (event?.type) {
      case "entry_appended":
        entryFrame(event);
        return;
      case "message_start":
      case "message_update":
      case "message_end": {
        if (turn && event.type === 'message_start') turn.streamId = turn.requestId + ':' + (turn.streamSequence = (turn.streamSequence ?? 0) + 1);
        const eventData = {
          type: MESSAGE_EVENT_NAMES[event.type],
          projected: true,
          message: toJson(event.message),
        };
        if (turn?.streamId) eventData.streamId = turn.streamId;
        if (sessionId) eventData.sessionId = sessionId;
        if (turnId) eventData.turnId = turnId;
        if (event.type === "message_update" && event.assistantMessageEvent) {
          eventData.assistantEvent = toJson(event.assistantMessageEvent);
        }
        native(eventData);
        return;
      }
      case "tool_execution_start": {
        const eventData = {
          type: "toolExecutionStarted",
          callId: event.toolCallId,
          tool: event.toolName,
          arguments: toJson(event.args ?? {}),
        };
        if (sessionId) eventData.sessionId = sessionId;
        if (turnId) eventData.turnId = turnId;
        native(eventData);
        return;
      }
      case "tool_execution_update": {
        const eventData = {
          type: "toolExecutionUpdated",
          callId: event.toolCallId,
          tool: event.toolName,
          partialResult: toJson(event.partialResult ?? null),
        };
        if (event.parentToolCallId) eventData.parentToolCallId = event.parentToolCallId;
        if (sessionId) eventData.sessionId = sessionId;
        if (turnId) eventData.turnId = turnId;
        native(eventData);
        return;
      }
      case "tool_execution_end": {
        const eventData = {
          type: "toolExecutionEnded",
          callId: event.toolCallId,
          tool: event.toolName,
          result: toJson(event.result ?? null),
          isError: event.isError === true,
        };
        if (event.durationMs !== undefined) eventData.durationMs = event.durationMs;
        if (event.parentToolCallId) eventData.parentToolCallId = event.parentToolCallId;
        if (sessionId) eventData.sessionId = sessionId;
        if (turnId) eventData.turnId = turnId;
        native(eventData);
        return;
      }
      case "turn_start":
      case "turn_end": {
        const eventData = { type: event.type === "turn_start" ? "turnStarted" : "turnEnded" };
        if (sessionId) eventData.sessionId = sessionId;
        if (turnId) eventData.turnId = turnId;
        if (event.type === "turn_end") {
          eventData.message = toJson(event.message);
          eventData.toolResults = toJson(event.toolResults ?? []);
        }
        native(eventData);
        return;
      }
      case "agent_start": {
        state.runActive = true;
        if (turn && !state.admitted && turn.requestId) {
          state.admitted = true;
          const frame = { event: "admitted", requestId: turn.requestId };
          if (sessionId) frame.sessionId = sessionId;
          if (turnId) frame.turnId = turnId;
          send(frame);
        }
        const eventData = { type: "agent_start" };
        if (sessionId) eventData.sessionId = sessionId;
        if (turnId) eventData.turnId = turnId;
        native(eventData);
        return;
      }
      case "agent_end": {
        const eventData = { type: "agent_end", messages: toJson(event.messages ?? []) };
        if (event.willRetry !== undefined) eventData.willRetry = event.willRetry;
        if (event.willRetry !== undefined) state.willRetry = event.willRetry === true;

        if (sessionId) eventData.sessionId = sessionId;
        if (turnId) eventData.turnId = turnId;
        native(eventData);
        return;
      }
      case "agent_settled": {
        state.runActive = false;
        if (turn && !turn.settled) {
          turn.settled = true;
          turn.aborted = event.aborted === true;
          if (state.completion === null) {
            state.completion = event.aborted ? "aborted" : "complete";
          }
          turn.notifySettled?.();
        }
        const eventData = { type: "runSettled", aborted: event.aborted === true };
        if (sessionId) eventData.sessionId = sessionId;
        if (turnId) eventData.turnId = turnId;
        native(eventData);
        return;
      }
      case "compaction_start": {
        state.compactionActive = true;
        const eventData = { type: "compactionStarted", reason: event.reason ?? null };
        if (sessionId) eventData.sessionId = sessionId;
        if (turnId) eventData.turnId = turnId;
        native(eventData);
        return;
      }
      case "compaction_end": {
        state.compactionActive = false;
        const eventData = {
          type: "compactionEnded",
          reason: event.reason ?? null,
          aborted: event.aborted === true,
          ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
        };
        if (sessionId) eventData.sessionId = sessionId;
        if (turnId) eventData.turnId = turnId;
        native(eventData);
        return;
      }
      case "auto_retry_start":
      case "auto_retry_end": {
        // Typed native SDK auto-retry facts, sanitized for the host's
        // recordNativeRetry pipeline: the NATIVE typed event name is
        // forwarded UNCHANGED (auto_retry_start / auto_retry_end) and the
        // payload is bounded counters ONLY (attempt/maxAttempts/delayMs/
        // success) — the SDK's errorMessage/finalError display strings and
        // anything else on the event never cross this boundary. Bound to the
        // EXACT current turn identity (requestId/jobId) so the host can
        // attribute the retry to its owning job without guessing from timing.
        const attempt = boundedCount(event.attempt);
        if (attempt === null) return;
        const started = event.type === "auto_retry_start";
        const maxAttempts = boundedCount(event.maxAttempts);
        const delayMs = boundedCount(event.delayMs);
        const eventData = started
          ? { type: "auto_retry_start", attempt, ...(maxAttempts !== null ? { maxAttempts } : {}), ...(delayMs !== null ? { delayMs } : {}) }
          : { type: "auto_retry_end", attempt, success: event.success === true };
        if (sessionId) eventData.sessionId = sessionId;
        if (turnId) eventData.turnId = turnId;
        if (turn?.requestId) {
          eventData.requestId = turn.requestId;
          if (turn.jobId !== undefined) eventData.jobId = turn.jobId;
        }
        state.turnAutoRetry = {
          attempt,
          ...(maxAttempts !== null ? { maxAttempts } : {}),
          ...(delayMs !== null ? { delayMs } : {}),
          ...(!started ? { success: event.success === true } : {}),
        };
        native(eventData);
        return;
      }
      default: {
        // thinking_level_changed, session_info_changed, summarization_retry_*,
        // bash_execution_update, queue_update (never expected: the worker
        // never steers or queues). auto_retry_* are handled above, typed.
        const eventData = toJson(event);
        if (sessionId) eventData.sessionId = sessionId;
        if (turnId) eventData.turnId = turnId;
        native(eventData);
        return;
      }
    }
  }

  function beginTurn(nextTurn) {
    turn = nextTurn;
    usageEntries.clear();
    state.lastAssistantText = "";
    state.turnUsage = null;
    state.turnErrorMessage = null;
    state.turnProviderFailure = null;
    state.turnAutoRetry = null;
    state.willRetry = false;
    state.completion = null;
    state.admitted = false;
    state.runActive = false;
    state.compactionActive = false;
  }

  function endTurn() {
    turn = null;
  }

  function failTurn(message) {
    state.turnErrorMessage = message;
    state.completion = "error";
  }

  return {
    setSessionId: value => { sessionSingletonId = value; },
    onNativeSessionEvent,
    delivery,
    beginTurn,
    endTurn,
    failTurn,
    state,
    isCompacting: () => state.compactionActive === true,
    currentSeq: () => seq,
    isRunActive: () => state.runActive,
  };
}
