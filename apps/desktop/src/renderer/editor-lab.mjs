import { mountDocumentDiff } from './document-diff.mjs';
import { mountText } from './text-view.mjs';
import { mountMonaco } from './monaco-adapter.mjs';
import { mapTextAnchor } from '../domain/tag-anchors.mjs';
const $ = id => document.getElementById(id);
let cm, monaco, file, project, marks = [], undoMarks = [], redoMarks = [];
function projectTags(event) {
  if (event.undo && undoMarks.length) { redoMarks.push(structuredClone(marks)); marks = undoMarks.pop(); monaco.setProjections(marks); return; }
  if (event.redo && redoMarks.length) { undoMarks.push(structuredClone(marks)); marks = redoMarks.pop(); monaco.setProjections(marks); return; }
  undoMarks.push(structuredClone(marks)); redoMarks = [];
  marks = marks.map(item => {
    if (!item.anchor) return item;
    return { ...item, ...mapTextAnchor(item.anchor, event.before, event.text, event.changes) };
  });
  monaco?.setProjections(marks);
}
const lab = {
  async open(directory, relPath = 'main.js') {
    const picked = await window.nozeli.invoke('project.pick', { directory });
    if (!picked.ok) throw new Error(picked.error.message);
    const opened = await window.nozeli.invoke('file.read', { projectId: picked.value.project.id, relPath });
    if (!opened.ok) throw new Error(opened.error.message);
    const listed = await window.nozeli.invoke('annotation.list', { projectId: picked.value.project.id, relPath });
    cm?.adapter.dispose(); monaco?.dispose(); marks = []; undoMarks = []; redoMarks = [];
    project = picked.value.project; file = opened.value;
    const initialText = file.draft?.text ?? file.text;
    marks = listed.ok ? listed.value.annotations.filter(item => !item.projection && item.resolution?.anchor).map(item => ({ id: item.id, ordinal: item.ordinal, anchor: item.resolution.anchor, note: item.note, locationStatus: item.resolution.locationStatus, contentStatus: item.resolution.contentStatus })) : [];
    const start = performance.now();
    cm = mountText({ parent: $('cm'), relPath, text: initialText, marks });
    monaco = mountMonaco({ parent: $('monaco'), projectId: project.id, relPath, text: initialText, onChange: projectTags });
    monaco.setProjections(marks);
    return { projectId: project.id, engineMountMs: performance.now() - start };
  },
  editor(engine) { return engine === 'cm' ? cm.adapter : monaco; },
  async save(engine) {
    const result = await window.nozeli.invoke('file.save', { projectId: project.id, relPath: file.relPath, baseDigest: file.digest, text: this.editor(engine).getText() });
    if (result.ok) file = { ...file, digest: result.value.digest };
    return result;
  },
  async tag(from, to) {
    const text = monaco.getText();
    const anchor = { start: from, end: to, quote: text.slice(from, to) };
    // Real sidecar writing requires the source version currently visible.
    const result = await window.nozeli.invoke('annotation.add', { projectId: project.id, relPath: file.relPath, materialDigest: file.digest, kind: 'text-selection', anchor, note: '无侵入代码标签' });
    if (!result.ok) throw new Error(result.error.message);
    marks = [{ id: 'lab-note', anchor, note: '无侵入代码标签', locationStatus: 'exact', contentStatus: 'unchanged' }]; monaco.setProjections(marks);
    return result;
  },
  projectionProbe() {
    monaco.setProjections(marks);
    const first = $('monaco').querySelector('.note-anchor');
    if (!first) return { mounted: false };
    const card = first.querySelector('.note-projection');
    const before = first;
    first.querySelector('.note-projection-head')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const collapsed = card?.classList.contains('is-collapsed') || false;
    monaco.setProjections(marks);
    const after = $('monaco').querySelector('.note-anchor');
    return { mounted: true, collapsed, reused: before === after, summary: first.querySelector('.note-projection-content')?.textContent || '' };
  },
  marks: () => structuredClone(marks),
  lifecycleProbe() {
    const baseline = monaco.modelCount(); const start = performance.now();
    for (let i = 0; i < 15; i++) {
      const parent = document.createElement('section'); document.body.append(parent);
      const e = mountMonaco({ parent, projectId: project.id, relPath: 'cycle.ts', text: 'const value = 1;' });
      e.setSelection(6,11); e.applyEdit({ from: 0, insert: '//cycle\n' }); e.dispose(); parent.remove();
    }
    return { before: baseline, after: monaco.modelCount(), cycles: 15, elapsedMs: performance.now() - start };
  },
  performanceProbe() {
    const text = Array.from({ length: 10000 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const parent = document.createElement('section'); document.body.append(parent); const start = performance.now();
    const e = mountMonaco({ parent, projectId: project.id, relPath: 'large.ts', text });
    const mountMs = performance.now() - start, editStart = performance.now(); e.applyEdit({ from: text.length, insert: '\n//end' });
    const result = { lines: 10000, bytes: new TextEncoder().encode(text).length, mountMs, editMs: performance.now() - editStart, textExact: e.getText() === text + '\n//end' };
    e.dispose(); parent.remove(); return result;
  },
  readonlyProbe() {
    const results = [];
    for (const engine of ['cm', 'monaco']) {
      const parent = document.createElement('section'); document.body.append(parent);
      const mounted = engine === 'cm' ? mountText({ parent, relPath: 'main.js', text: 'read only', readOnly: true }).adapter : mountMonaco({ parent, projectId: project.id, relPath: 'readonly.js', text: 'read only', readOnly: true });
      let rejected = false; try { mounted.applyEdit({ from: 0, insert: 'bad' }); } catch { rejected = true; }
      results.push({ engine, rejected, text: mounted.getText() }); mounted.dispose(); parent.remove();
    }
    return results;
  },
  diffProbe() {
    const parent = document.createElement('section'); document.body.append(parent);
    const diff = mountDocumentDiff({ parent, leftPath: file.relPath, leftText: monaco.getText(), rightPath: file.relPath, rightText: file.text });
    const result = { left: diff.merge.a.state.doc.toString(), right: diff.merge.b.state.doc.toString(), changes: diff.merge.chunks.length };
    diff.destroy(); parent.remove(); return result;
  },
  dispose() { cm?.adapter.dispose(); monaco?.dispose(); },
};
window.editorLab = lab;
window.__nozeliReady = true;
