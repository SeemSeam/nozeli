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

  function onNativeSessionEvent(sessionRef, event) {
    const sessionId = sessionRef?.sessionId;
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
      default: {
        // compaction_start/end, thinking_level_changed, session_info_changed,
        // auto_retry_*, summarization_retry_*, bash_execution_update,
        // queue_update (never expected: the worker never steers or queues).
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
    state.completion = null;
    state.admitted = false;
    state.runActive = false;
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
    beginTurn,
    endTurn,
    failTurn,
    state,
    currentSeq: () => seq,
    isRunActive: () => state.runActive,
  };
}
