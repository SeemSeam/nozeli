import fs from 'node:fs/promises';
import path from 'node:path';

const noticeName = /^(?:licen[cs]e|copying|copyright|notice|third[-_ ]?party|authors)/i;

async function copyNotices(source, destination, relative = '') {
  const copied = [];
  for (const entry of await fs.readdir(path.join(source, relative), {withFileTypes: true})) {
    if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      copied.push(...await copyNotices(source, destination, name));
    } else if (entry.isFile() && noticeName.test(entry.name)) {
      const target = path.join(destination, name);
      await fs.mkdir(path.dirname(target), {recursive: true});
      await fs.copyFile(path.join(source, name), target);
      copied.push(name.split(path.sep).join('/'));
    }
  }
  return copied.sort();
}

// Build dependencies disappear from the runtime node_modules, not from the
// license delivery. Derive this set from actual esbuild inputs, including
// transitive packages, rather than maintaining a second dependency list.
export async function writeBundledNotices(metafiles, output) {
  const packages = new Set();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const parts = path.resolve(input).split(path.sep), offset = parts.lastIndexOf('node_modules');
      if (offset < 0) continue;
      const end = offset + (parts[offset + 1].startsWith('@') ? 3 : 2);
      packages.add(parts.slice(0, end).join(path.sep));
    }
  }
  const directory = path.join(output, 'npm-notices');
  await fs.rm(directory, {recursive: true, force: true});
  await fs.mkdir(directory, {recursive: true});
  const records = [];
  for (const source of [...packages].sort()) {
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    const destination = path.join(directory, manifest.name, manifest.version);
    const files = await copyNotices(source, destination);
    if (!files.length) throw Error('Bundled npm package has no license/notice file: ' + manifest.name);
    records.push({name: manifest.name, version: manifest.version, license: manifest.license ?? null, files});
  }
  records.sort((a, b) => a.name.localeCompare(b.name));
  await fs.writeFile(path.join(output, 'BUNDLED-NPM-NOTICES.json'), JSON.stringify({schema: 1, packages: records}, null, 2) + '\n');
}
