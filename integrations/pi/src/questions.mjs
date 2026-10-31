/**
 * Native Pi ask tool, using the frozen OMP ask schema and askDialog answer contract.
 * Unlike host-control tools, its normal result never terminates the model turn.
 * All settlements publish interaction_closed with the original routing identity;
 * the session owner must remove only that interaction, including on SDK abort.
 * Routing remains host-owned: this bridge does not promote background questions
 * to user questions, start new prompts, or coerce answers through OAuth text UI.
 */
import { randomUUID } from 'node:crypto';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const parameters = {
  type: 'object',
  properties: {
    i: { type: 'string', description: 'concise intent' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
                preview: { type: 'string', description: 'rich preview' },
              },
              required: ['label'],
              additionalProperties: false,
            },
          },
          header: { type: 'string', description: 'display chip' },
          multi: { type: 'boolean' },
          recommended: { type: 'number', description: '0-based default index' },
        },
        required: ['id', 'question', 'options'],
        additionalProperties: false,
      },
      minItems: 1,
    },
  },
  required: ['questions', 'i'],
  additionalProperties: false,
};

function invalidAnswer() {
  throw Object.assign(new Error('Answer does not match the native question'), {
    code: 'INTERACTION_ANSWER_INVALID',
  });
}

// Keep normalization aligned with frozen omp-terminal-bridge nativeAnswer.
function nativeAnswer(questions, answer) {
  if (answer?.kind === 'chat') return { kind: 'chat' };
  if (answer?.kind !== 'submit' || !Array.isArray(answer.results) || answer.results.length !== questions.length) return invalidAnswer();
  const seen = new Set();
  const results = questions.map(q => {
    const item = answer.results.find(r => r?.id === q.id);
    if (!item || seen.has(item.id) || !Array.isArray(item.selectedOptions)) return invalidAnswer();
    seen.add(item.id);
    const options = q.options.map(o => o.label), selected = item.selectedOptions;
    if (new Set(selected).size !== selected.length || selected.some(s => !options.includes(s)) || (!q.multi && selected.length > 1)) return invalidAnswer();
    if (item.customInput !== undefined && typeof item.customInput !== 'string' || item.note !== undefined && typeof item.note !== 'string') return invalidAnswer();
    if (!q.multi && !selected.length && !item.customInput?.trim()) return invalidAnswer();
    if (!q.multi && selected.length && item.customInput?.trim()) return invalidAnswer();
    return {
      id: q.id, question: q.question, options, multi: q.multi === true,
      selectedOptions: [...selected],
      ...(item.customInput !== undefined ? { customInput: item.customInput } : {}),
      ...(item.note !== undefined ? { note: item.note } : {}),
    };
  });
  return { kind: 'submit', results };
}

export function createNativeQuestionBridge({ send }) {
  const pending = new Map();
  let turn = null;

  const tool = defineTool({
    name: 'ask',
    label: 'ask',
    description: 'Ask structured questions with choices or custom input. The respondent may submit answers, cancel, or continue in free conversation.',
    parameters: Type.Unsafe(parameters),
    execute: async (_toolCallId, params, signal) => {
      const id = `question-${randomUUID()}`;
      const questions = structuredClone(params.questions);
      const title = questions.map(q => q.question || '').join('；');
      const interaction = {
        id, method: 'askDialog', title,
        question: { method: 'askDialog', title, questions },
        capability: { respond: true, cancel: true },
        requestId: turn?.requestId, jobId: turn?.jobId, sessionId: turn?.sessionId,
      };
      return await new Promise((resolve, reject) => {
        const abort = () => settle('cancelled');
        const settle = value => {
          if (!pending.delete(id)) return;
          signal?.removeEventListener('abort', abort);
          try {
            send({
              event: 'interaction_closed',
              interaction: { id, method: 'askDialog', requestId: interaction.requestId, jobId: interaction.jobId, sessionId: interaction.sessionId },
              reason: value === 'cancelled' ? 'cancelled' : value.kind,
            });
            resolve({ content: [{ type: 'text', text: JSON.stringify(value) }] });
          } catch (error) {
            reject(error);
          }
        };
        pending.set(id, { questions, settle });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) {
          abort();
          return;
        }
        try {
          send({ event: 'interaction', interaction });
        } catch (error) {
          pending.delete(id);
          signal?.removeEventListener('abort', abort);
          reject(error);
        }
      });
    },
  });

  return {
    definitions: () => [tool],
    setTurn: nextTurn => { turn = nextTurn == null ? null : { ...nextTurn }; },
    resolveReverse(id, payload) {
      const entry = pending.get(id);
      if (!entry) return false;
      // Validate before consuming the entry: bad RPC answers must be retryable.
      const value = payload?.cancel === true ? 'cancelled' : nativeAnswer(entry.questions, payload?.answer);
      entry.settle(value);
      return true;
    },
    cancelAll() {
      for (const entry of pending.values()) entry.settle('cancelled');
    },
    pendingCount: () => pending.size,
  };
}
