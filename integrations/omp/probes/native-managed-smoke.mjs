// Real private TUI/CollabHost/Node relay/guest startup only: never submits a prompt.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmpTuiSession } from '../../../apps/desktop/src/agents/managed/omp-tui-session.mjs';
const command = process.argv[2];
if (!command || !path.isAbsolute(command)) throw Error('usage: node integrations/omp/probes/native-managed-smoke.mjs /absolute/private/omp');
const worker = process.argv.includes('--worker');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-native-collab-smoke-'));
let session;
try {
  const entries = [];
  session = new OmpTuiSession({ role: worker ? 'worker' : 'frontdesk', cwd: root, home: path.join(root, 'home'), command, tools: [], ...(worker ? { isolation: { writable: [root] } } : {}), collabContext: { projectId: 'smoke', targetId: worker ? 'worker-smoke' : 'frontdesk', ownerId: 'smoke-owner' }, onCollabEntry: fact => { entries.push(...(fact.entries ?? [fact])); } });
  const started = await session.start();
  if (!started.threadId || session.collab.sessionId !== started.threadId || !session.collab.epoch.startsWith(started.threadId + '#')) throw Error('native-collab-identity-mismatch');
  const state = await session.bridge.getState();
  if (state.isIdle !== true || state.hasPending !== false || state.editorDraft?.known !== true) throw Error('native-idle-draft-facts-missing');
  const receipt = await session.stop();
  if (!receipt.confirmationComplete) throw Error('native-exit-not-proven');
  console.log(JSON.stringify({ sessionId: started.threadId, epoch: session.collab.epoch, nativeEntries: entries.length, promptSubmissions: 0, exited: receipt.confirmationComplete }));
} finally {
  await session?.stop();
  await fs.rm(root, { recursive: true, force: true });
}
