import {reportDescriptor} from '../src/agents/managed/report-descriptor.mjs';

export function staticReport(text) {
  const escaped = String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture report</title></head><body><main><h1>Fixture report</h1><p>${escaped}</p></main></body></html>`;
}

// Retain historical Markdown business evidence in the current storage format.
export async function historicalMarkdownState(store, bodies) {
  for (const receipt of store.state.receipts) {
    const body = bodies.get(receipt.objectId);
    if (typeof body !== 'string') throw Error('Missing historical fixture body');
    const bytes = Buffer.from(body);
    await store.putObject(bytes);
    receipt.report = reportDescriptor(bytes,{format:'markdown',objectId:receipt.objectId});
    delete receipt.text;
    if (receipt.snapshot) receipt.snapshot.reportDigest = receipt.report.digest;
  }
  await store.save();
  await store.close();
  return store.state;
}
