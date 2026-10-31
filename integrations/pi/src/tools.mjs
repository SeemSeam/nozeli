/**
 * Nozeli-authored. Host tool bridge: exposes the role's tools to Pi as custom
 * ToolDefinitions whose execution is proxied to the Nozeli host over the
 * worker's JSONL IPC (event:"tool" frames answered by bare {id,result|error}
 * replies or the `respond` method).
 *
 * Host-side admission, auth, and side effects stay entirely in the host. The
 * worker mirrors the host's finishOnHostControl rule: a tool result that is
 * neither readOnly nor continueTurn terminates the run after the batch, so the
 * host keeps control instead of the model looping on.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

let reverseCounter = 0;
export function nextReverseId() {
  reverseCounter += 1;
  return `w-${reverseCounter}`;
}

/** Normalize host tool defs ({type:'function',name,description,inputSchema}) to Pi tools. */
export function normalizeHostTools(tools) {
  if (!Array.isArray(tools)) {
    throw Object.assign(new Error("tools must be an array"), { code: "PI_INVALID_PARAMS" });
  }
  const seen = new Set();
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !tool.name) {
      throw Object.assign(new Error("each tool needs a string name"), { code: "PI_INVALID_PARAMS" });
    }
    if (seen.has(tool.name)) {
      throw Object.assign(new Error(`duplicate tool name ${tool.name}`), { code: "PI_INVALID_PARAMS" });
    }
    seen.add(tool.name);
    const schema = tool.inputSchema ?? tool.parameters ?? { type: "object", properties: {} };
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      throw Object.assign(new Error(`tool ${tool.name} parameters must be a JSON Schema object`), {
        code: "PI_INVALID_PARAMS",
      });
    }
    return { name: tool.name, description: tool.description ?? "", parameters: schema };
  });
}

/** Tool names the host exempts from the finish-on-host-control rule. */
const HOST_CONTROL_EXEMPT_TOOLS = new Set(["nozeli_inspect_work"]);

function textBlock(text) {
  return { type: "text", text };
}

function normalizeContentBlock(block) {
  if (!block || typeof block !== "object") {
    return textBlock(String(block));
  }
  if (typeof block.text === "string" && (block.type === undefined || block.type === "text")) {
    return { type: "text", text: block.text };
  }
  if (typeof block.data === "string" && typeof block.mimeType === "string") {
    return { type: "image", data: block.data, mimeType: block.mimeType };
  }
  return textBlock(JSON.stringify(block));
}

function resultToAgentToolResult(toolName, value) {
  if (value == null) {
    return { content: [textBlock("null")] };
  }
  let content;
  if (Array.isArray(value.content)) {
    content = value.content.map(normalizeContentBlock);
  } else if (typeof value.text === "string") {
    content = [textBlock(value.text)];
  } else if (typeof value === "string") {
    content = [textBlock(value)];
  } else {
    content = [textBlock(JSON.stringify(value))];
  }
  const result = { content, isError: value.isError === true };
  const continueTurn =
    value.readOnly === true ||
    value.continueTurn === true ||
    HOST_CONTROL_EXEMPT_TOOLS.has(toolName);
  if (!continueTurn) {
    result.terminate = true;
  }
  return result;
}

function errorToAgentToolResult(error) {
  const code = error?.code ?? "HOST_TOOL_ERROR";
  return {
    content: [textBlock(`tool error ${code}: ${error?.message ?? String(error)}`)],
    isError: true,
    terminate: true,
  };
}

export function createHostToolBridge({ send, onHostControl }) {
  /** id -> { resolve, toolName } */
  const pending = new Map();
  let turn = null;

  function setTurn(nextTurn) {
    turn = nextTurn;
  }

  function definitionsFor(normalizedTools) {
    return normalizedTools.map((tool) =>
      defineTool({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: Type.Unsafe(tool.parameters),
        // A host decision is an ordered execution boundary, not a parallel hint.
        executionMode: "sequential",
        execute: async (toolCallId, params, signal) => {
          const id = nextReverseId();
          const current = turn;
          const frame = { event: "tool", id, callId: toolCallId, tool: tool.name, arguments: params ?? {} };
          if (current) {
            if (current.sessionId) frame.sessionId = current.sessionId;
            frame.turnId = current.turnId;
            if (current.requestId) {
              frame.requestId = current.requestId;
              if (current.jobId !== undefined) frame.jobId = current.jobId;
            }
            if (current.beforeAgentContext !== undefined) frame.beforeAgentContext = current.beforeAgentContext;
          }
          return new Promise((resolve) => {
            const abort = () => {
              if (!pending.has(id)) return;
              send({ event: "tool-cancel", id, callId: toolCallId, requestId: current?.requestId });
              entry.resolve({ content: [textBlock("tool call aborted")], isError: true, terminate: true });
            };
            const entry = {
              toolName: tool.name,
              resolve(value) {
                pending.delete(id);
                signal?.removeEventListener("abort", abort);
                resolve(value);
              },
            };
            pending.set(id, entry);
            if (signal?.aborted) abort();
            else {
              signal?.addEventListener("abort", abort, { once: true });
              send(frame);
            }
          });
        },
      }),
    );
  }

  /** Resolve a pending reverse RPC (tool reply). Returns false when unknown. */
  function resolveReverse(id, payload) {
    const entry = pending.get(id);
    if (!entry) {
      return false;
    }
    if (payload && payload.error) {
      entry.resolve(errorToAgentToolResult(payload.error));
      onHostControl?.({ error: payload.error });
      return true;
    }
    if (payload && payload.cancel === true) {
      entry.resolve({
        content: [textBlock("tool call cancelled by host")],
        isError: true,
        terminate: true,
      });
      onHostControl?.({ cancelled: true });
      return true;
    }
    const result = resultToAgentToolResult(entry.toolName, payload?.result ?? payload?.answer);
    // Resolve first so the native abort cannot replace an already committed receipt.
    entry.resolve(result);
    if (result.terminate === true) onHostControl?.();
    return true;
  }

  return {
    definitionsFor,
    resolveReverse,
    setTurn,
    pendingCount: () => pending.size,
  };
}

/**
 * Interaction bridge: host questions (OAuth prompts, selects) use the same
 * reverse-RPC ids ({event:"interaction"} answered via `respond`).
 */
export function createInteractionBridge({ send }) {
  const pending = new Map();

  function ask(interaction) {
    const id = nextReverseId();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ event: "interaction", interaction: { id, ...interaction } });
    });
  }

  function resolveReverse(id, payload) {
    const entry = pending.get(id);
    if (!entry) {
      return false;
    }
    pending.delete(id);
    if (payload && payload.error) {
      entry.reject(Object.assign(new Error(payload.error.message ?? "interaction failed"), {
        code: payload.error.code ?? "PI_INTERACTION_FAILED",
      }));
      return true;
    }
    if (payload && payload.cancel === true) {
      entry.reject(Object.assign(new Error("interaction cancelled by host"), {
        code: "PI_INTERACTION_CANCELLED",
      }));
      return true;
    }
    const answer = payload?.answer;
    const text =
      typeof answer === "string" ? answer : typeof answer?.text === "string" ? answer.text : answer == null ? "" : String(answer);
    entry.resolve(text);
    return true;
  }

  return { ask, resolveReverse, pendingCount: () => pending.size, cancelAll: () => { for (const id of [...pending.keys()]) resolveReverse(id, {cancel:true}); } };
}
