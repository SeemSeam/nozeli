import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createNativeQuestionBridge } from '../../../integrations/pi/src/questions.mjs';

const single = {
  id: 'scope', question: '选择范围？', header: '范围', recommended: 0,
  options: [{ label: '本节', description: '当前章节', preview: '**当前章节**' }, { label: '全文' }],
};
const multiple = { id: 'formats', question: '输出格式？', multi: true, options: [{ label: 'PDF' }, { label: 'HTML' }] };
const answer = (selectedOptions = ['本节'], extra = {}) => ({ kind: 'submit', results: [{ id: 'scope', selectedOptions, ...extra }] });
const decode = result => {
  assert.deepEqual(Object.keys(result), ['content']);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
};
function fixture(send) {
  const events = [];
  const bridge = createNativeQuestionBridge({ send: frame => { events.push(frame); send?.(frame); } });
  const [tool] = bridge.definitions();
  const invoke = (questions = [single], signal) => tool.execute('sdk-call', { i: '确认范围', questions }, signal);
  return { bridge, tool, events, invoke };
}


test('ask preserves presentation and captured job identity, normalizing full typed answers', async () => {
  const { bridge, invoke, events } = fixture();
  const turn = { requestId: 'request-1', jobId: 'background-job', sessionId: 'research-role' };
  bridge.setTurn(turn);
  turn.jobId = 'mutated';
  const result = invoke([single, multiple]);
  const { interaction } = events[0];
  assert.deepEqual(interaction, {
    id: interaction.id, method: 'askDialog', title: '选择范围？；输出格式？',
    question: { method: 'askDialog', title: '选择范围？；输出格式？', questions: [single, multiple] },
    capability: { respond: true, cancel: true }, requestId: 'request-1', jobId: 'background-job', sessionId: 'research-role',
  });
  bridge.setTurn({ requestId: 'new-request', jobId: 'new-job', sessionId: 'other-role' });
  assert.equal(bridge.resolveReverse(interaction.id, { answer: {
    kind: 'submit', results: [
      { id: 'formats', selectedOptions: ['HTML', 'PDF'], customInput: '另附源文件', note: '保留目录' },
      { id: 'scope', question: 'forged', options: ['forged'], multi: true, selectedOptions: [], customInput: '摘要', note: '只改摘要' },
    ],
  } }), true);
  assert.deepEqual(decode(await result), { kind: 'submit', results: [
    { id: 'scope', question: single.question, options: ['本节', '全文'], multi: false, selectedOptions: [], customInput: '摘要', note: '只改摘要' },
    { id: 'formats', question: multiple.question, options: ['PDF', 'HTML'], multi: true, selectedOptions: ['HTML', 'PDF'], customInput: '另附源文件', note: '保留目录' },
  ] });
  assert.deepEqual(events[1], {
    event: 'interaction_closed', reason: 'submit',
    interaction: { id: interaction.id, method: 'askDialog', requestId: 'request-1', jobId: 'background-job', sessionId: 'research-role' },
  });
  assert.equal(bridge.pendingCount(), 0);
});

test('invalid response RPCs retain the pending question and do not unblock the tool', async () => {
  const { bridge, invoke, events } = fixture();
  let settled = false;
  const result = invoke().then(value => { settled = true; return value; });
  const id = events[0].interaction.id;
  const invalid = [
    undefined, '本节', { kind: 'submit' }, { kind: 'submit', results: [] },
    { kind: 'submit', results: [null] },
    { kind: 'submit', results: [{ id: 'wrong', selectedOptions: ['本节'] }] },
    { kind: 'submit', results: [{ id: 'scope', selectedOptions: '本节' }] },
    answer(['missing']), answer(['本节', '本节']), answer(['本节', '全文']),
    answer([]), answer([], { customInput: '  ' }),
    answer(['本节'], { customInput: 'other' }),
    answer(['本节'], { customInput: 1 }), answer(['本节'], { note: false }),
    { kind: 'cancelled' }, { kind: 'unknown' },
  ];
  for (const value of invalid) {
    assert.throws(() => bridge.resolveReverse(id, { answer: value }), { code: 'INTERACTION_ANSWER_INVALID' });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(bridge.pendingCount(), 1);
    assert.equal(events.length, 1);
  }
  assert.throws(() => bridge.resolveReverse(id, { error: { message: 'not an answer' } }), { code: 'INTERACTION_ANSWER_INVALID' });
  bridge.resolveReverse(id, { answer: answer(['本节'], { customInput: ' ', note: '' }) });
  assert.deepEqual(decode(await result).results[0].selectedOptions, ['本节']);
});

test('duplicate result IDs and duplicate source question IDs obey frozen validation', async () => {
  for (const questions of [[single, multiple], [single, single]]) {
    const { bridge, invoke, events } = fixture();
    const result = invoke(questions);
    assert.throws(() => bridge.resolveReverse(events[0].interaction.id, { answer: {
      kind: 'submit', results: [answer().results[0], answer().results[0]],
    } }), { code: 'INTERACTION_ANSWER_INVALID' });
    assert.equal(bridge.pendingCount(), 1);
    bridge.cancelAll();
    assert.equal(decode(await result), 'cancelled');
  }
});

test('multi permits empty selection but still rejects duplicate and unknown options', async () => {
  const { bridge, invoke, events } = fixture();
  const result = invoke([multiple]);
  const id = events[0].interaction.id;
  for (const selectedOptions of [['PDF', 'PDF'], ['unknown']]) {
    assert.throws(() => bridge.resolveReverse(id, { answer: { kind: 'submit', results: [{ id: 'formats', selectedOptions }] } }), { code: 'INTERACTION_ANSWER_INVALID' });
  }
  bridge.resolveReverse(id, { answer: { kind: 'submit', results: [{ id: 'formats', selectedOptions: [] }] } });
  assert.deepEqual(decode(await result).results[0], {
    id: 'formats', question: multiple.question, options: ['PDF', 'HTML'], multi: true, selectedOptions: [],
  });
});

test('chat and cancel return explicit non-terminating results with no fabricated selection or extra effects', async () => {
  for (const [payload, expected, reason] of [
    [{ answer: { kind: 'chat', results: answer().results } }, { kind: 'chat' }, 'chat'],
    [{ cancel: true, answer: answer() }, 'cancelled', 'cancelled'],
  ]) {
    const { bridge, invoke, events } = fixture();
    const result = invoke();
    bridge.resolveReverse(events[0].interaction.id, payload);
    assert.deepEqual(decode(await result), expected);
    assert.deepEqual(events.map(event => event.event), ['interaction', 'interaction_closed']);
    assert.equal(events[1].reason, reason);
  }
});

test('SDK abort closes the exact interaction, detaches listeners, and ignores stale answers', async () => {
  const { bridge, invoke, events } = fixture();
  const abort = new AbortController();
  const result = invoke([single], abort.signal);
  const id = events[0].interaction.id;
  assert.equal(getEventListeners(abort.signal, 'abort').length, 1);
  abort.abort();
  assert.equal(decode(await result), 'cancelled');
  assert.equal(events[1].event, 'interaction_closed');
  assert.equal(events[1].interaction.id, id);
  assert.equal(events[1].reason, 'cancelled');
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  assert.equal(bridge.resolveReverse(id, { answer: answer() }), false);
  bridge.cancelAll();
  assert.equal(events.length, 2);
});

test('already-aborted SDK call never opens a question', async () => {
  const { bridge, invoke, events } = fixture();
  const abort = new AbortController();
  abort.abort();
  assert.equal(decode(await invoke([single], abort.signal)), 'cancelled');
  assert.equal(bridge.pendingCount(), 0);
  assert.deepEqual(events.map(event => event.event), ['interaction_closed']);
});

test('normal submission removes the abort listener and later abort has no effect', async () => {
  const { bridge, invoke, events } = fixture();
  const abort = new AbortController();
  const result = invoke([single], abort.signal);
  bridge.resolveReverse(events[0].interaction.id, { answer: answer() });
  await result;
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  abort.abort();
  assert.equal(events.length, 2);
});

test('stale and cross-bridge IDs cannot answer a different question; cancelAll is idempotent', async () => {
  const first = fixture(), second = fixture();
  const a = first.invoke(), b = first.invoke(), c = second.invoke();
  const [idA, idB] = first.events.map(event => event.interaction.id);
  const idC = second.events[0].interaction.id;
  assert.equal(new Set([idA, idB, idC]).size, 3);
  assert.equal(second.bridge.resolveReverse(idA, { answer: answer() }), false);
  assert.equal(first.bridge.resolveReverse(idC, { answer: answer() }), false);
  first.bridge.resolveReverse(idA, { answer: answer() });
  await a;
  assert.equal(first.bridge.resolveReverse(idA, { answer: answer() }), false);
  assert.equal(first.bridge.pendingCount(), 1);
  first.bridge.cancelAll();
  first.bridge.cancelAll();
  assert.equal(decode(await b), 'cancelled');
  assert.equal(second.bridge.pendingCount(), 1);
  second.bridge.cancelAll();
  assert.equal(decode(await c), 'cancelled');
  assert.equal(first.events.filter(event => event.event === 'interaction_closed').length, 2);
});

test('pending registration precedes publication so synchronous host answers cannot be lost', async () => {
  let bridge;
  ({ bridge } = fixture(frame => {
    if (frame.event === 'interaction') bridge.resolveReverse(frame.interaction.id, { answer: answer() });
  }));
  const result = await bridge.definitions()[0].execute('call', { i: '确认范围', questions: [single] });
  assert.equal(decode(result).kind, 'submit');
  assert.equal(bridge.pendingCount(), 0);
});

test('clearing turn removes prior routing identity and transport failures release pending state', async () => {
  const { bridge, invoke, events } = fixture();
  bridge.setTurn({ sessionId: 'old-role', jobId: 'old-job', requestId: 'old-request' });
  bridge.setTurn(null);
  const result = invoke();
  for (const field of ['sessionId', 'jobId', 'requestId']) assert.equal(events[0].interaction[field], undefined);
  bridge.cancelAll();
  await result;
  const broken = fixture(() => { throw Error('transport closed'); });
  const abort = new AbortController();
  await assert.rejects(broken.invoke([single], abort.signal), /transport closed/);
  assert.equal(broken.bridge.pendingCount(), 0);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});
