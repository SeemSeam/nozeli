import path from 'node:path';

export const normalizedTexText = value => String(value).replace(/\r\n?/g, '\n');
export function parseSynctexResults(output) {
  const records = []; let record;
  for (const line of output.split(/\r?\n/)) {
    const match = /^(Output|Input|Page|Line|Column|x|y|h|v|W|H):(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === 'Output') { record = {}; records.push(record); if (records.length > 1024) break; }
    if (!record) continue;
    record[match[1]] = ['Output', 'Input'].includes(match[1]) ? match[2] : Number(match[2]);
  }
  return records;
}

// SyncTeX names refer to the compiler work tree, not the live project or input snapshot.
export function syncSourcePath(input, workRoot, cwd, files) {
  if (typeof input !== 'string' || /[\x00-\x1f]/.test(input)) return null;
  const relative = path.relative(workRoot, path.resolve(cwd, input)).split(path.sep).join('/');
  return files.some(file => file.relPath === relative && /\.(?:tex|sty|cls)$/i.test(relative)) ? relative : null;
}
