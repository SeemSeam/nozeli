import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { handoffDigest, submitHandoff } from './handoff.mjs';

function argument(name, args) {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1] || '';
}

export async function run(args = process.argv) {
  const runtimeFile = argument('--runtime', args), taskFile = argument('--file', args);
  if (!runtimeFile || !taskFile) throw new Error('usage: handoff-entry.cjs --runtime <grant> --file <task> [--tags <json-file>] [--receipt <receipt-file>]');
  const tagsFile = argument('--tags', args);
  const tags = tagsFile ? JSON.parse(await readFile(path.resolve(tagsFile), 'utf8')) : [];
  if (!Array.isArray(tags)) throw new Error('tags must be an array of {relPath, annotationId} references');
  const text = await readFile(path.resolve(taskFile), 'utf8');
  const runtime = JSON.parse(await readFile(path.resolve(runtimeFile), 'utf8'));
  const digest = handoffDigest(text, tags);
  const receiptFile = path.resolve(argument('--receipt', args) || `${taskFile}.nozeli-send.json`);
  const identity = { id: randomUUID(), projectId: runtime.projectId, digest };
  // Exclusive creation: parallel retries of the same file cannot mint two sends.
  try { await writeFile(receiptFile, JSON.stringify(identity), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const saved = JSON.parse(await readFile(receiptFile, 'utf8'));
  if (!saved.id || saved.projectId !== runtime.projectId || saved.digest !== digest) throw new Error('Receipt belongs to different content/project. Use a new task or --receipt file for a new send.');
  const result = await submitHandoff(path.resolve(runtimeFile), path.resolve(taskFile), { handoffId: saved.id, tags, text });
  console.log(JSON.stringify({ accepted: true, id: result.id, duplicate: result.duplicate }));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
