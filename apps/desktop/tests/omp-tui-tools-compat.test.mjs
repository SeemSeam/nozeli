import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OmpTuiSession } from '../src/agents/managed/omp-tui-session.mjs';
import { deployOmpTerminalBridge, connectOmpTerminalBridge } from '../src/agents/managed/omp-terminal-bridge.mjs';

const tool = (parameters, extra = {}) => ({ name: 'nozeli_resume_probe', description: 'old description', parameters, ...extra });
const object = value => ({ type: 'object', properties: { value }, required: ['value'], additionalProperties: false });
const oldSchema = object({ type: ['string', 'null'] });
const nextSchema = object({ anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Explicit JSON null.' });

async function fixture(t, oldTools, nextTools, { legacy = false, unsafe = schema => schema, beforeHello = () => {} } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'omp-tools-compat-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const old = new OmpTuiSession({ home, tools: oldTools });
  const previous = await deployOmpTerminalBridge(home, { tools: oldTools });
  if (legacy) {
    // Legacy releases have no manifest; recover only the known generated literal.
    await rm(path.join(home, 'nozeli-terminal-tools-history.json'));
    const source = await readFile(previous.bridgePath, 'utf8');
    assert.match(source, /const toolDefs = \[/);
  }
  const deployed = await deployOmpTerminalBridge(home, { tools: nextTools });
  const handlers = {}, registered = [];
  const pi = {
    on: (name, fn) => { handlers[name] = fn; },
    registerTool: def => registered.push(def),
    getAllTools: () => { beforeHello(registered); return registered.map(({ name }) => ({ name })); },
    typebox: { Type: { Unsafe: unsafe } },
  };
  (await import(pathToFileURL(deployed.bridgePath))).default(pi);
  const bridge = connectOmpTerminalBridge(deployed);
  t.after(async () => { await bridge.close(); handlers.session_shutdown(); });
  const session = new OmpTuiSession({ home, tools: nextTools });
  session.deployed = deployed;
  for (let attempt = 0; ; attempt++) {
    try { session.helloState = await bridge.hello(); break; }
    catch (error) { if (attempt >= 100 || !['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  session.threadId = 'existing-thread';
  session.sessionFile = '/existing/journal.jsonl';
  return { session, old, deployed, home, registered };
}

test('legacy source + real bridge prove description/nullable equivalence without replacing thread or replay', async t => {
  const { session, old, registered } = await fixture(t, [tool(oldSchema)], [tool(nextSchema, { description: 'updated description' })], { legacy: true });
  assert.deepEqual(session.helloState.registeredTools[0].parameters, registered[0].parameters);
  session.assertToolsDigest(old.toolsDigest);
  assert.equal(session.threadId, 'existing-thread');
  assert.equal(session.sessionFile, '/existing/journal.jsonl');
  assert.equal(session.promptsDelivered, 0);
  assert.equal(session.hasPrompted, false);
});

test('callable Type.Unsafe schemas use official toJsonSchema rather than disappearing from bridge JSON', async t => {
  const unsafe = schema => Object.assign(() => {}, { toJsonSchema: () => structuredClone(schema), ir: { internal: true } });
  const { session, old, registered } = await fixture(t, [tool(oldSchema)], [tool(nextSchema)], { unsafe });
  assert.equal(typeof registered[0].parameters, 'function');
  assert.deepEqual(session.helloState.registeredTools[0].parameters, nextSchema);
  assert.equal(session.helloState.toolsDigest, session.toolsDigest);
  session.assertToolsDigest(old.toolsDigest);
});

test('late in-place normalization of a callable shared wire document keeps receipt digest exact', async t => {
  const unsafe = schema => {
    const shared = structuredClone(schema);
    return Object.assign(() => {}, { toJsonSchema: () => shared });
  };
  const beforeHello = registered => {
    const value = registered[0].parameters.toJsonSchema().properties.value;
    delete value.anyOf;
    value.type = ['string', 'null'];
  };
  const { session, old } = await fixture(t, [tool(oldSchema)], [tool(nextSchema)], { unsafe, beforeHello });
  assert.notEqual(session.helloState.toolsDigest, session.toolsDigest, 'wire normalization changes raw digest');
  assert.deepEqual(session.helloState.registeredTools[0].parameters.properties.value.type, ['string', 'null']);
  session.assertToolsDigest(old.toolsDigest);
  session.helloState.toolsDigest = 'forged';
  assert.throws(() => session.assertToolsDigest(old.toolsDigest), /bridge-receipt-digest/);
});

test('trusted additions preserve historical digest proof, original thread and zero prompt delivery', async t => {
  const added = { type: 'object', properties: { ...nextSchema.properties, dangerousEffect: { type: 'string' } }, required: ['value'], additionalProperties: false };
  const { session, old, deployed } = await fixture(t, [tool(oldSchema)], [tool(added), { ...tool(nextSchema), name: 'nozeli_maintenance' }]);
  // Failing-before witness: whole-tool-list equivalence rejects both supported
  // release changes, despite every old argument retaining its exact contract.
  assert.notDeepEqual(deployed.toolHistory[0], session.helloState.registeredTools);
  await session.preflightToolsDigest(old.toolsDigest);
  session.assertToolsDigest(old.toolsDigest);
  assert.equal(session.threadId, 'existing-thread');
  assert.equal(session.sessionFile, '/existing/journal.jsonl');
  assert.equal(session.promptsDelivered, 0);
  assert.equal(session.hasPrompted, false);
  assert(deployed.toolHistory.some(tools => JSON.stringify(tools) === JSON.stringify([tool(oldSchema)])), 'old manifest retained');
});

for (const [name, next] of [
  ['renamed tool', [tool(nextSchema, { name: 'nozeli_other' })]],
  ['changed approval', [tool(nextSchema, { approval: 'write' })]],
  ['removed tool', []],
  ['new required field', [tool({ ...nextSchema, properties: { ...nextSchema.properties, extra: { type: 'string' } }, required: ['value', 'extra'] })]],
  ['broader type', [tool(object({ type: ['string', 'null', 'number'] }))]],
  ['removed required', [tool({ ...nextSchema, required: [] })]],
  ['unknown keyword changed', [tool({ ...nextSchema, customConstraint: true })]],
  ['narrower pattern is not equivalence', [tool(object({ anyOf: [{ type: 'string', pattern: '^[a-f0-9]{64}$' }, { type: 'null' }] }))]],
]) test(`resume rejects ${name}`, async t => {
  const { session, old } = await fixture(t, [tool(oldSchema)], next);
  assert.throws(() => session.assertToolsDigest(old.toolsDigest), { code: 'OMP_TOOLS_DIGEST_MISMATCH' });
});

test('null branch cannot erase enum constraints', async t => {
  const { session, old } = await fixture(t,
    [tool(object({ type: ['string', 'null'], enum: ['one'] }))],
    [tool(object({ anyOf: [{ type: 'string', enum: ['one'] }, { type: 'null' }] }))]);
  assert.throws(() => session.assertToolsDigest(old.toolsDigest), { code: 'OMP_TOOLS_DIGEST_MISMATCH' });
});

test('description inside literal data is not an annotation', async t => {
  const { session, old } = await fixture(t, [tool(object({ const: { description: 'old' } }))], [tool(object({ const: { description: 'new' } }))]);
  assert.throws(() => session.assertToolsDigest(old.toolsDigest), { code: 'OMP_TOOLS_DIGEST_MISMATCH' });
});

test('optional fields cannot constrain previously open object arguments', async t => {
  const old = { ...oldSchema, additionalProperties: true };
  const next = { ...nextSchema, additionalProperties: true, properties: { ...nextSchema.properties, extra: { type: 'string' } } };
  const { session, old: previous } = await fixture(t, [tool(old)], [tool(next)]);
  assert.throws(() => session.assertToolsDigest(previous.toolsDigest), /historical-schema/);
});


test('unproven history, forged bridge digest and stored digest alone are rejected', async t => {
  const { session, old } = await fixture(t, [tool(oldSchema)], [tool(nextSchema)]);
  session.deployed.toolHistory = [];
  assert.throws(() => session.assertToolsDigest(old.toolsDigest), { code: 'OMP_TOOLS_DIGEST_MISMATCH' });
  session.helloState.toolsDigest = old.toolsDigest;
  assert.throws(() => session.assertToolsDigest(session.toolsDigest), { code: 'OMP_TOOLS_DIGEST_MISMATCH' });
  session.helloState = null;
  assert.throws(() => session.assertToolsDigest(session.toolsDigest), { code: 'OMP_TOOLS_DIGEST_MISMATCH' });
});

test('compatible historical additions cannot excuse a bridge that registered a different live definition', async t => {
  const { session, old } = await fixture(t, [tool(oldSchema)], [tool(nextSchema), { ...tool(nextSchema), name: 'nozeli_maintenance' }]);
  session.assertToolsDigest(old.toolsDigest);
  session.deployed.tools = [tool(nextSchema)];
  assert.throws(() => session.assertToolsDigest(old.toolsDigest), /bridge-requested-schema/);
});


test('manifest survives a failed upgrade and another deployment without trusting its claimed digest', async t => {
  const { session, old, home } = await fixture(t, [tool(oldSchema)], [tool(nextSchema)]);
  const deployed = await deployOmpTerminalBridge(home, { tools: [tool(nextSchema)] });
  session.deployed = deployed;
  session.assertToolsDigest(old.toolsDigest);
  await writeFile(path.join(home, 'nozeli-terminal-tools-history.json'), JSON.stringify([[tool(object({ type: 'number' }), { claimedDigest: old.toolsDigest })]]));
  const forged = await deployOmpTerminalBridge(home, { tools: [tool(nextSchema)] });
  session.deployed = forged;
  assert.throws(() => session.assertToolsDigest(old.toolsDigest), { code: 'OMP_TOOLS_DIGEST_MISMATCH' });
});


test('preflight proves legacy bridge equivalence with no deployment, spawn or journal mutation', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'omp-tools-preflight-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = await deployOmpTerminalBridge(home, { tools: [tool(oldSchema)] });
  await rm(path.join(home, 'nozeli-terminal-tools-history.json'));
  const journal = path.join(home, 'old-session.jsonl');
  await writeFile(journal, '{"type":"session","id":"old-thread"}\n');
  const names = await readdir(home);
  const before = await Promise.all(names.map(name => readFile(path.join(home, name))));
  const old = new OmpTuiSession({ home, tools: [tool(oldSchema)] });
  const session = new OmpTuiSession({ home, tools: [tool(nextSchema)], tuiSpawn: { spawn: () => { throw new Error('must not spawn'); } } });
  assert.equal((await session.preflightToolsDigest(old.toolsDigest)).compatible, true);
  const incompatible = new OmpTuiSession({ home, tools: [tool(object({ type: 'number' }))] });
  await assert.rejects(incompatible.preflightToolsDigest(old.toolsDigest), /historical-schema/);
  assert.deepEqual(await readdir(home), names);
  for (let index = 0; index < names.length; index++) assert.deepEqual(await readFile(path.join(home, names[index])), before[index], names[index] + ' remains byte identical');
  assert.equal(session.phase, 'constructed');
  assert.equal(session.deployed, undefined);
  assert.equal(session.pty, undefined);
  await rm(previous.bridgePath);
  await assert.rejects(old.preflightToolsDigest(old.toolsDigest), /historical-digest-missing/, 'exact host digest alone is not evidence');
});

test('preflight accepts proven history without bridge and rejects unreadable history', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'omp-tools-history-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = await deployOmpTerminalBridge(home, { tools: [tool(oldSchema)] });
  await rm(previous.bridgePath);
  const old = new OmpTuiSession({ home, tools: [tool(oldSchema)] });
  const session = new OmpTuiSession({ home, tools: [tool(nextSchema)] });
  await session.preflightToolsDigest(old.toolsDigest);
  await writeFile(path.join(home, 'nozeli-terminal-tools-history.json'), 'not JSON');
  await assert.rejects(session.preflightToolsDigest(old.toolsDigest), /historical-evidence-unreadable/);
});
