import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export function staticReport(text) {
  const escaped = String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture report</title></head><body><main><h1>Fixture report</h1><p>${escaped}</p></main></body></html>`;
}

// Persist the actual historical schema, not a new-publication Markdown alias.
export async function historicalMarkdownState(store, bodies) {
  await store.close();
  const state = JSON.parse(await fs.readFile(path.join(store.root, 'state.json'), 'utf8'));
  delete state.reportStateVersion;
  for (const receipt of state.receipts) {
    const body = bodies.get(receipt.objectId);
    if (typeof body !== 'string') throw Error('Missing historical fixture body');
    await fs.writeFile(path.join(store.root, 'objects', receipt.objectId + '.md'), body);
    await fs.rm(path.join(store.root, 'objects', receipt.objectId + '.html'), {force: true});
    delete receipt.report;
    receipt.text = body;
    if (receipt.snapshot) receipt.snapshot.reportDigest = createHash('sha256').update(body).digest('hex');
  }
  await fs.writeFile(path.join(store.root, 'state.json'), JSON.stringify(state));
  store.state = state;
  return state;
}
