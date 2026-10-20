import path from 'node:path';

const MAX_TEXT = 8 * 1024 * 1024;
const PARSERS = new Map([
  ['.js', 'babel'], ['.jsx', 'babel'], ['.mjs', 'babel'], ['.cjs', 'babel'],
  ['.ts', 'typescript'], ['.tsx', 'typescript'],
  ['.json', 'json'], ['.css', 'css'], ['.html', 'html'], ['.htm', 'html'],
  ['.md', 'markdown'], ['.markdown', 'markdown'],
]);
const prettierOptions = options => ({
  tabWidth: Number.isInteger(options?.tabWidth) ? Math.max(1, Math.min(8, options.tabWidth)) : 2,
  useTabs: options?.useTabs === true,
  singleQuote: options?.singleQuote === true,
  semi: options?.semi !== false,
  trailingComma: ['all', 'es5', 'none'].includes(options?.trailingComma) ? options.trailingComma : 'all',
  printWidth: Number.isInteger(options?.printWidth) ? Math.max(40, Math.min(160, options.printWidth)) : 100,
});

export function parserForPath(relPath) {
  if (typeof relPath !== 'string') return null;
  return PARSERS.get(path.posix.extname(relPath).toLowerCase()) || null;
}

export class FormatterService {
  constructor({ host } = {}) { this.host = host; this.prettier = null; }

  async load() {
    if (!this.prettier) this.prettier = await import('prettier');
    return this.prettier;
  }

  async format({ projectId, relPath, text, options = {}, range } = {}) {
    if (typeof projectId !== 'string' || !projectId) throw Object.assign(new Error('A project is required.'), { code: 'INVALID_PAYLOAD' });
    if (typeof relPath !== 'string' || !relPath || relPath.startsWith('/') || relPath.includes('\\') || relPath.includes('\0')) throw Object.assign(new Error('A project-relative path is required.'), { code: 'BAD_PATH' });
    const parser = parserForPath(relPath);
    if (!parser) throw Object.assign(new Error('Prettier does not support this file type.'), { code: 'FORMAT_UNSUPPORTED' });
    if (typeof text !== 'string' || text.length > MAX_TEXT) throw Object.assign(new Error('Document text is too large.'), { code: 'FORMAT_TEXT_LIMIT' });
    if (range && (!['babel', 'typescript', 'json'].includes(parser) || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < 0 || range.to <= range.from || range.to > text.length)) throw Object.assign(new Error('Invalid or unsupported formatting range.'), { code: 'FORMAT_RANGE' });
    const project = await this.host.requireProject(projectId);
    const located = await this.host.resolveFile(project, relPath);
    if (located.missing || !located.abs) throw Object.assign(new Error('Formatter target is not a project file.'), { code: 'NOT_A_FILE' });
    try {
      const prettier = await this.load();
      const formatted = await prettier.format(text, { ...prettierOptions(options), parser, filepath: relPath, ...(range ? { rangeStart: range.from, rangeEnd: range.to } : {}) });
      return { text: formatted, changed: formatted !== text, parser, version: prettier.version, relPath };
    } catch (error) {
      throw Object.assign(new Error(`Prettier formatting failed: ${error.message}`), { code: 'FORMAT_FAILED', details: { parser, relPath } });
    }
  }
}
