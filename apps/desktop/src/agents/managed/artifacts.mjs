import fs from 'node:fs/promises';
import path from 'node:path';

// Publication paths are evidence claims, never authority to open arbitrary host files.
export async function verifyProjectArtifacts(root, candidates = []) {
 if (!Array.isArray(candidates) || candidates.length > 256) throw new Error('invalid artifact paths');
 const realRoot = await fs.realpath(root), files = new Map(), rejected = [];
 for (const value of candidates) {
  try {
   if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('invalid path');
   const file = path.resolve(root, value), relative = path.relative(root, file);
   if (!relative || relative.startsWith('..'+path.sep) || relative==='..' || path.isAbsolute(relative)) throw new Error('outside project');
   const real = await fs.realpath(file), realRelative = path.relative(realRoot, real);
   if (!realRelative || realRelative==='..' || realRelative.startsWith('..'+path.sep) || path.isAbsolute(realRelative)) throw new Error('outside project');
   const stat = await fs.stat(real);if (!stat.isFile()) throw new Error('not a file');
   const relPath = relative.split(path.sep).join('/');
   files.set(relPath, {relPath, size:stat.size});
  } catch { rejected.push(typeof value==='string'?value:'invalid path'); }
 }
 return {files:[...files.values()], rejected};
}
