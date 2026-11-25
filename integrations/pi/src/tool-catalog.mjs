// Owner-local authority and wire evidence for the pinned Pi SDK. No prompt,
// tool arguments, provider credentials or raw declarations enter telemetry.
import { createHash } from 'node:crypto';
import { getCurrentTools } from '@earendil-works/pi-ai';
import { importedSkillError } from './context-delivery.mjs';

const MAX_TOOLS = 64;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ID = /^[A-Za-z0-9:_-]{1,80}$/;
const wireApis = new Set(['openai-completions', 'openai-responses', 'azure-openai-responses',
  'openai-codex-responses', 'anthropic-messages', 'mistral-conversations', 'google-generative-ai',
  'google-vertex', 'bedrock-converse-stream', 'pi-messages']);

export const opaqueId = value => typeof value === 'string' && ID.test(value) ? value : null;
export function catalogError(code = 'PI_TOOL_CATALOG_MISMATCH') {
  return Object.assign(Error(code === 'PI_TOOL_CATALOG_UNSAFE'
    ? 'Pi owner tool state is not safe to reuse'
    : 'Pi tool catalog does not match the authorized turn'), { code, failureOrigin: 'runtime' });
}

// Object order is not schema identity; array order (including alternatives)
// is preserved. Ignore properties that wouldn't survive JSON serialization.
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value, (_key, member) => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) return member;
    return Object.fromEntries(Object.keys(member).sort().map(key => [key, member[key]]));
  })).digest('hex');
}

function catalog(tools, schema, name = tool => tool.name) {
  if (!Array.isArray(tools) || tools.length > MAX_TOOLS) throw catalogError();
  const names = new Set();
  const definitions = tools.map(tool => {
    const id = name(tool);
    const parameters = schema(tool);
    if (typeof id !== 'string' || !TOOL_NAME.test(id) || names.has(id) ||
        !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw catalogError();
    names.add(id);
    return Object.freeze({ name: id, schemaDigest: digest(parameters) });
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return Object.freeze({ tools: Object.freeze(definitions), digest: digest(definitions) });
}

export const toolCatalog = tools => catalog(tools, tool => ({
  description: tool.description, parameters: tool.parameters, constrainedSampling: tool.constrainedSampling,
}));

export function installCatalog(session, expected) {
  session.setActiveToolsByName(expected.tools.map(tool => tool.name));
  if (toolCatalog(session.agent.state.tools).digest !== expected.digest) throw catalogError();
}

// Keep journal history passively visible, but never send old *tool declarations*
// as part of it. Pinned Pi otherwise serializes system tool deltas as native
// Anthropic addition/removal blocks, Responses additional_tools/tool_search,
// or Chat system-message tools. Rebase the verified current tool set on the
// leading system message, before any adapter translates the transcript.
function fixedDeclarations(context, expected) {
  const tools = getCurrentTools(context.messages);
  if (toolCatalog(tools).digest !== expected.digest) throw catalogError();
  const messages = context.messages.map(message => {
    if (message.role !== 'system' || !('toolsAdded' in message || 'toolsRemoved' in message)) return message;
    const { toolsAdded, toolsRemoved, ...rest } = message;
    return rest;
  });
  if (tools.length) {
    if (messages[0]?.role === 'system') messages[0] = { ...messages[0], toolsAdded: tools };
    else messages.unshift({ role: 'system', content: '', timestamp: 0, toolsAdded: tools });
  }
  return { ...context, messages };
}

function transcript(api, payload) {
  switch (api) {
    case 'google-vertex': case 'google-generative-ai': return payload.contents;
    case 'openai-responses': case 'azure-openai-responses': case 'openai-codex-responses': return payload.input;
    case 'pi-messages': return payload.context?.messages;
    default: return payload.messages;
  }
}

function verifyImportedSkill(messages, skill, inference) {
  // Only user-facing text is delivery evidence. A digest in a header, tool
  // argument, or model response cannot satisfy this check. Check the entire
  // attempt-specific envelope after SDK serialization and extension transforms.
  let exact = 0;
  let markers = 0;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const content = message.content ?? message.parts;
    const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content
      .filter(block => block && typeof block.text === 'string' &&
        (block.type === undefined || block.type === 'text' || block.type === 'input_text'))
      .map(block => block.text) : [];
    for (const text of texts) {
      if (text.includes(skill.envelopeText)) exact++;
      // The complete envelope has exactly two occurrences (open/close).
      for (let at = text.indexOf(skill.marker); at >= 0; at = text.indexOf(skill.marker, at + skill.marker.length)) markers++;
    }
  }
  if (inference ? exact !== 1 || markers !== 2 : markers !== 0) {
    throw importedSkillError('PI_IMPORTED_SKILL_UNVERIFIED', 'Outbound payload did not match the imported skill delivery contract');
  }
}

function immutableWireCatalog(api, payload, expected) {
  if (!wireApis.has(api) || !payload || typeof payload !== 'object') throw catalogError();
  // The adapters can introduce their own wire-level shapes (strict/cache
  // metadata, OAuth capitalization, etc.). Take the first digest from the
  // pinned adapter, then verify the exact definitions again after extension
  // transforms. No later request may add declarations in history.
  let tools = payload.tools ?? [];
  let placeholder = null;
  let schema = tool => tool.parameters;
  let declaration = tool => tool;
  if (api === 'openai-completions' || api === 'mistral-conversations') {
    if (payload.functions !== undefined || payload.function_call !== undefined) throw catalogError();
    declaration = tool => tool.type === 'function' ? tool.function : null;
  } else if (api === 'anthropic-messages') {
    schema = tool => tool.input_schema;
    if (!Array.isArray(tools)) throw catalogError();
    // Anthropic's native incrementals add this provider-private, never
    // activated declaration even if this request includes no tool deltas.
    tools = tools.filter(tool => {
      if (tool?.name !== '__pi_deferred_placeholder__') {
        if (tool?.defer_loading) throw catalogError();
        return true;
      }
      if (placeholder || tool.defer_loading !== true || !expected.tools.length ||
          tool.description !== 'Reserved placeholder. Never available. Never call this.' ||
          digest(tool.input_schema ?? null) !== digest({type:'object', properties:{}, required:[]})) throw catalogError();
      placeholder = digest(tool);
      return false;
    });
  } else if (api === 'bedrock-converse-stream') {
    tools = payload.toolConfig?.tools ?? [];
    declaration = tool => tool.toolSpec;
    schema = tool => tool.inputSchema?.json;
  } else if (api === 'google-generative-ai' || api === 'google-vertex') {
    const groups = payload.config?.tools ?? [];
    if (payload.config?.httpOptions?.extraBody != null || !Array.isArray(groups) || groups.some(group =>
      !group || Object.keys(group).length !== 1 || !Array.isArray(group.functionDeclarations))) throw catalogError();
    tools = groups.flatMap(group => group.functionDeclarations);
    schema = tool => tool.parametersJsonSchema ?? tool.parameters;
  } else if (api === 'pi-messages') {
    tools = getCurrentTools(payload.context.messages);
  } else {
    declaration = tool => tool.type === 'function' && tool.defer_loading !== true ? tool : null;
  }
  if (['openai-responses','azure-openai-responses','openai-codex-responses'].includes(api) &&
      (payload.previous_response_id != null || payload.conversation != null)) throw catalogError();
  const messages = transcript(api, payload);
  if (!Array.isArray(messages) || messages.some((message, index) =>
    message.tools !== undefined || ['additional_tools', 'tool_search_output'].includes(message.type) ||
    (message.toolsAdded !== undefined && (api !== 'pi-messages' || index !== 0)) ||
    message.toolsRemoved !== undefined || [message.content, message.parts].some(blocks => Array.isArray(blocks) &&
      blocks.some(block => ['tool_addition', 'tool_removal'].includes(block.type))))) throw catalogError();
  const expectedNames = new Set(expected.tools.map(tool => tool.name));
  const result = catalog(tools, tool => {
    const def = declaration(tool);
    if (!def || !schema(def) || typeof schema(def) !== 'object' || Array.isArray(schema(def))) throw catalogError();
    return def;
  }, tool => {
    const name = declaration(tool)?.name;
    if (api === 'anthropic-messages' && typeof name === 'string' && !expectedNames.has(name)) {
      const lower = name.toLowerCase();
      if (expectedNames.has(lower)) return lower;
    }
    return name;
  });
  if (result.tools.length !== expected.tools.length || result.tools.some(tool => !expectedNames.has(tool.name))) throw catalogError();
  const choice = payload.tool_choice ?? payload.toolChoice ?? payload.toolConfig?.toolChoice ??
    payload.config?.toolConfig ?? payload.options?.toolChoice ?? null;
  return { ...result, choiceDigest: digest([choice, placeholder]) };
}

const EMPTY = toolCatalog([]);

export function guardProviderStream(session, { currentTurn, canSummarize, observe }) {
  const agent = session.agent;
  const stream = agent.streamFunction;
  agent.streamFunction = async (model, context, options) => {
    const turn = currentTurn();
    const inference = options?.sessionId === session.sessionManager.getSessionId();
    const expected = inference ? turn?.toolCatalog : EMPTY;
    const reject = (error = catalogError()) => {
      if (turn) turn.catalogFailure ??= error;
      throw error;
    };
    if (!expected || (inference ? turn.settled || turn.catalogFailure : !canSummarize())) reject();
    let checked;
    try {
      if (!wireApis.has(model.api)) reject();
      checked = fixedDeclarations(context, expected);
      if (turn?.importedSkill) verifyImportedSkill(checked.messages, turn.importedSkill, inference);
    } catch (error) { reject(error?.code === 'PI_IMPORTED_SKILL_UNVERIFIED' ? error : catalogError()); }
    const transform = options?.onPayload;
    // Use complete top-level tools for Responses, not server-side incremental state.
    const wireModel = ['openai-responses','azure-openai-responses','openai-codex-responses'].includes(model.api)
      ? {...model, compat:{...model.compat, supportsAdditionalTools:false, supportsToolSearch:false}} : model;
    return stream(wireModel, checked, {
      ...options,
      // Codex websocket continuation can reuse server-side state after
      // onPayload. Managed turns must send the complete verified declaration.
      ...(model.api === 'openai-codex-responses' ? {transport:'sse'} : {}),
      onPayload: async (payload, wireModel) => {
        try {
          if (wireModel.api !== model.api || currentTurn() !== turn || turn?.settled || turn?.catalogFailure) reject();
          const before = immutableWireCatalog(model.api, payload, expected);
          const transformed = (await transform?.(payload, wireModel)) ?? payload;
          // Adapters can reuse the payload across retries. The transform must not own it.
          const result = transform ? structuredClone(transformed) : transformed;
          const after = immutableWireCatalog(model.api, result, expected);
          if (before.digest !== after.digest || before.choiceDigest !== after.choiceDigest) reject();
          if (currentTurn() !== turn || turn?.settled || turn?.catalogFailure) reject();
          if (turn?.importedSkill) verifyImportedSkill(transcript(model.api, result), turn.importedSkill, inference);
          observe(turn, inference ? 'inference' : 'compaction', model.api, after);
          return result;
        } catch (error) { reject(error?.code === 'PI_IMPORTED_SKILL_UNVERIFIED' ? error : catalogError()); }
      },
    });
  };
}
