import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
// xterm 6.0.0 groups documentOverride ?? condition ? a : b incorrectly,
// dropping the nonce-aware document for viewport styles. Correct the exact
// published expression at bundle time; leave installed dependencies untouched.
const xtermDocumentFix = {
  name: 'xterm-document-override',
  setup(builder) {
    builder.onLoad({ filter: /@xterm[/\\]xterm[/\\]lib[/\\]xterm\.m?js$/ }, async ({ path: file }) => {
      const source = await fs.readFile(file, 'utf8');
      const broken = 'this._document??typeof window<"u"?window.document:null';
      if (source.split(broken).length !== 2) throw new Error('Recheck xterm documentOverride CSP compatibility after dependency change.');
      return { contents: source.replace(broken, 'this._document??(typeof window<"u"?window.document:null)'), loader: 'js' };
    });
  },
};
const output = path.join(root, 'dist/renderer');
await fs.mkdir(output, { recursive: true });
await fs.copyFile(path.join(root,'src/renderer/context-menu.css'),path.join(output,'context-menu.css'));
for (const name of ['index.html', 'styles.css', 'workspace.css', 'provider-terminal.css']) await fs.copyFile(path.join(root, 'src/renderer', name), path.join(output, name));
await fs.copyFile(path.join(root,'assets/nozeli.svg'),path.join(output,'nozeli.svg'));
await fs.copyFile(path.join(root, 'node_modules/katex/dist/katex.min.css'), path.join(output, 'katex.css'));
await fs.cp(path.join(root, 'node_modules/katex/dist/fonts'), path.join(output, 'fonts'), { recursive: true });
const pdf = path.join(root, 'node_modules/pdfjs-dist');
for (const name of ['pdf.mjs', 'pdf.worker.min.mjs']) await fs.copyFile(path.join(pdf, 'build', name), path.join(output, name));
for (const name of ['cmaps', 'standard_fonts', 'wasm']) await fs.cp(path.join(pdf, name), path.join(output, name), { recursive: true });
await fs.copyFile(path.join(pdf, 'LICENSE'), path.join(output, 'PDFJS-LICENSE'));
await fs.copyFile(path.join(root,'node_modules/monaco-editor/LICENSE'),path.join(output,'MONACO-CODICONS-LICENSE'));
await fs.copyFile(path.join(root,'assets/licenses/collab-web.LICENSE'),path.join(output,'COLLAB-WEB-LICENSE'));
for(const dependency of ['react','react-dom','scheduler'])await fs.copyFile(path.join(root,'node_modules',dependency,'LICENSE'),path.join(output,dependency.toUpperCase()+'-LICENSE'));
await build({ entryPoints: [path.join(root, 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js')], bundle: true, format: 'esm', platform: 'browser', outfile: path.join(output, 'monaco-worker.js') });

// Add the Nozeli document nonce to Monaco dynamic stylesheets.
const monacoStylesheetNonce = {
  name: 'monaco-word-highlighter-cancellation',
  setup(builder) {
    builder.onLoad({ filter: /monaco-editor.*\.js$/ }, async ({ path: file }) => {
      const source = await fs.readFile(file, 'utf8');
      const patched = source.replace(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.createElement\((['"])style\2\)/g, 'Object.assign($1.createElement($2style$2), { nonce: document.querySelector(\'meta[name="nozeli-style-nonce"]\')?.content || \'\' })');
      return { contents: patched, loader: 'js' };
    });

  },
};
await build({ plugins: [xtermDocumentFix, monacoStylesheetNonce], entryPoints: [path.join(root, 'src/renderer/app.mjs')], bundle: true, format: 'esm', platform: 'browser', outfile: path.join(output, 'app.js'), loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, assetNames: 'assets/[name]-[hash]' });
for(const name of ['capture.html','capture.css'])await fs.copyFile(path.join(root,'src/renderer',name),path.join(output,name));
await build({entryPoints:[path.join(root,'src/renderer/capture.mjs')],bundle:true,format:'esm',platform:'browser',outfile:path.join(output,'capture.js')});
await fs.rename(path.join(output,'capture.css'),path.join(output,'capture-editor.css'));
await fs.copyFile(path.join(root,'src/renderer/capture.css'),path.join(output,'capture.css'));
// E0 comparison harness is generated only for explicit development tests.
if (process.env.NOZELI_EDITOR_LAB === '1') {
  await build({ plugins: [monacoStylesheetNonce], entryPoints: [path.join(root, 'src/renderer/editor-lab.mjs')], bundle: true, format: 'esm', platform: 'browser', outfile: path.join(output, 'editor-lab.js'), loader: { '.ttf': 'file' } });
  await fs.copyFile(path.join(root, 'src/renderer/editor-lab.html'), path.join(output, 'editor-lab.html'));
}

// Pinned AGPL Word editor, served locally with no CDN or document service.
await fs.cp(path.join(root, 'vendor/superdoc-1.47.1'), path.join(output, 'word-vendor'), { recursive: true });
for (const name of ['word-frame.html', 'word-frame.css']) await fs.copyFile(path.join(root, 'src/renderer', name), path.join(output, name));
await build({entryPoints:[path.join(root,'src/renderer/word-frame.js')],bundle:true,format:'iife',platform:'browser',outfile:path.join(output,'word-frame.js')});

await fs.cp(path.join(root, 'vendor/sheet-1.0.4'), path.join(output, 'sheet-vendor'), { recursive: true });
// Fortune 1.0.4 records history inside React updaters. React can replay an
// updater against the same state even without StrictMode, duplicating undo
// entries and native operations. Memoize each updater by its input state so
// replay returns its original result without repeating side effects. Recompute
// formula values inside undo/redo without creating a separate history entry.
// Only the generated copy changes; exact guards preserve the pinned vendor.
const fortuneFile=path.join(output,'sheet-vendor/fortune.js');
let fortune=await fs.readFile(fortuneFile,'utf8');
const updaterStart='var setContextWithProduce = React.useCallback';
if(fortune.split(updaterStart).length!==2)throw Error('Recheck Fortune history updater compatibility after dependency change.');
fortune=fortune.replace(updaterStart,`function memoizeWorkbookUpdater(update){
      var results=new WeakMap();
      return function(state){if(results.has(state))return results.get(state);var next=update(state);results.set(state,next);return next;};
    }
    ${updaterStart}`);
for(const [start,end,tail] of [
  [updaterStart,'var handleUndo = React.useCallback','return result;'],
  ['var handleUndo = React.useCallback','var handleRedo = React.useCallback','return newContext;'],
  ['var handleRedo = React.useCallback','React.useEffect(function ()','return newContext;'],
]){
  const begin=fortune.indexOf(start),finish=fortune.indexOf(end,begin+start.length);
  let section=fortune.slice(begin,finish);
  const head='setContext(function (ctx_) {',foot=tail+'\n        });';
  // The edit updater has a different indentation level from undo/redo.
  const closing=section.includes(foot)?foot:tail+'\n      });';
  if(begin<0||finish<0||section.split(head).length!==2||section.split(closing).length!==2)throw Error('Recheck Fortune native history compatibility after dependency change.');
  section=section.replace(head,'setContext(memoizeWorkbookUpdater(function (ctx_) {').replace(closing,closing.replace('});','}));'));
  fortune=fortune.slice(0,begin)+section+fortune.slice(finish);
}
for(const direction of ['undo','redo']){
  const original=`newContext.formulaCache.updateFormulaCache(newContext, history, "${direction}");\n          return newContext;`;
  if(fortune.split(original).length!==2)throw Error('Recheck Fortune formula undo/redo compatibility after dependency change.');
  fortune=fortune.replace(original,`newContext.formulaCache.updateFormulaCache(newContext, history, "${direction}");\n          return fn(newContext,function(draftCtx){calculateFormula(draftCtx);triggerGroupValuesRefresh(draftCtx);});`);
}
await fs.writeFile(fortuneFile,fortune);
for (const name of ['sheet-frame.html', 'sheet-frame.css', 'sheet-frame.mjs', 'xlsx-package.mjs','context-menu.mjs','ui-icons.mjs','ui-icons.LICENSE']) await fs.copyFile(path.join(root, 'src/renderer', name), path.join(output, name));

// Pinned PPTist (AGPL-3.0), local-only, with separate Nozeli draft persistence.
await fs.cp(path.join(root,'vendor/pptist/dist'),path.join(output,'ppt-vendor'),{recursive:true});
