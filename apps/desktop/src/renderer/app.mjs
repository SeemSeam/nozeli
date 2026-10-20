import { mountContextMenu } from './context-menu.mjs';
import {createDiscussionDrafts,ownsDiscussionReceipt} from './surface-identity-state.mjs';
import {mountRegionDrawing,compositeDrawing} from './region-drawing.mjs';
import {uiIcon,setIconButton} from './ui-icons.mjs';
import { mountOpenFiles } from './open-files.mjs';
import {readFileAvailability} from './file-availability.mjs';
import {createFileIcon,updateFileIcon} from './file-icons.mjs';
import './file-icons.css';
import { mountDocumentAuthorship } from './document-authorship.mjs';
import { mountDocumentComparison, versionCaption } from './document-comparison.mjs';
import { mountImage } from './image-view.mjs';
import { mountFileLabels } from './file-labels.mjs';
import { mountTexWorkspace } from './tex-workspace.mjs';
import { mountMarkdownWorkspace, isMarkdownPath } from './markdown-workspace.mjs';
import { mountPpt } from './ppt-view.mjs';
import { mountSheet } from './sheet-view.mjs';
import { mountWord } from './word-view.mjs';
import { tagDisplayOrdinals } from './tag-numbering.mjs';
import { mountFileTreeActions } from './file-tree-actions.mjs';
import {mountProjectFileRefresh} from './project-file-refresh.mjs';
import { tagProjectionContent } from './tag-projection-state.mjs';
import { mountComposerMaterials } from './composer-materials.mjs';
import { mountDocumentContextMenu, formatEditor, findInReadingSurface } from './document-context-menu.mjs';
import './context-menu.css';
import { mountDocumentDiff } from './document-diff.mjs';
import { mountFrozenChangeReader } from './frozen-change-reader.mjs';
import { createTagSessionProjection } from './tag-session-projection.mjs';
import { mountPdf } from './pdf-view.mjs';
import { languageIdForPath, isCodePath } from './code-language.mjs';
import { mountText } from './text-view.mjs';
import { mountMonaco } from './monaco-adapter.mjs';
import { ChangeSet } from '@codemirror/state';
import { codeMirrorAdapter, remoteDocumentChange } from './editor-adapter.mjs';
import { rebaseDocumentEvent } from './document-collaboration.mjs';
import { openSearchPanel } from '@codemirror/search';
import { anchorText,textChangeSet } from '../domain/tag-anchors.mjs';
import { mountWorkspace } from './workspace.mjs';
import { mountAgent } from './agent-panel.mjs';
import { makeAnchorTag, makeNoteTag } from './note-tag.mjs';
import { managedWorkRecords } from '../domain/managed-work-records.mjs';
import {renderTagMarkdown} from './tag-markdown.mjs';
import {markdownSelection,markdownRange} from './markdown-source.mjs';
import {mountAnnotationComposer,describeAnnotationSource} from './annotation-composer.mjs';
import './immersive-ui.css';
import {panelButton,observePanelWidth} from './panel-menu.mjs';
import {mountInterfaceAppearance} from './interface-appearance.mjs';

const $ = (id) => document.getElementById(id);
const noteSource=document.createElement('details');noteSource.className='tag-source note-form-source';
const noteSourceLabel=document.createElement('summary'),noteSourceQuote=document.createElement('blockquote');
noteSource.append(noteSourceLabel,noteSourceQuote);$('note-input').before(noteSource);
const resumeDrawing=document.createElement('button');resumeDrawing.type='button';resumeDrawing.id='note-resume-drawing';resumeDrawing.textContent='继续涂鸦';resumeDrawing.hidden=true;noteSource.after(resumeDrawing);resumeDrawing.onclick=()=>startDrawing(ui.frozenNote);
const noteComposer=mountAnnotationComposer({root:$('note-form'),input:$('note-input')});
function updateNoteSource(){
  const draft=ui.frozenNote||captureLiveAnchor();noteSource.hidden=!draft;
  if(draft){noteSourceLabel.textContent=describeAnnotationSource({relPath:ui.file?.relPath,anchor:draft.anchor,text:ui.editor?.adapter.getText()||'',displayLocation:draft.displayLocation});noteSourceQuote.textContent=draft.anchor?.quote||'已固定的区域选区';}
  resumeDrawing.hidden=!draft?.drawing;noteComposer.reset();positionNoteForm();
}
const imageToolbar=document.createElement('div');imageToolbar.id='image-toolbar';imageToolbar.hidden=true;
imageToolbar.innerHTML='<span id="image-size"></span><button id="image-out" aria-label="缩小图片">−</button><button id="image-actual" title="原始像素大小">100%</button><button id="image-fit">适应</button><button id="image-in" aria-label="放大图片">＋</button><button id="image-region" aria-pressed="false">区域框选</button>';
$('reader-scroll').before(imageToolbar);
for(const [id,value] of [['image-out',1/1.2],['image-in',1.2],['image-fit',null],['image-actual','actual']])$(id).addEventListener('click',()=>ui.pdf?.zoom(value));
$('image-region').addEventListener('click',()=>ui.pdf?.region($('image-region').getAttribute('aria-pressed')!=='true'));
const SAVE_DELAY = 700;
const SAVE_MAX_WAIT = 2000;
let actions = Promise.resolve();
function enqueue(action, freeze = false) {
  const run = actions.then(async () => {
    if (freeze) $('text-host').inert = true;
    try { return await action(); }
    catch (error) { showFailure(error); return { ok: false, error: { code: error.code || 'UI_FAILED', message: error.message } }; }
    finally { if (freeze) $('text-host').inert = ui.documentHolds.size > 0; }
  });
  actions = run.catch(() => {});
  return run;
}
  const flushCurrent = () => enqueue(() => flushNow());
  const openFile = (relPath, view) => enqueue(() => openFileNow(relPath, view), true);
  const activateProject = projectId => enqueue(() => activateProjectNow(projectId), true);
  let searchToken = 0;
  function cancelSearch() { searchToken += 1; }
  function materialVisible(file) {
    if (!file?.materialDigest || file.sourceChanged || ui.dirty) return false;
    if (ui.editor && ui.editor.adapter.getText() !== anchorText(file.draft?.status === 'saved' ? file.draft.text : file.text || '')) return false;
    if (!file.draft) return true;
    return file.draft.status === 'saved' && file.draft.baseDigest === file.materialDigest;
  }
  function visibleNotes(file, notes) {
    return notes.filter(note => !note.projection && note.resolution?.anchor && note.resolution.targetDigest === file.materialDigest).map((note, index) => ({ ...note, anchor: note.resolution.anchor, anchorDrift: note.resolution.locationStatus !== 'exact' || note.resolution.contentStatus !== 'unchanged', ordinal: ui.noteDisplayOrdinals.get(note.id) || note.ordinal || index + 1 }));
  }
  function textMarks(file, notes) {
    return visibleNotes(file, notes).filter(note => note.kind === 'text-selection').map(note => ({ ...note.anchor, note, locationStatus: note.resolution.locationStatus, contentStatus: note.resolution.contentStatus }));
  }
  function renderUnlocatedTags() {
    let panel = $('unlocated-tags');
    if (!panel) { panel = document.createElement('details'); panel.id = 'unlocated-tags'; $('reader-scroll').prepend(panel); }
    const notes = (ui.annotations || []).filter(note => !note.projection?.removed && (!['word-selection','word-region'].includes(note.kind)||note.projection) && !note.resolution?.anchor);
    panel.hidden = !notes.length; panel.replaceChildren();
    const summary = document.createElement('summary'); summary.textContent = `${notes.length} 个标签待定位（原文和备注已保留）`; panel.append(summary);
    for (const note of notes) {
      const entry = document.createElement('div'); entry.className = 'unlocated-tag';
      const label = document.createElement('p'); label.textContent = `#${ui.noteDisplayOrdinals.get(note.id) || note.ordinal} · ${note.resolution?.locationStatus === 'orphaned' ? '原位置已删除' : '位置待确认'}`;
      const quote = document.createElement('blockquote'); quote.textContent = note.anchor.quote || '原页面/区域';
      const listLayout = { size: () => null, resize: () => {}, offset: () => [0, 0], move: () => {} };
      entry.append(label, quote, note.projection ? makeAnchorTag(ui.threads.get(note.id), { ...tagActions, ...listLayout }) : makeNoteTag(note, { ...noteActions(ui.project.id), ...listLayout })); panel.append(entry);
      if (note.kind === 'text-selection') {
        const relocate = document.createElement('button'); relocate.type = 'button'; relocate.className = 'tag-relocate'; relocate.textContent = '绑定到当前选区';
        relocate.addEventListener('click', () => {
          const selection = captureLiveAnchor(), projectId = ui.project?.id, relPath = ui.file?.relPath;
          if (!selection) return workspace.toast('先在文档中选择新的文字范围。');
          enqueue(async () => { if (!(await flushNow()).ok) return; const result = await invoke('tag.reanchor', { projectId, relPath, annotationId: note.id, targetDigest: ui.materialDigest, anchor: selection.anchor }); if (!result.ok) return workspace.toast(result.error.message); await refreshNotes(); });
        });
        entry.append(relocate);
      }
    }
  }
  function sameNoteTarget(draft, file = ui.file) {
    return Boolean(draft && ui.project && file && draft.projectId === ui.project.id && draft.relPath === file.relPath && draft.materialDigest === file.materialDigest && !file.sourceChanged);
  }
  function captureLiveAnchor() {
    if (!ui.project || !ui.file || !ui.materialDigest || ui.file.sourceChanged) return null;
    if (ui.file.kind === 'text' && ui.editor) {
      if (ui.textMode === 'read' || ui.textSelectionSurface === 'preview') return ui.previewAnchor ? { kind: 'text-selection', anchor: structuredClone(ui.previewAnchor) } : null;
      const sel = ui.editor.adapter.getSelection();
      if ((sel.from === sel.to)) return null;
      return { kind: 'text-selection', anchor: { start: sel.from, end: sel.to, quote: ui.editor.adapter.getText().slice(sel.from, sel.to) } };
    }
    if (ui.file.kind === 'image') return ui.pdfSelection?.anchor ? {kind:'image-region',anchor:structuredClone(ui.pdfSelection.anchor)} : null;
    if (ui.file.kind === 'pdf') {
      if (ui.pdfSelection?.anchor) return { kind: ui.pdfSelection.kind || 'pdf-page', anchor: structuredClone(ui.pdfSelection.anchor) };
      return { kind: 'pdf-page', anchor: { page: ui.pdf?.current() || 1 } };
    }
    return null;
  }
  function positionNoteForm() {
    const form = $('note-form');
    if (!ui.selectionRect) {
      form.classList.remove('anchored');
      form.style.removeProperty('width');
      form.style.removeProperty('left');
      form.style.removeProperty('top');
      return;
    }
    form.classList.add('anchored');
    const bounds=markdownWorkspace.selectionViewport().getBoundingClientRect();
    const left=Math.max(8,bounds.left+8),right=Math.min(innerWidth-8,bounds.right-8);
    const width=Math.min(420,Math.max(120,right-left));
    form.style.width=width+'px';
    form.style.left=`${Math.max(left,Math.min(right-width,ui.selectionRect.left))}px`;
    const available=Math.max(80,Math.min(innerHeight,bounds.bottom)-bounds.top-16);
    form.style.maxHeight=available+'px';form.style.overflowY='auto';
    const height=Math.min(available,form.offsetHeight||220);
    form.style.top=`${Math.max(bounds.top+8,Math.min(Math.min(innerHeight,bounds.bottom)-height-8,ui.selectionRect.bottom+8))}px`;
  }
  function beginNote({ anchored = false } = {}) {
    const selected= ['word','ppt'].includes(ui.file?.kind) ? ui.wordSelection : captureLiveAnchor();
    if(anchored && selected?.anchor && sameNoteTarget(ui.frozenNote) && JSON.stringify(ui.frozenNote.anchor)!==JSON.stringify(selected.anchor)){
      rememberCurrentNote();ui.frozenNote=null;$('note-input').value='';
    }
    if(['word','ppt'].includes(ui.file?.kind)){
      const selected=ui.wordSelection;if(!selected)return workspace.toast('请先在文档内拖选文字或框选区域。');
      const file=ui.file,revision=ui.wordRevision;
      return enqueue(async()=>{
        if(!(await flushNow()).ok||ui.file!==file)return;
        if(ui.wordRevision!==revision)return workspace.toast('文字已变化，请重新选取。');
        let regionImage=null;if(selected.kind?.endsWith('-region')){regionImage=sameNoteTarget(ui.frozenNote)&&JSON.stringify(ui.frozenNote.anchor)===JSON.stringify(selected.anchor)?ui.frozenNote.regionImage:null;if(!regionImage){if(ui.file.kind==='ppt')regionImage=await ui.word.captureRegion(selected.anchor);else{const captured=await invoke('annotation.capture',{rect:selected.rect});if(!captured.ok)return workspace.toast(captured.error.message);regionImage=captured.value;}}}
        ui.frozenNote={...(sameNoteTarget(ui.frozenNote)?ui.frozenNote:{}),regionImage,displayLocation:selected.displayLocation,projectId:ui.project.id,relPath:file.relPath,materialDigest:ui.materialDigest,kind:selected.kind||'word-selection',anchor:structuredClone(selected.anchor),text:$('note-input').value};
        workspace.rememberNote(ui.frozenNote);ui.selectionRect=selected.rect;$('note-label').textContent='选区备注';$('note-form').hidden=false;updateNoteSource();$('note-input').focus();
      });
    }
    if (!anchored) ui.selectionRect = null;
    if (!ui.file || !['text', 'pdf', 'image'].includes(ui.file.kind)) return workspace.toast('先打开 PDF 或文本文件。');
    if (anchored && ui.file.kind === 'text' && (ui.textMode === 'read' || ui.textSelectionSurface === 'preview') && !ui.previewAnchor) return workspace.toast('该选文无法唯一对应 Markdown 源文，请切换编辑模式后选中。');
    if (ui.file.sourceChanged) return workspace.toast('来源已变化，未把旧备注改绑到当前内容。');
    $('note-form').hidden = false;
    positionNoteForm();
    $('note-input').focus();
    if (sameNoteTarget(ui.frozenNote) && ui.frozenNote.anchor) {updateNoteSource();return;}
    const existing = workspace.noteFor(ui.project.id, ui.file.relPath, ui.materialDigest,anchored?selected?.anchor:null);
    if (existing?.anchor) {
      ui.frozenNote = { ...existing, projectId: ui.project.id };
      if(ui.file.kind==='image'&&!ui.frozenNote.regionImage)ui.frozenNote.regionImage=ui.pdf.captureRegion(existing.anchor);
      $('note-input').value = existing.text || '';
      updateNoteSource();
      return;
    }
    const live = captureLiveAnchor();
    if (!live) return;
    ui.frozenNote = { regionImage:ui.pdfSelection?.material?.imageDataUrl?{dataUrl:ui.pdfSelection.material.imageDataUrl,captureMode:ui.file.kind==='image'?'image-pixels':'pdf-canvas',clipped:false}:null,projectId: ui.project.id, relPath: ui.file.relPath, materialDigest: ui.materialDigest, kind: live.kind, anchor: live.anchor, text: $('note-input').value };
    workspace.rememberNote(ui.frozenNote);
    updateNoteSource();
  }
  function rememberCurrentNote() {
    if (!sameNoteTarget(ui.frozenNote)) return;
    ui.frozenNote = { ...ui.frozenNote, text: $('note-input').value };
    workspace.rememberNote(ui.frozenNote);
  }
  function applyPendingNote(file) {
    ui.frozenNote = null;
    ui.selectionRect = null;
    const form = $('note-form');
    form.classList.remove('anchored');
    form.style.removeProperty('left');
    form.style.removeProperty('top');
    if (!file || file.sourceChanged) { $('note-input').value = ''; form.hidden = true; return; }
    const pending = workspace.noteFor(ui.project.id, file.relPath, file.materialDigest);
    if ((!pending?.text && !pending?.drawing) || !pending.anchor) { $('note-input').value = ''; form.hidden = true; return; }
    ui.frozenNote = { ...pending, projectId: ui.project.id };
    $('note-input').value = pending.text;
    $('note-form').hidden = false;
    updateNoteSource();
    if (file.kind === 'pdf' && pending.kind !== 'pdf-page') ui.pdfSelection = { kind: pending.kind, anchor: pending.anchor };
  }

const ui = {
  documentHolds:new Set(),
  pendingDocumentEvents: [],
  project: null,
  file: null,
  editor: null,
  pdf: null,
  baseDigest: null,
  materialDigest: null,
  dirty: false,
  composing: false,
  compositionDispose: null,
  editorResizeObserver: null,
  editorLayoutFrame: 0,
  editorLayoutGeneration: 0,
  editorLayoutSchedule: null,
  timer: 0,
  maxTimer: 0,
  dirtySince: 0,
  maxFlushPending: false,
  lastSavedText: null,
  anchorTransactions: [],
  conflict: null,
  pdfSelection: null,
  selectionRect: null,
  previewAnchor: null,
  textSelectionSurface: 'text',
  threads: new Map(), initialTagId: null, initialTagSurface: null,
  noteOpenStates: new Map(),
  noteDisplayOrdinals: new Map(),
  frozenNote: null,
  viewBlocked: false,
  managedReport: null,
  textMode: 'edit',
  projectSettings: { focusMode: false },
};
const workspace = mountWorkspace({ save: () => writeView(), saveProjectSettings: settings => { ui.projectSettings = { focusMode: settings?.focusMode === true }; return writeView({ projectSettings: ui.projectSettings }); }, openProject: pickProject, addNote: options => beginNote(options), send: () => window.__agentSend?.() });
let composerMaterialsSaveTimer = 0;
const composerMaterials = mountComposerMaterials({
  invoke, toast: message => workspace.toast(message),
  openProjectFile: target => openFile(target.relPath),
  getProjectFile: () => {
    if (!ui.file) return null;
    const root = ui.project?.rootDisplay || ui.project?.root || '';
    const absPath = root ? root.replace(/[\\/]$/, '') + '/' + ui.file.relPath : null;
    return { relPath: ui.file.relPath, absPath };
  },
  exposeProjectRoot: () => ui.project?.rootDisplay || ui.project?.root || '',
});
window.__composerMaterials = composerMaterials;
mountInterfaceAppearance();
const authorship=mountDocumentAuthorship({current:()=>['text','word'].includes(ui.file?.kind)?{kind:ui.file.kind,projectId:ui.project.id,relPath:ui.file.relPath,digest:ui.file.digest,editor:ui.file.kind==='word'&&ui.word?{adapter:ui.word}:ui.editor,dirty:ui.dirty||ui.composing}:null,invoke,reload:relPath=>enqueue(()=>openFileNow(relPath,null,true),true),toast:text=>workspace.toast(text),onCompare:version=>void comparison.compareVersion(version)});
let openFilesState = { paths: [], active: null, dirty: false, collapsed: false };
const fileTabs = mountOpenFiles({state:()=>openFilesState,open:openFile,close:path=>enqueue(()=>closeFileTab(path),true),
  projectId:()=>ui.project?.id,toast:message=>workspace.toast(message),manage:(action,relPath)=>enqueue(async()=>{
    if(action==='locate'){$('file-filter').value='';const state=fileTreeState();for(const node of document.querySelectorAll('#file-tree .dir'))if(relPath.startsWith(node.dataset.path+'/')){state.closed.delete(node.dataset.path);state.searchClosed.delete(node.dataset.path);}filterTree();const node=document.querySelector('#file-tree button[data-path="'+CSS.escape(relPath)+'"]');node?.scrollIntoView({block:'nearest'});node?.focus();await persistTree();return;}
    if(action==='openExternal'){const saved=await flushNow();if(!saved.ok)return;}
    const result=await invoke('tree.path',{projectId:ui.project.id,relPath,action});if(!result.ok)workspace.toast(result.error.message);
  }),
  reorder:(from,to)=>enqueue(async()=>{const paths=openFilesState.paths;paths.splice(paths.indexOf(from),1);paths.splice(paths.indexOf(to),0,from);fileTabs.render();await writeView();}),
  batch:(action,path)=>enqueue(async()=>{const paths=[...openFilesState.paths],index=paths.indexOf(path);const targets=action==='all'?paths:action==='others'?paths.filter(p=>p!==path):paths.slice(index+1);targets.sort((a,b)=>Number(a===ui.file?.relPath)-Number(b===ui.file?.relPath));for(const target of targets)if(!await closeFileTab(target))break;},true),
  persist:()=>writeView()});
function renderFileTabs(){openFilesState.active=ui.file?.relPath||null;openFilesState.dirty=Boolean(ui.dirty||ui.wordDirty);fileTabs.render();renderPathNotice();}
function renderTagPathNotices(){
  const file=ui.file,entry=file&&openFilesState.availability?.get(file.relPath);
  const caption=entry?.status==='missing'?'原路径不存在，可能已移动或删除。原标签与引文保留，未改绑新文件。':entry?.status==='unavailable'?'原路径暂不可用。原标签与引文保留。':file?.diskPresent===false?'当前标签仍对应保留副本，未绑定到重建的磁盘正文。':'';
  for(const node of document.querySelectorAll('#reader-scroll .note-anchor')){
    let notice=node.querySelector('.tag-path-notice');
    if(!caption){notice?.remove();continue;}
    if(!notice){notice=document.createElement('span');notice.className='tag-path-notice';notice.setAttribute('role','status');const card=node.querySelector('.note-projection');if(card){const head=card.querySelector('.note-projection-head');head?head.after(notice):card.prepend(notice);}else node.append(notice);}
    notice.textContent=caption;
  }
}
function renderPathNotice(){
  const file=ui.file,entry=file&&openFilesState.availability?.get(file.relPath),missing=entry?.status==='missing'||!entry&&file?.diskPresent===false,unavailable=entry?.status==='unavailable',retained=entry?.status==='present'&&file?.diskPresent===false;
  $('file-path-notice').hidden=!file||(!missing&&!unavailable&&!retained);
  $('file-path-notice-text').textContent=missing?'原路径不存在，可能已移动或删除。当前显示保留正文；不会自动重建或改绑路径。':retained?'原路径现已存在，当前仍显示保留副本；磁盘正文未自动载入，也未被覆盖。':'原路径暂不可用。当前正文保留，请检查访问权限或文件类型。';
  $('retain-file-close').hidden=!file||file.kind!=='text'||(!missing&&!unavailable&&!retained);
  renderTagPathNotices();
}
async function refreshOpenFileAvailability(project){
  const paths=[...openFilesState.paths,...(ui.file?[ui.file.relPath]:[])];
  try{const availability=await readFileAvailability(invoke,project.id,paths);if(ui.project!==project)return;openFilesState.availability=availability;if(ui.file&&['missing','unavailable'].includes(availability.get(ui.file.relPath)?.status))ui.file.sourceChanged=true;renderFileTabs();}
  catch(error){if(ui.project===project)workspace.toast('文件路径检查失败：'+error.message);}
}
async function closeFileTab(path){
  const index=openFilesState.paths.indexOf(path);if(index<0)return true;
  if(ui.file?.relPath===path && !await closeCurrentSubject())return false;
  openFilesState.paths=openFilesState.paths.filter(p=>p!==path);
  if(!ui.file && openFilesState.paths.length)await openFileNow(openFilesState.paths[Math.min(index,openFilesState.paths.length-1)]);
  renderFileTabs();await writeView();return true;
}
window.addEventListener('nozeli-layout-change', () => {
  ui.editor?.adapter.setFontSize?.(workspace.snapshot().fontSize);
  ui.editorLayoutSchedule?.();
});
$('composer').disabled = true;
const beside = { editor: null, pdf: null, file: null, diff: null, diffHost: null };
const texWorkspace = mountTexWorkspace({ getContext: () => ui, beside, closeBeside, openFile, toast: message => workspace.toast(message) });
const markdownWorkspace = mountMarkdownWorkspace({ getContext: () => ui, render: renderTextPreview, project: projectPreviewTags, saveView: writeView, layout: () => window.dispatchEvent(new Event('nozeli-layout-change')) });
const comparison = mountDocumentComparison({current:()=>ui.project?{projectId:ui.project.id,relPath:ui.file?.relPath,kind:ui.file?.kind,dirty:ui.dirty||ui.composing}:null,invoke,openSnapshot:(file,diff,owner)=>enqueue(()=>{if(ui.project?.id===owner.projectId&&ui.file?.relPath===owner.relPath)return openBesideSnapshot(file,diff);},true),toast:message=>workspace.toast(message)});
const frozenChangeReader = mountFrozenChangeReader({parent:$('documents'),invoke,mountDiff:mountDocumentDiff,currentProjectId:()=>ui.project?.id});
const openFrozenChange = target => enqueue(() => {
  if(ui.composing||regionDrawing.active()){
    const message=ui.composing?'输入法组合尚未结束，请结束输入后查看变更。':'请先完成或取消当前涂鸦，再查看冻结变更。';
    workspace.toast(message);return {ok:false,error:{message}};
  }
  workspace.revealContent();
  $('selection-menu').hidden=true;
  return frozenChangeReader.open(target);
});
const comparisonChange=document.createElement('button');comparisonChange.type='button';comparisonChange.id='comparison-change';comparisonChange.className='comparison-change';comparisonChange.textContent='更换…';comparisonChange.title='更换对照文件或历史版本';
$('secondary-pane').querySelector('.reader-bar').insertBefore(comparisonChange,$('secondary-pane').querySelector('.compare-switch'));
comparisonChange.addEventListener('click',()=>void comparison.open(beside.file?.version?'history':'file'));
function setDiffMode(enabled) {
  documentMenu.close();
  if (enabled && beside.diff) return;
  if (enabled && (!ui.editor || ui.file?.kind !== 'text' || beside.file?.kind !== 'text')) return;
  if (enabled) {
    beside.diffHost = document.createElement('div');
    beside.diffHost.className = 'document-diff';
    $('documents').append(beside.diffHost);
    const head=document.createElement('div');head.className='document-diff-head';const left=document.createElement('header'),right=document.createElement('header'),label=document.createElement('span');label.className='document-diff-title';
    label.textContent=ui.file.relPath+' · 当前内容'+(ui.dirty||ui.composing?'（含草稿）':'');label.title=label.textContent+' · 进入对比时的快照';left.append(label);
    const navigation=document.createElement('div');navigation.className='diff-navigation';const previous=document.createElement('button'),next=document.createElement('button'),count=document.createElement('span');previous.type=next.type='button';previous.id='diff-previous';next.id='diff-next';count.id='diff-count';count.setAttribute('role','status');setIconButton(previous,'chevron-up');setIconButton(next,'chevron-down');previous.setAttribute('aria-label','上一处差异');next.setAttribute('aria-label','下一处差异');previous.title='上一处差异';next.title='下一处差异';navigation.append(previous,count,next);left.append(navigation);
    const diffMore=panelButton('diff-primary-more');left.append(diffMore);beside.diffHeaderDisposers=[observePanelWidth(left),observePanelWidth(right)];
    diffMore.addEventListener('click',()=>documentMenu.openMore(beside.diff.merge.a.dom,diffMore));
    right.append($('secondary-path'),comparisonChange,$('secondary-pane').querySelector('.compare-switch'),$('secondary-close'),$('secondary-more'));head.append(left,right);
    const body=document.createElement('div');body.className='document-diff-body';beside.diffHost.append(head,body);
    beside.diff = mountDocumentDiff({ parent: body, leftPath: ui.file.relPath, leftText: ui.editor.adapter.getText(), rightPath: beside.file.relPath, rightText: beside.file.text,onNavigate:(index,total)=>{count.textContent=total?(index<0?`${total}处差异`:`${index+1}/${total}处差异`):'内容相同';previous.disabled=next.disabled=!total;} });
    previous.addEventListener('click',()=>beside.diff?.navigate(-1));next.addEventListener('click',()=>beside.diff?.navigate(1));
  } else {
    beside.diffHeaderDisposers?.forEach(dispose=>dispose());beside.diffHeaderDisposers=null;
    if(beside.diffHost)$('secondary-pane').querySelector('.reader-bar').append($('secondary-path'),comparisonChange,beside.diffHost.querySelector('.compare-switch'),$('secondary-close'),$('secondary-more'));
    beside.diff?.destroy(); beside.diff = null;
    beside.diffHost?.remove(); beside.diffHost = null;
  }
  $('documents').classList.toggle('diff-mode', enabled);
  $('secondary-scroll').hidden = enabled;
  $('compare-mode').setAttribute('aria-pressed', String(!enabled));
  $('diff-mode').setAttribute('aria-pressed', String(enabled));
}
$('compare-mode').addEventListener('click', () => setDiffMode(false));
$('diff-mode').addEventListener('click', () => setDiffMode(true));
function invoke(op, payload) {
  return window.nozeli.invoke(op, payload ?? {});
}

function setStatus(state, text) {
  if(typeof fileTabs !== 'undefined')renderFileTabs();
  const node = $('save-status');
  node.dataset.state = state;
  node.textContent = text;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function renderTextPreview(text) {
  const preview=$('text-preview');
  preview._markdownSourceText=text;
  renderTagMarkdown(preview,text,{
    mapSource:true,filePaths:ui.filePaths,basePath:ui.file?.relPath,images:true,
    retainNodes:[...preview.children].filter(node=>node.classList.contains('markdown-annotations')),
    onFile:target=>void openMarkdownTarget(target),
    onAnchor:fragment=>{try{preview.querySelector('#'+CSS.escape(decodeURIComponent(fragment)))?.scrollIntoView({block:'start'});}catch{}},
    onExternal:url=>invoke('links.openExternal',{url}).then(result=>{if(!result.ok)workspace.toast(result.error.message);}),
    onCopyError:()=>workspace.toast('代码复制失败，请手动选择复制。'),
    onLayout:()=>{if(!preview.hidden && ui.file?.kind==='text'){projectPreviewTags();markdownWorkspace.layoutChanged();}},
  });
  resolvePreviewImages(preview);
  projectPreviewTags();
  authorship.projectMarkdown();
}
function resolvePreviewImages(preview) {
  if (!ui.project?.id || !ui.file?.relPath) return;
  const pending = [...preview.querySelectorAll('img[data-image-ref]:not([data-image-state])')];
  for (const image of pending) {
    const ref = image.dataset.imageRef;
    image.dataset.imageState = 'loading';
    invoke('document.image.get', { projectId: ui.project.id, relPath: ui.file.relPath, ref })
      .then(result => {
        if (!result.ok || image.dataset.imageRef !== ref) { if (image.isConnected && image.dataset.imageRef === ref) image.dataset.imageState = 'error'; return; }
        image.dataset.imageState = 'loaded';
        image.src = `data:${result.value.mime};base64,${result.value.bytes}`;
      })
      .catch(() => { if (image.isConnected && image.dataset.imageRef === ref) image.dataset.imageState = 'error'; });
  }
}
async function openMarkdownTarget(target){
  const result=await openFile(target.relPath);
  if(result?.ok===false)return result;
  if(ui.file?.relPath!==target.relPath)return;
  if(target.fragment){let id;try{id=decodeURIComponent(target.fragment);}catch{return;} $('text-preview').querySelector('#'+CSS.escape(id))?.scrollIntoView({block:'start'});}
  if(target.line && ui.editor?.adapter){setTextMode('edit');const source=ui.editor.adapter.getText(),offset=source.split('\n').slice(0,target.line-1).reduce((n,line)=>n+line.length+1,0);ui.editor.adapter.revealRange(Math.min(offset,source.length),Math.min(offset,source.length));}
}
async function navigateCode({ path: targetPath, sourcePath, projectRelative = false, targetRange }) {
  if (!ui.project || !targetPath || targetPath.startsWith('/') || targetPath.includes('\\')) { $('code-status').textContent = '跳转路径不在项目范围内。'; return; }
  const base = projectRelative ? [] : sourcePath.split('/').slice(0, -1);
  const parts = [...base, ...targetPath.split('/')];
  const normalized = [];
  for (const part of parts) { if (!part || part === '.') continue; if (part === '..') { if (!normalized.length) { $('code-status').textContent = '跳转路径不在项目范围内。'; return; } normalized.pop(); } else normalized.push(part); }
  const raw = normalized.join('/');
  const listing = await invoke('project.list', { projectId: ui.project.id });
  if (!listing.ok) { $('code-status').textContent = '项目文件列表读取失败。'; return; }
  const files = new Set(listing.value.entries.filter(entry => entry.kind !== 'dir').map(entry => entry.relPath));
  const extensions = ['.js', '.jsx', '.ts', '.tsx', '.py', '.json', '.css', '.html', '.sql', '.java', '.c', '.h', '.cpp', '.go', '.rs'];
  const candidates = [raw, ...extensions.map(ext => raw.endsWith(ext) ? null : raw + ext), ...extensions.map(ext => `${raw}/index${ext}`)].filter(Boolean);
  const target = candidates.find(candidate => files.has(candidate));
  if (!target) { $('code-status').textContent = `项目内未找到 ${targetPath}。`; return; }
  $('code-status').textContent = `跳转到 ${target}`;
  await openFile(target);
  if (targetRange && ui.file?.relPath === target && ui.editor?.adapter) {
    const text = ui.editor.adapter.getText(), lines = text.split('\n');
    const offset = p => lines.slice(0,p.line).reduce((n,line)=>n+line.length+1,0)+p.character;
    ui.editor.adapter.revealRange(Math.min(text.length,offset(targetRange.start)),Math.min(text.length,offset(targetRange.end)));
    ui.editor.adapter.focus();
  }
}

function setTextMode(mode) {
  documentMenu.close();
  ui.previewAnchor = null;
  ui.selectionRect = null;
  $('selection-menu').hidden = true;
  ui.textMode = mode === 'split' && isMarkdownPath(ui.file?.relPath) ? 'split' : mode === 'read' && !isCodePath(ui.file?.relPath) ? 'read' : 'edit';
  if (ui.textMode === 'split') closeBeside();
  ui.textSelectionSurface = ui.textMode === 'read' ? 'preview' : 'text';
  $('text-host').hidden = ui.textMode === 'read';
  $('text-preview').hidden = ui.textMode === 'edit';
  markdownWorkspace.setMode(ui.textMode);
  const toggle = $('text-mode-toggle');
  toggle.textContent = ui.textMode === 'read' ? '编辑' : '阅读';
  toggle.setAttribute('aria-pressed', String(ui.textMode === 'read'));
  $('markdown-preview-toggle').hidden = !isMarkdownPath(ui.file?.relPath) || ui.textMode === 'read';
  $('markdown-preview-toggle').setAttribute('aria-pressed', String(ui.textMode === 'split'));
  if (ui.textMode !== 'edit') { renderTextPreview(ui.editor?.adapter.getText() || ''); markdownWorkspace.restoreScroll(); }
  if (ui.textMode !== 'read') projectTags();
}
$('code-jump').addEventListener('click', () => ui.editor?.jumpToDefinition?.());

$('text-mode-toggle').addEventListener('click', () => {
  if (!ui.editor || ui.file?.kind !== 'text') return;
  setTextMode(ui.textMode === 'read' ? (isMarkdownPath(ui.file.relPath) ? 'split' : 'edit') : 'read');
  void writeView();
});
$('markdown-preview-toggle').addEventListener('click', () => {
  if (!ui.editor || !isMarkdownPath(ui.file?.relPath)) return;
  setTextMode(ui.textMode === 'split' ? 'edit' : 'split');
  void writeView();
});

function showSelectionMenu(rect) {
  if(!rect || !ui.file || documentMenu.isSuppressed() || documentMenu.isOpen() || document.body.classList.contains('provider-console-open') || !$('note-form').hidden){$('selection-menu').hidden=true;return;}
  const bounds=markdownWorkspace.selectionViewport().getBoundingClientRect();
  const left=Math.max(8,bounds.left+8),right=Math.min(innerWidth-8,bounds.right-8);
  const top=Math.max(8,bounds.top+4),bottom=Math.min(innerHeight-8,bounds.bottom-4);
  if(rect.bottom<top || rect.top>bottom || rect.right<left || rect.left>right || right-left<130){$('selection-menu').hidden=true;return;}
  ui.selectionRect={left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom};
  const menu=$('selection-menu');menu.classList.toggle('word-selection-menu',ui.file?.kind==='word');
  $('selection-draw').hidden=!/^(image|pdf|ppt)-region$/.test((ui.file.kind==='ppt'?ui.wordSelection:ui.pdfSelection)?.kind||'');
  if(regionDrawing.active()){menu.hidden=true;return;}
  menu.hidden=false;
  const width=menu.offsetWidth,height=menu.offsetHeight;
  menu.style.left=Math.max(left,Math.min(right-width,(rect.left+rect.right-width)/2))+'px';
  menu.style.top=Math.max(top,Math.min(bottom-height,rect.bottom+height+8<=bottom?rect.bottom+8:rect.top-height-8))+'px';
  menu.style.bottom='auto';menu.dataset.owner=ui.project.id+':'+ui.file.relPath;
}
function clearQuickSelection(){
  $('selection-menu').hidden=true;ui.previewAnchor=null;ui.selectionRect=null;
}
window.addEventListener('resize',clearQuickSelection);
window.addEventListener('nozeli-layout-change',clearQuickSelection);
document.addEventListener('scroll',event=>{
  // Editors scroll their hidden input to keep native selection/composition in
  // sync. That does not move the document or invalidate its action geometry.
  if(event.target instanceof Element&&event.target.matches('input,textarea'))return;
  if($('reader-scroll').contains(event.target))clearQuickSelection();
},true);
// Keep the reading selection stable while a pointer chooses its action.
$('selection-menu').addEventListener('pointerdown', event => event.preventDefault());
addEventListener('keydown',event=>{if(event.key==='Escape')$('selection-menu').hidden=true;},true);

function capturePreviewSelection() {
  if ($('text-preview').hidden || ui.file?.kind !== 'text') return;
  ui.textSelectionSurface = 'preview';
  const selection = window.getSelection();
  const text = selection?.toString();
  if (!text?.trim() || !selection.rangeCount || !selection.anchorNode || !selection.focusNode || !$('text-preview').contains(selection.anchorNode) || !$('text-preview').contains(selection.focusNode)) {
    ui.previewAnchor = null;
    $('selection-menu').hidden = true;
    return;
  }
  const source = ui.editor.adapter.getText();
  if ($('text-preview')._markdownSourceText !== source) { clearQuickSelection(); markdownWorkspace.refresh(); return; }
  ui.previewAnchor = markdownSelection($('text-preview'),selection.getRangeAt(0),source);
  if(!ui.previewAnchor){$('selection-menu').hidden=true;workspace.toast('此选区暂时无法对应原文位置，请切到编辑模式选取。');return;}
  showSelectionMenu(selection.getRangeAt(0).getBoundingClientRect());
}
$('text-preview').addEventListener('mouseup', event => {
  if (event.button !== 0 || event.target.closest('.note-anchor')) return;
  capturePreviewSelection();
});
// Native reading selections can move without another mouseup. Capture after
// navigation has updated the DOM range, before an explicit selection action.
document.addEventListener('keyup', event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
  if (event.target.closest('input,textarea,[contenteditable="true"],.note-anchor')) return;
  const selection = window.getSelection(), preview = $('text-preview');
  if (!selection?.anchorNode || !selection.focusNode || !preview.contains(selection.anchorNode) || !preview.contains(selection.focusNode)) return;
  capturePreviewSelection();
});

function showFailure(error) {
  const box = $('save-failure');
  box.hidden = false;
  $('recover-sheet-close').hidden = ui.file?.kind !== 'sheet';
  $('save-error').textContent = error?.message || '保存失败，草稿仍在。';
  if (['word','sheet'].includes(ui.file?.kind) && error?.details?.recoveryPath) $('save-error').textContent += ` 恢复副本：${error.details.recoveryPath}`;
  $('export-draft').hidden = ['word','sheet'].includes(ui.file?.kind);
  $('overwrite-draft').hidden = ['word','sheet'].includes(ui.file?.kind) || !(error?.code === 'CONFLICT' || error?.code === 'DELETED');
  ui.conflict = error;
  setStatus(error?.code === 'CONFLICT' || error?.code === 'DELETED' ? 'conflict' : 'error', '保存失败');
}

function clearFailure() {
  $('save-failure').hidden = true;
  ui.conflict = null;
}

  async function flushNow(confirmOverwrite = false, resolvingNoteEdit = false) {
    if (!resolvingNoteEdit && workspace.hasOverflowEdits(ui.project?.id)) {
      const result = { ok: false, error: { code: 'NOTE_DRAFT_CAPACITY', message: '备注编辑草稿未持久化：已有 40 条草稿。请先明确保存或删除仅保留在内存中的备注编辑，再切换或关闭。' } };
      showFailure(result.error); return result;
    }
    if(ui.file?.kind==='ppt' && ui.word){
      while(ui.wordDirty){const revision=ui.wordRevision;const result=await invoke('ppt.draft',{projectId:ui.project.id,relPath:ui.file.relPath,digest:ui.file.digest,model:ui.word.snapshot()});if(!result.ok){setStatus('error',result.error.message);return result;}ui.wordDirty=revision!==ui.wordRevision;}
      ui.dirty=false;setStatus('saved','PPTX 草稿已保存 · 原件未修改');return {ok:true};
    }
    if (['word','sheet'].includes(ui.file?.kind) && ui.word) {
      while (ui.wordDirty) {
        const revision = ui.wordRevision;
        try {
          const wordChanges=ui.wordChanges;
          const bytes = await ui.word.export();
          const saved = await invoke(ui.file.kind + '.save', { projectId: ui.project.id, relPath: ui.file.relPath, baseDigest: ui.baseDigest, bytes,...(ui.file.kind==='word'&&wordChanges&&revision===ui.wordRevision?{anchorChanges:wordChanges.toJSON()}: {}) });
          if (!saved.ok) { showFailure(saved.error); return saved; }
          ui.baseDigest = ui.file.digest = saved.value.digest;
          ui.materialDigest = ui.file.materialDigest = saved.value.materialDigest;
          ui.wordDirty = revision !== ui.wordRevision;
          if(ui.file.kind==='word'){
            ui.file.authorship=saved.value.authorship;ui.file.authorshipText=saved.value.authorshipText;
            ui.wordChanges=ChangeSet.empty(saved.value.authorshipText.length);
            authorship.saved(saved.value.authorship,saved.value.authorshipText);
            const currentText=ui.word.getText();
            if(ui.wordDirty&&currentText!==saved.value.authorshipText){ui.wordChanges=textChangeSet(saved.value.authorshipText,currentText);authorship.changed({before:saved.value.authorshipText,text:currentText,changes:ui.wordChanges});}
          }
          if (!ui.wordDirty) { ui.dirty = false; clearFailure(); setStatus('saved', '文档已保存'); if(ui.file.kind==='word')await refreshNotes(); }
        } catch (error) { const result = { ok: false, error: { code: 'WORD_SAVE_FAILED', message: error.message } }; showFailure(result.error); return result; }
      }
      return { ok: true };
    }
    while (true) {
    if (ui.composing && ui.editor) return { ok: false, error: { code: 'COMPOSING', message: '输入法组合尚未结束，未关闭。' } };
    if (!ui.project || !ui.file || ui.file.kind !== 'text' || !ui.editor) return { ok: true };
    const text = ui.editor.adapter.getText();
    const transactionCount = ui.anchorTransactions.length;
    const anchorChanges = ui.file.draft ? null : ui.anchorTransactions.reduce((changes, next) => changes.compose(next), ChangeSet.empty(anchorText(ui.lastSavedText || '').length)).toJSON();
    // Returning to the baseline still has to settle any durable draft from a
    // previous failed save; the host rechecks the source digest before saving.
    if (!confirmOverwrite && text === ui.lastSavedText && !ui.dirty && (!ui.file.draft || ui.file.draft.status === 'saved')) {
      ui.dirty = false;ui.dirtySince = 0;
      window.clearTimeout(ui.timer);window.clearTimeout(ui.maxTimer);ui.maxTimer = 0;
      clearFailure();setStatus('saved', '已保存');
      return { ok: true };
    }
    window.clearTimeout(ui.timer);window.clearTimeout(ui.maxTimer);ui.maxTimer = 0;
  const drafted = await invoke('file.draft', {
    projectId: ui.project.id,
    relPath: ui.file.relPath,
    baseDigest: ui.baseDigest,
    text,
  });
  if (!drafted.ok) { showFailure(drafted.error); return drafted; }
  const saved = await invoke('file.save', {
    projectId: ui.project.id,
    relPath: ui.file.relPath,
    baseDigest: ui.baseDigest,
    text,
    confirmOverwrite,
    anchorChanges,
  });
  if (!saved.ok) {
    showFailure(saved.error);
    return saved;
  }
  ui.anchorTransactions.splice(0, transactionCount);
  ui.baseDigest = saved.value.digest;
  ui.materialDigest = saved.value.materialDigest;
  ui.lastSavedText = text;
  ui.dirty = ui.editor.adapter.getText() !== text;
  ui.file.digest = saved.value.digest;
  ui.file.materialDigest = saved.value.materialDigest;
  ui.file.diskPresent = true;
  ui.file.sourceChanged = false;
  ui.file.text = text; ui.file.draft = null;
  openFilesState.availability?.set(ui.file.relPath,{relPath:ui.file.relPath,status:'present'});renderFileTabs();
  ui.file.authorship=saved.value.authorship;
  authorship.saved(saved.value.authorship,text);
  if(ui.dirty){const changes=ui.anchorTransactions.reduce((value,next)=>value.compose(next),ChangeSet.empty(text.length));authorship.changed({before:text,text:ui.editor.adapter.getText(),changes});}
  confirmOverwrite = false;
  if (ui.dirty) continue;
  ui.dirtySince = 0;window.clearTimeout(ui.maxTimer);ui.maxTimer = 0;
  clearFailure();
  setStatus('saved', '已保存');
  await refreshNotes();
  return saved;
  }
}

function scheduleSave() {
  if (!ui.file || ui.file.kind !== 'text') return;
  ui.dirty = true;
  setStatus('dirty', ui.composing ? '输入中' : '未保存');
  if (!ui.dirtySince) ui.dirtySince = Date.now();
  window.clearTimeout(ui.timer);
  if (ui.composing) return;
  if (ui.maxFlushPending) return; // 到期的保存已排队/进行中，其保存循环会吸收新输入，不逐键排队
  const remaining = SAVE_MAX_WAIT - (Date.now() - ui.dirtySince);
  if (remaining <= 0) { fireDeadlineSave(); return; }
  ui.timer = window.setTimeout(() => { flushCurrent(); }, Math.min(SAVE_DELAY, remaining));
  if (remaining > SAVE_DELAY && !ui.maxTimer) ui.maxTimer = window.setTimeout(() => { ui.maxTimer = 0; window.clearTimeout(ui.timer); ui.timer = 0; fireDeadlineSave(); }, remaining);
}

function fireDeadlineSave() {
  if (ui.maxFlushPending) return;
  ui.maxFlushPending = true;
  const settled = result => { ui.maxFlushPending = false; if (result?.ok && ui.dirty && ui.editor) scheduleSave(); };
  flushCurrent().then(settled, settled);
}

async function writeView(extra = {}) {
  if (ui.viewBlocked) return { ok: false, error: { code: 'VIEW_UNREADABLE', message: '视图未能读取，未写回已保存的工作区。' } };
  if (!ui.project) return { ok: true };
  const project = ui.project, snapshot = workspace.snapshot();
  const result = await invoke('state.write', {
    projectId: ui.project.id,
    state: {
      currentRelPath: ui.file?.relPath ?? null,
      pdfPage: extra.pdfPage ?? ui.pdf?.current() ?? 1,
      scrollTop: ui.textMode==='read' ? $('reader-scroll').scrollTop : ui.editor?.adapter?.getScrollTop?.() ?? $('reader-scroll').scrollTop ?? 0,
      fileView: {
        textMode: ui.file?.kind === 'text' ? ui.textMode : null,
        selection: ui.editor?.adapter?.getSelection?.() ?? null,
        zoom: ui.pdf?.viewState?.() ?? null,
        ...(ui.file?.kind === 'text' && isMarkdownPath(ui.file.relPath) ? { markdownPreview: markdownWorkspace.snapshot() } : {}),
      },
      projectSettings: extra.projectSettings ?? ui.projectSettings,
      workspace: {...snapshot, openFiles:openFilesState.paths, openFilesCollapsed:openFilesState.collapsed},
      composerMaterials: window.__composerMaterials ? window.__composerMaterials.snapshotPersist() : undefined,
    },
  });
  if (!result.ok) showFailure(result.error);
  else if (ui.project === project && $('composer').value === snapshot.draft) workspace.saved();
  return result;
}
function showRetained(workspace) {
  const retained = workspace?.retainedNoteDrafts || [];
  const node = $('retained-notice');
  node.hidden = retained.length === 0;
  node.textContent = retained.length ? retained.length + ' 条旧备注草稿无法安全恢复，原记录已保留，未改绑到当前正文。' : '';
}
async function retryViewRead() {
  if (!ui.project) return;
  const state = await invoke('state.read', { projectId: ui.project.id });
  if (!state.ok) {
    ui.viewBlocked = true;
    showFailure({ code: state.error?.code || 'VIEW_UNREADABLE', message: (state.error?.message || '视图未能读取') + ' 未覆盖已保存的工作区。可重试读取。' });
    return;
  }
  ui.viewBlocked = false;
  clearFailure();
  ui.projectSettings = { focusMode: state.value.state?.projectSettings?.focusMode === true };
  openFilesState={paths:[...(state.value.state?.workspace?.openFiles||[])],collapsed:state.value.state?.workspace?.openFilesCollapsed===true,active:null,dirty:false};
  renderFileTabs();
  workspace.restore(state.value.state?.workspace, ui.projectSettings);
  window.__composerMaterials?.restore(state.value.state?.composerMaterials);
  showRetained(state.value.state?.workspace);
}
    function destroySurface() {
      frozenChangeReader.restore({focus:false});
      $('file-path-notice').hidden=true;
      regionDrawing.suspend();
      // Remember a TeX preview before closing its pane; leaving a file is not
      // the user's explicit choice to disable that preview.
      texWorkspace.leave();
      comparison.close();closeBeside();
      markdownWorkspace.leave();
      authorship.cleared();ui.documentHolds.clear();ui.pendingDocumentEvents.length=0;
      $('reader').classList.remove('document-word');
      $('word-zoom').hidden=true;$('word-region').hidden=true;$('word-region').setAttribute('aria-pressed','false');
      ui.word?.dispose(); ui.word = null; ui.wordDirty = false; ui.wordRevision = 0;ui.wordChanges=null;
      $('word-host').hidden = true;
      $('image-host').hidden=true;imageToolbar.hidden=true;$('reader').classList.remove('document-image');
      ui.wordSelection=null;$('selection-menu').classList.remove('word-selection-menu');
      $('word-notes')?.remove();
      documentMenu.close();
      $('close-subject').hidden = true;
      ui.composing = false;
      window.clearTimeout(ui.timer);window.clearTimeout(ui.maxTimer);ui.maxTimer = 0;ui.dirtySince = 0;
      ui.editorLayoutGeneration += 1;
      if (ui.editorLayoutFrame) cancelAnimationFrame(ui.editorLayoutFrame);
      ui.editorLayoutFrame = 0;
      ui.editorLayoutSchedule = null;
      ui.compositionDispose?.();
      ui.compositionDispose = null;
      ui.editorResizeObserver?.disconnect();
      ui.editorResizeObserver = null;
      try { ui.editor?.adapter.dispose(); } catch { /* editor already gone */ }
    ui.editor = null;
    try { ui.pdf?.destroy(); } catch { /* pdf worker may already be gone */ }
    ui.pdf = null;
    $('text-host').hidden = true;
    $('text-preview').hidden = true;
    $('markdown-preview-toggle').hidden = true;
    ui.previewAnchor = null; ui.textSelectionSurface = 'text';
    $('code-jump').hidden = true;
    $('code-status').textContent = '';
    $('text-preview').replaceChildren();
    for(const name of ['nozeli-md-note','nozeli-md-discuss'])CSS.highlights?.delete(name);
    $('managed-doc').hidden = true;
    ui.managedReport = null;
    $('pdf-host').hidden = true;
    $('pdf-toolbar').hidden = true;
    $('note-form').hidden = true;
    $('unsupported').hidden = true;
    $('unlocated-tags')?.remove();
    ui.pdfSelection = null;
    $('pdf-region').setAttribute('aria-pressed', 'false');
    $('selection-menu').hidden = true;
    $('pdf-outline').hidden = true;
    $('pdf-outline-toggle').setAttribute('aria-expanded', 'false');
    $('pdf-search').hidden = true;
    $('pdf-query').value = '';
    $('pdf-search-status').textContent = '';
  }

function renderWordNotes(){
 $('word-notes')?.remove();if(ui.file?.kind==='ppt'){ui.word?.setNotes((ui.annotations||[]).filter(n=>n.kind?.startsWith('ppt-')).map(n=>({...n,ordinal:ui.noteDisplayOrdinals.get(n.id)||n.ordinal})));return;}if(ui.file?.kind!=='word')return;
 ui.word?.setNotes?.((ui.annotations||[]).filter(n=>['word-selection','word-region'].includes(n.kind)&&!n.projection&&n.resolution?.anchor).map(n=>({...n,ordinal:ui.noteDisplayOrdinals.get(n.id)||n.ordinal})));
 const panel=document.createElement('aside');panel.id='word-notes';panel.setAttribute('aria-label','Word 备注');
 for(const note of (ui.annotations||[]).filter(n=>['word-selection','word-region'].includes(n.kind)&&!n.projection&&!n.resolution?.anchor)){
  const entry=document.createElement('section'),locate=document.createElement('button');locate.textContent=note.resolution?.anchor?'定位原文':'位置待确认';locate.disabled=!note.resolution?.anchor;locate.onclick=()=>ui.word?.locate(note.resolution.anchor);
  const quote=document.createElement('blockquote');quote.textContent=note.anchor.quote;
  entry.append(locate,quote,makeNoteTag({...note,ordinal:ui.noteDisplayOrdinals.get(note.id)||note.ordinal},{...noteActions(ui.project.id),size:()=>({width:260,height:240}),resize:()=>{},offset:()=>[0,0],move:()=>{}}));panel.append(entry);
 }
 panel.hidden=!panel.childElementCount;$('reader-scroll').append(panel);
}

async function refreshNotes() {
  if (!ui.project || !ui.file) return [];
  const project = ui.project, file = ui.file;
  const result = await invoke('annotation.list', { projectId: project.id, relPath: file.relPath });
  if (ui.project !== project || ui.file !== file) return [];
  if (!result.ok) { ui.annotations = []; showFailure(result.error); return []; }
  ui.annotations = result.value.annotations;
  for (const record of ui.annotations) {
    if (record.projection) {
      const old = ui.threads.get(record.id);
      const tag = { ...record.projection, ...old, id: record.id, ordinal: old?.ordinal || record.ordinal, anchorKind: record.kind, projectId: project.id, relPath: record.relPath, materialDigest: record.materialDigest, information:record.information,originAnchor: record.anchor, anchor: record.resolution.anchor || record.anchor, resolution: record.resolution,
        material: { excerpt: record.anchor.quote || (record.kind.endsWith('-region')?'所选区域，内容、笔迹与位置见冻结附件':''), fileRelPath: record.relPath, anchor: record.anchor, kind: record.kind }, history: old?.history || record.projection.history, executeStatus: record.projection.execute?.jobId ? '已提交 · 见工作与待办' : '' };
      bindTagMessages(tag);
      ui.threads.set(record.id, tag);
    } else if (!ui.noteOpenStates.has(`${project.id}:${record.id}`)) ui.noteOpenStates.set(`${project.id}:${record.id}`, record.view?.collapsed !== true);
  }
  renumberTags(); syncExecuteLinks();
  applyAgentMessages();
  renderUnlocatedTags();
  renderWordNotes();
  const visible = visibleNotes(file, result.value.annotations);
  ui.pdf?.setNotes(visible);
  ui.editor?.setNotes?.(textMarks(file, result.value.annotations));
  projectTags();
  if (!$('text-preview').hidden && file.kind === 'text') projectPreviewTags();
  return result.value.annotations;
}

  async function openFileNow(relPath, view, force=false) {
    frozenChangeReader.restore({focus:false});
    const checked=await invoke('file.availability',{projectId:ui.project.id,paths:[relPath]});
    if(checked.ok){openFilesState.availability??=new Map();openFilesState.availability.set(relPath,checked.value.entries[0]);renderFileTabs();}
    if(ui.file?.relPath===relPath && !view && !force){if(checked.value?.entries[0]?.status==='missing')workspace.toast('原路径不存在，当前显示保留正文。');return;}
    window.__lastOpen = { relPath, step: 'start' };
    rememberCurrentNote();
    const flushed = await flushNow();
    if (!flushed.ok) {
      window.__lastOpen = { relPath, step: 'flush-failed', error: flushed.error };
      if (flushed.error?.code === 'COMPOSING') setStatus('dirty', flushed.error.message);
      return;
    }
    const viewed = await writeView();
    if (!viewed.ok && viewed.error?.code !== 'VIEW_UNREADABLE') return;
    if (!view) {
      const restored = await invoke('state.read', { projectId: ui.project.id });
      view = restored.ok ? restored.value.files?.[relPath] : null;
    }
    const result = await invoke('file.read', { projectId: ui.project.id, relPath });
    if (!result.ok) {
      window.__lastOpen = { relPath, step: 'read-failed', error: result.error };
      const message=result.error.code==='NOT_FOUND'?'原路径不存在，文件可能已移动或删除。历史引用保留，当前阅读内容未切换。':result.error.message;
      workspace.toast(message);
      return {ok:false,error:{...result.error,message}};
    }
    window.__lastOpen = { relPath, step: 'read', kind: result.value.kind };
    cancelSearch();
    rememberCurrentNote();
    ui.pdfSelection = null;
    ui.selectionRect = null;
    $('selection-menu').hidden = true;
    destroySurface();
    $('reader-scroll').scrollTop = $('reader-scroll').scrollLeft = 0;
    const file = result.value;
    ui.file = file;
    window.dispatchEvent(new Event('nozeli-content-file-opened'));
    $('reader').dataset.fileKind=file.kind;
    if(!openFilesState.paths.includes(relPath))openFilesState.paths.push(relPath);
    renderFileTabs();
    $('close-subject').hidden = false;
    workspace.revealContent();
    $('file-section-label').textContent = '文件';
  ui.baseDigest = file.draft?.baseDigest ?? file.digest;
  ui.materialDigest = file.materialDigest;
  ui.anchorTransactions = [];
  ui.lastSavedText = anchorText(file.text || '');
  ui.dirty = Boolean(file.draft && file.draft.status !== 'saved');
  $('file-path').textContent = file.relPath;
  $('subject-title').textContent = file.relPath;
  $('context-bar').textContent = ui.project.name + ' · ' + file.relPath;
  $('empty').hidden = true;
  $('empty').hidden = true;
  document.querySelectorAll('#file-tree button').forEach((button) => {
    button.setAttribute('aria-current', button.dataset.path === file.relPath ? 'true' : 'false');
  });
  if (file.pathUnavailable) showFailure({code:'PATH_UNAVAILABLE',message:'原路径暂不可用，已打开保留副本。可导出或保留后返回对话，不会替换目录或链接。'});
  else if (!file.diskPresent) showFailure({ code: 'DELETED', message: '文件已删除。草稿可编辑、导出或明确重建，不会自动覆盖。' });
  else if (file.sourceChanged) showFailure({ code: 'CONFLICT', message: '磁盘内容与草稿基线不同。两边都保留着，没有覆盖。' });
  else { clearFailure(); if (!ui.dirty) setStatus('saved', '已保存'); else setStatus('dirty', '未保存'); }
  const notes = await refreshNotes();
  if (file.kind === 'text') {
    const text = file.draft ? file.draft.text : file.text;
    const marks = textMarks(file, notes);
    const editorOptions = {
      parent: $('text-host'),
      relPath: file.relPath,
      text,
      marks,
      tagActions: { ...tagActions, autoEdit: id => consumeInitialTagEdit(id, 'text') },
      noteActions: noteActions(ui.project.id),
      onNavigate: navigateCode,
      onStatus: message => { $('code-status').textContent = message; },
      onChange: (view, update) => {
        const remote = update.transactions?.some(transaction => transaction.annotation(remoteDocumentChange));
        if (!remote) {
          authorship.changed({before:update.before??update.startState.doc.toString(),text:view.adapter.getText(),changes:update.changes});
          ui.anchorTransactions.push(update.changes);
        }
        for (const item of view.anchorItems()) {
          if (item.note) {
            const record = ui.annotations?.find(note => note.id === item.note.id);
            if (record) record.resolution = { ...record.resolution, anchor: item.locationStatus === 'orphaned' || item.locationStatus === 'unresolved' ? null : { start: item.start, end: item.end, quote: item.quote }, locationStatus: item.locationStatus || 'exact', contentStatus: item.contentStatus || 'unchanged' };
          } else if (item.tag) {
            const tag = ui.threads.get(item.tag.id);
            if (tag) { tag.resolution = { ...tag.resolution, anchor: item.locationStatus === 'orphaned' || item.locationStatus === 'unresolved' ? null : { start: item.start, end: item.end, quote: item.quote }, locationStatus: item.locationStatus || 'exact', contentStatus: item.contentStatus || 'unchanged' }; if (tag.resolution.anchor) tag.anchor = tag.resolution.anchor; }
          }
        }
        clearQuickSelection(); ui.textSelectionSurface = 'text';
        renderUnlocatedTags(); if (!remote) scheduleSave(); texWorkspace.changed(); markdownWorkspace.changed();
        if (ui.textMode === 'read') renderTextPreview(view.adapter.getText());
      },
      onSelection: view => {
        if (ui.textMode === 'read') return;
        ui.textSelectionSurface = 'text'; ui.previewAnchor = null;
        const selection = view.adapter?.getSelection?.() || { from: view.state.selection.main.from, to: view.state.selection.main.to };
        if ((selection.from === selection.to)) {
          ui.selectionRect = null;
          $('selection-menu').hidden = true;
          return;
        }
        const from = view.adapter?.coordsAtOffset(selection.from) ?? view.coordsAtPos(selection.from);
        const to = view.adapter?.coordsAtOffset(selection.to) ?? view.coordsAtPos(selection.to);
        if (!from || !to) {
          // A mode switch or fresh mount can select before CodeMirror measures
          // its layout; coordsAtPos then returns null and a single-shot menu
          // would silently vanish. Re-run on the next measure cycle instead.
          view.requestMeasure({ read: () => { const main = view.state.selection.main; if (!main.empty) onSelection(view); } });
          return;
        }
        showSelectionMenu({ left: Math.min(from.left, to.left), right: Math.max(from.right, to.right), top: Math.min(from.top, to.top), bottom: Math.max(from.bottom, to.bottom) });
      },
      onPasteImage: async ({ view, bytes, name = '' }) => {
        const projectId = ui.project.id, relPath = ui.file.relPath;
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = () => reject(reader.error || Error('读取剪贴板图片失败。'));
          reader.readAsDataURL(new Blob([bytes]));
        });
        const result = await invoke('document.image.put', { projectId, relPath, bytes: base64 });
        // The reference is inserted only after the host stored the bytes.
        const alt = (name || '粘贴图片').replace(/[[\]]/g, '');
        const ref = `![${alt}](${result.value.relRef})`;
        const position = view.state.selection.main.to;
        const atLineStart = position === 0 || view.state.doc.sliceString(position - 1, position) === '\n';
        view.dispatch({ changes: { from: position, insert: (atLineStart ? '' : '\n\n') + ref + '\n' }, selection: { anchor: position + (atLineStart ? 0 : 2) + ref.length } });
        return result.value;
      },
    };
    ui.editor = languageIdForPath(file.relPath)
      ? mountMonaco({ ...editorOptions, projectId: ui.project.id, projectionActions: { ...tagActions }, noteActions: noteActions(ui.project.id) })
      : mountText(editorOptions);
    ui.editor.setTags?.([...ui.threads.values()].filter(tag => tag.relPath === file.relPath && tag.anchorKind === 'text-selection' && tag.anchor).map(tag => ({ ...tag.anchor, tag, locationStatus: tag.resolution?.locationStatus, contentStatus: tag.resolution?.contentStatus })));
    $('code-jump').hidden = !languageIdForPath(file.relPath);
    $('text-mode-toggle').hidden = isCodePath(file.relPath) || /\.tex$/i.test(file.relPath);
    // Markdown opens as a rendered reading surface; editing remains an explicit choice.
    markdownWorkspace.restore(view?.fileView?.markdownPreview);
    setTextMode(!isCodePath(file.relPath) && view?.fileView?.textMode ? view.fileView.textMode : /\.(?:md|markdown)$/i.test(file.relPath) ? 'read' : 'edit');
    authorship.opened(file);
    const selection=view?.fileView?.selection;if(selection){const length=ui.editor.adapter.getText().length;ui.editor.adapter.setSelection(Math.min(selection.anchor??selection.from,length),Math.min(selection.head??selection.to,length));}
    ui.compositionDispose = ui.editor.adapter.onComposition({
      start: () => { texWorkspace.composing(); markdownWorkspace.composing(); ui.composing = true; window.clearTimeout(ui.timer); },
      end: () => {
        ui.composing = false; texWorkspace.changed(); markdownWorkspace.changed();
        const pending = ui.pendingDocumentEvents.splice(0);
        if (pending.length) void enqueue(async () => { for (const event of pending) await applyDocumentEvent(event); });
        if (ui.editor && ui.editor.adapter.getText() !== ui.lastSavedText) scheduleSave();
      },
    });
    const adapter = ui.editor.adapter;
    const savedScrollTop = Number.isFinite(view?.scrollTop) ? view.scrollTop : 0;
    let layoutSerial = 0;
    const fitEditor = () => {
      if (ui.editor?.adapter !== adapter) return 0;
      const scroll = $('reader-scroll');
      const height = scroll ? Math.floor((ui.textMode === 'split' ? $('text-host') : scroll).getBoundingClientRect().height) : 0;
      if (height <= 0) return 0;
      adapter.setViewportHeight(height);
      return height;
    };
    const scheduleEditorLayout = () => {
      const serial = ++layoutSerial;
      if (ui.editorLayoutFrame) cancelAnimationFrame(ui.editorLayoutFrame);
      ui.editorLayoutFrame = requestAnimationFrame(() => {
        ui.editorLayoutFrame = 0;
        if (serial !== layoutSerial || ui.editor?.adapter !== adapter) return;
        fitEditor();
        // Conversation/composer changes can settle one frame after the reader.
        // Re-measure once more so Monaco never keeps a stale viewport height.
        requestAnimationFrame(() => {
          if (serial !== layoutSerial || ui.editor?.adapter !== adapter) return;
          fitEditor();

        });
      });
    };
    ui.editorLayoutSchedule = scheduleEditorLayout;
    fitEditor();
    scheduleEditorLayout();
    if (typeof ResizeObserver === 'function') {
      ui.editorResizeObserver = new ResizeObserver(scheduleEditorLayout);
      ui.editorResizeObserver.observe($('reader-scroll'));
    }
    if (savedScrollTop !== null) adapter.setScrollTop(savedScrollTop);
    $('note-label').textContent = '给选中文字添加备注';
    void texWorkspace.enter();
  } else if(file.kind==='ppt'){
    $('reader').classList.add('document-word');$('text-mode-toggle').hidden=true;$('note-form').hidden=true;
    setStatus('loading','正在打开 PPTX');
    try{
      const payload={projectId:ui.project.id,relPath:file.relPath,digest:file.digest};
      const draft=await invoke('ppt.draft',payload);if(!draft.ok)throw Error(draft.error.message);
      ui.word=await mountPpt({parent:$('word-host'),bytes:file.bytes,name:file.relPath.split('/').at(-1),draft:draft.value,
        onContextMenu:closer=>documentMenu.externalOpen('ppt',closer),onContextClose:()=>documentMenu.externalClosed('ppt'),onSelectionStart:()=>documentMenu.resumeSelection(),
        noteActions:noteActions(ui.project.id),tagActions:{...tagActions,autoEdit:id=>consumeInitialTagEdit(id,'ppt')},
        onRegionMode:enabled=>$('word-region').setAttribute('aria-pressed',String(enabled)),
        onSelection:selected=>{if(ui.file!==file)return;ui.wordSelection=selected;if(!selected){$('selection-menu').hidden=true;return;}if(!$('note-form').hidden)return;showSelectionMenu(selected.rect);},
        onChange:()=>{ui.wordDirty=true;ui.dirty=true;ui.wordRevision=(ui.wordRevision||0)+1;setStatus('dirty','PPTX 草稿未保存');clearTimeout(ui.timer);ui.timer=setTimeout(()=>flushCurrent(),1200);},
        onExport:async bytes=>{const saved=await flushNow();if(!saved.ok)throw Error(saved.error.message);const result=await invoke('ppt.export',{...payload,bytes});if(!result.ok)throw Error(result.error.message);workspace.toast(result.value.cancelled?'已取消导出':'PPTX 副本已导出');}
      });$('word-region').hidden=false;$('word-region').title='拖动框选文档区域';ui.wordDirty=true;await flushNow();ui.word.setNotes((ui.annotations||[]).filter(n=>n.kind?.startsWith('ppt-')).map(n=>({...n,ordinal:ui.noteDisplayOrdinals.get(n.id)||n.ordinal})));setStatus('saved',draft.value?'PPTX · 已恢复草稿':'PPTX · 本地编辑');
    }catch(error){$('unsupported').hidden=false;$('unsupported').textContent=error.message;setStatus('error','PPTX 未能打开');}
  } else if (['word','sheet'].includes(file.kind)) {
    $('reader').classList.add('document-word');
    $('text-mode-toggle').hidden = true;
    $('note-form').hidden = true;
    const label = file.kind === 'word' ? 'Word' : '电子表格';
    setStatus('loading', '正在打开 ' + label);
    try {
      ui.word = await (file.kind === 'word' ? mountWord : mountSheet)({ parent: $('word-host'), bytes: file.bytes, name: file.relPath.split('/').at(-1),
        noteActions: noteActions(ui.project.id),
        tagActions: {...tagActions,autoEdit:id=>consumeInitialTagEdit(id,'word')},
        onZoom:state=>{$('word-zoom-reset').textContent=Math.round(state.value)+'%';$('word-zoom-out').disabled=state.value<=25;$('word-zoom-in').disabled=state.value>=200;$('word-fit').setAttribute('aria-pressed',String(state.mode==='fit-width'));},
        onRegionMode:enabled=>$('word-region').setAttribute('aria-pressed',String(enabled)),
        onSelection: selected=>{
          if(ui.file!==file)return;
          ui.wordSelection=selected;
          if(!selected){$('selection-menu').hidden=true;return;}
          if(!$('note-form').hidden)return;
          showSelectionMenu(selected.rect);
        },
        onSave: () => flushCurrent(),
        onContextMenu:()=>documentMenu.externalOpen(file.kind,()=>ui.word?.closeContextMenu?.()),
        onContextClose:()=>documentMenu.externalClosed(file.kind),
        onContextCommand:command=>{if(ui.file!==file)return;if(command==='authorship-toggle')return authorship.toggle();if(command==='authorship-history')return authorship.history();},
        onSelectionStart:()=>documentMenu.resumeSelection(),
        onChange: update => {
          if(file.kind==='word'&&ui.word&&update?.before!==update?.text){
            let changes;
            try{
              if(!update.batches?.length||update.batches[0].before!==update.before||update.batches.at(-1).text!==update.text)throw Error('No matching Word transaction');
              changes=ChangeSet.empty(update.before.length);
              for(const batch of update.batches)changes=changes.compose(ChangeSet.of(batch.edits,batch.before.length));
              changes=textChangeSet(update.before,update.text,changes.toJSON());
            }catch{changes=textChangeSet(update.before,update.text);}
            if(ui.wordChanges)ui.wordChanges=ui.wordChanges.length===file.authorshipText.length&&ui.wordChanges.newLength===changes.length?ui.wordChanges.compose(changes):null;
            authorship.changed({...update,changes});
          }
          ui.wordDirty = true; ui.dirty = true; ui.wordRevision = (ui.wordRevision || 0) + 1; setStatus('dirty', label + ' 未保存'); window.clearTimeout(ui.timer); ui.timer = window.setTimeout(() => flushCurrent(), 1200);
        },
        onError: error => setStatus('error', error.message),
      });
      if(file.kind==='word'){
        ui.wordChanges=ChangeSet.empty(file.authorshipText.length);
        authorship.opened({...file,text:file.authorshipText});
        if(ui.word.getText()!==file.authorshipText){ui.wordChanges=null;workspace.toast('Word 引擎正文与记录位置不一致，修改者标记暂不显示。');}
      }
      $('word-zoom').hidden=file.kind!=='word';$('word-region').hidden=file.kind!=='word';
      setStatus('saved', label + ' · 本地编辑');
      renderWordNotes();
    } catch (error) { $('unsupported').hidden = false; $('unsupported').textContent = error.message; setStatus('error', label + ' 未能打开'); }
  } else if (file.kind === 'pdf') {
    setStatus('loading','正在打开 PDF');
    $('text-mode-toggle').hidden = true;
    $('text-preview').hidden = true;
    $('pdf-toolbar').hidden = false;
    $('note-form').hidden = true;
    $('note-label').textContent = '给当前页添加备注（页级）';
    try {
      ui.pdf = await mountPdf({
        parent: $('pdf-host'),
        bytes: file.bytes,
        page: view?.pdfPage || 1,
        noteActions: noteActions(ui.project.id),
        tagActions: { ...tagActions, autoEdit: id => consumeInitialTagEdit(id, 'pdf') },
        onSelection: selection => {
          if (selection?.error) { setStatus('error', selection.error); return; }
          if (!selection) { ui.pdfSelection = null; ui.selectionRect = null; $('selection-menu').hidden = true; return; }
          if (selection.kind === 'pdf-region') $('pdf-region').setAttribute('aria-pressed', 'false');
          ui.pdfSelection = selection;
          ui.selectionRect = selection.viewportRect || null;
          $('note-label').textContent = selection.kind === 'pdf-region' ? '给框选区域添加备注' : '给所选 PDF 文字添加备注';
          if (selection?.viewportRect) showSelectionMenu(selection.viewportRect);
        },
        onPage: (page, count) => {
          $('pdf-page').value = String(page);
          $('pdf-count').textContent = String(count);
          if (ui.pdfSelection && ui.pdfSelection.anchor.page !== page) { ui.pdfSelection = null; $('selection-menu').hidden = true; }
          writeView({ pdfPage: page });
        },
      });
      ui.pdf.setNotes(visibleNotes(file, notes));
    } catch (error) {
      $('unsupported').hidden = false;
      $('unsupported').textContent = `${error?.message || error}\n${error?.stack || ''}`;
      setStatus('error', 'PDF 未能打开');
      return;
    }
    setStatus('saved', '只读 PDF');
  } else if(file.kind==='image'){
    setStatus('loading','正在打开图片');
    $('text-mode-toggle').hidden=true;$('reader').classList.add('document-image');imageToolbar.hidden=false;
    try {
      ui.pdf=await mountImage({parent:$('image-host'),bytes:file.bytes,info:file.image,noteActions:noteActions(ui.project.id),tagActions:{...tagActions,autoEdit:id=>consumeInitialTagEdit(id,'image')},
        onZoom:state=>{$('image-size').textContent=`${state.width} × ${state.height} · ${Math.round(state.scale*100)}%`;$('image-fit').setAttribute('aria-pressed',String(state.mode==='fit'));},
        onRegion:enabled=>$('image-region').setAttribute('aria-pressed',String(enabled)),
        onSelection:selection=>{if(selection?.error)return workspace.toast(selection.error);ui.pdfSelection=selection;ui.selectionRect=selection?.viewportRect||null;if(!selection)$('selection-menu').hidden=true;else showSelectionMenu(selection.viewportRect);},
      });ui.pdf.setNotes(visibleNotes(file,notes));setStatus('saved','图片 · 只读静态预览');
    }catch(error){$('unsupported').hidden=false;$('unsupported').textContent=error.message;setStatus('error','图片无法打开');}
  } else if(file.kind==='legacy-word'){
    const box=$('unsupported');box.hidden=false;box.textContent='旧版 DOC 需要导入。正文导入仅保留文字和段落，不保留图片、表格结构及原排版；原件不会修改。若实际内容已是 DOCX，则完整复制。';
    const button=document.createElement('button');button.id='import-doc';button.textContent='导入为 DOCX 副本并打开';
    button.addEventListener('click',()=>enqueue(async()=>{button.disabled=true;try{const result=await invoke('word.import',{projectId:ui.project.id,relPath:file.relPath,digest:file.digest});if(!result.ok){workspace.toast(result.error.message);return;}await renderTree();await openFileNow(result.value.relPath);workspace.toast(result.value.mode==='body-only'?'已打开正文导入副本；原排版和图片未导入。':'已打开 DOCX 副本，原件保持不变。');}finally{button.disabled=false;}}));box.append(document.createElement('br'),button);setStatus('idle','DOC · 导入副本');
  } else {
    $('unsupported').hidden = false;
    $('unsupported').textContent = file.unsupportedReason || '此格式未迁移。';
    setStatus('idle', '未迁移');
  }
  projectTags();
  applyPendingNote(file);
  if(view?.fileView?.zoom)await ui.pdf?.restoreView?.(view.fileView.zoom);
  if (!ui.editor || ui.textMode === 'read') $('reader-scroll').scrollTop = Number.isFinite(view?.scrollTop) ? view.scrollTop : 0;
  renderFileTabs();
  await writeView();
}

const fileTreeStates = new Map();
function fileTreeState() {
  const id = ui.project?.id;
  if (!fileTreeStates.has(id)) fileTreeStates.set(id, { closed: new Set(), searchClosed: new Set(), hidden: new Set(), showHidden:false, loaded: false });
  return fileTreeStates.get(id);
}
async function persistTree() {
  if (!ui.project) return;
  const result = await invoke('tree.view', { projectId: ui.project.id, closed: [...fileTreeState().closed] });
  if (!result.ok) workspace.toast('目录状态未保存：' + result.error.message);
}
const fileLabels = mountFileLabels({ invoke, projectId: () => ui.project?.id, refresh: () => enqueue(renderTree), toast: message => workspace.toast(message) });
const treeActions = mountFileTreeActions({
  invoke, projectId: () => ui.project?.id, toast: message => workspace.toast(message),
  openExternal:ctx=>enqueue(async()=>{if(ctx.projectId!==ui.project?.id)return {ok:false,error:{message:'项目已切换'}};const saved=await flushNow();if(!saved.ok)return saved;return invoke('tree.path',{projectId:ctx.projectId,relPath:ctx.relPath,action:'openExternal'});}),
  open: openFile, refresh: () => enqueue(renderTree),
  visibility:()=>fileTreeState(),
  changeVisibility:(action,ctx)=>enqueue(async()=>{
    if(ctx.projectId!==ui.project?.id)return;
    const state=fileTreeState(),hidden=new Set(state.hidden);
    if(action==='hide')hidden.add(ctx.relPath);
    if(action==='unhide')hidden.delete(ctx.relPath);
    const result=await invoke('tree.view',{projectId:ctx.projectId,hidden:[...hidden],showHidden:action==='toggleHidden'?!state.showHidden:state.showHidden});
    if(!result.ok)throw Error(result.error.message);
    if(ctx.projectId!==ui.project?.id)return;
    state.hidden=new Set(result.value.hidden);state.showHidden=result.value.showHidden;
    if(action==='toggleHidden'&&state.showHidden){$('file-filter').value='';state.searchClosed.clear();}
    await renderTree();
    workspace.toast(action==='hide'?'已在 Nozeli 文件栏隐藏；真实文件与已打开内容保持不变。':action==='unhide'?'已恢复显示。':state.showHidden?'正在显示已隐藏项；右键“显示”可恢复。':'已隐藏检查视图中的隐藏项。');
  }),
  label: ctx => fileLabels.edit(ctx),
  collapse: parent => enqueue(async () => {
    const state = fileTreeState();
    for (const node of document.querySelectorAll('#file-tree .dir')) if (!parent || node.dataset.path === parent || node.dataset.path.startsWith(parent + '/')) {
      state.closed.add(node.dataset.path); state.searchClosed.add(node.dataset.path);
    }
    filterTree(); await persistTree();
  }),
  perform: request => enqueue(async () => {
    if (request.projectId !== ui.project?.id) return {ok:false,error:{message:'项目已切换。'}};
    rememberCurrentNote();
    await texWorkspace.persist();
    const saved = await flushNow(); if (!saved.ok) return saved;
    const viewed = await writeView(); if (!viewed.ok) return viewed;
    const result = await invoke('tree.mutate', request); if (!result.ok) return result;
    const {from, relPath, removed} = result.value;
    const affected = rel => rel && ((from && (rel === from || rel.startsWith(from + '/'))) || (removed && (rel === removed || rel.startsWith(removed + '/'))));
    openFilesState.paths=openFilesState.paths.flatMap(p=>affected(p)?from?[relPath+p.slice(from.length)]:[]:[p]);
    renderFileTabs();
    if (affected(beside.file?.relPath)) closeBeside();
    const current = ui.file?.relPath;
    if (from) {
      workspace.remapFiles(from, relPath);
      for (const tag of ui.threads.values()) if (affected(tag.relPath)) {
        tag.relPath = relPath + tag.relPath.slice(from.length);
        if (tag.material?.relPath) tag.material.relPath = tag.relPath;
      }
      const state = fileTreeState();
      for (const key of ['closed','searchClosed']) state[key] = new Set([...state[key]].map(p => affected(p) ? relPath + p.slice(from.length) : p));
    }
    if (['createFile','createFolder','paste'].includes(request.action)) {
      const state = fileTreeState(), parts = relPath.split('/'); parts.pop();
      while (parts.length) { const dir = parts.join('/'); state.closed.delete(dir); state.searchClosed.delete(dir); parts.pop(); }
    }
    if (affected(current)) {
      destroySurface(); ui.file = null; ui.dirty = false;
      if (from) { $('note-form').hidden = true; await openFileNow(relPath + current.slice(from.length)); }
      else {
        renderEmptyState();
        $('file-path').textContent = '选择文件开始阅读';
        $('close-subject').hidden = true; setStatus('idle', '未打开');
      }
    }
    await persistTree();
    await renderTree();
    if (['createFile','createFolder','paste'].includes(request.action)) document.querySelector(`#file-tree button[data-path="${CSS.escape(relPath)}"]`)?.scrollIntoView({block:'nearest'});
    if (request.action === 'createFile') await openFileNow(relPath);
    await writeView();
    return result;
  }, true),
});
async function renderTree() {
  const project=ui.project;if(!project)return;
  const id = project.id, state = fileTreeState();
  if (!state.loaded) {
    const result = await invoke('tree.view', { projectId: id });
    if (project !== ui.project) return;
    if (result.ok) { state.closed = new Set(result.value.closed);state.hidden=new Set(result.value.hidden||[]);state.showHidden=result.value.showHidden===true; state.loaded = true; }
    else workspace.toast(result.error.message);
  }
  await fileLabels.load(id);
  if(project!==ui.project)return;
  const result = await invoke('project.list', { projectId: id, treeView:true });
  if(project!==ui.project)return;
  const tree = $('file-tree');
  if (!result.ok) {
    workspace.toast('目录刷新失败：'+result.error.message);
    return;
  }
  const scrollTop=tree.scrollTop,focused=tree.contains(document.activeElement)?document.activeElement.dataset.path:null;
  tree.replaceChildren();
  const children = new Map();
  for (const entry of result.value.entries) {
    const parent = entry.relPath.split('/').slice(0, -1).join('/');
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(entry);
  }
  const ordered = [];
  const visit = parent => {
    const entries = children.get(parent) || [];
    entries.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name, 'zh', { numeric: true }));
    for (const entry of entries) { ordered.push(entry); if (entry.kind === 'dir') visit(entry.relPath); }
  };
  visit('');
  for (const entry of ordered) {
    const button = document.createElement('button');
    button.type = 'button';
    const expander = document.createElement('span');
    expander.className = 'tree-expander';
    expander.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = entry.name;
    button.append(expander, createFileIcon(entry.relPath,{directory:entry.kind==='dir',expanded:!fileTreeState().closed.has(entry.relPath)}), label);
    button.title = entry.relPath;
    button.setAttribute('aria-label', entry.name);
    button.dataset.path = entry.relPath;
    button.dataset.hiddenRoot=String(entry.hiddenRoot===true);
    if(entry.hidden){button.classList.add('tree-hidden-item');button.title+=' · 已在 Nozeli 隐藏';button.setAttribute('aria-label',entry.name+'，已隐藏');const badge=document.createElement('span');badge.className='tree-hidden-label';badge.textContent='已隐藏';button.append(badge);}
    button.style.paddingLeft = `${12 + entry.depth * 12}px`;
    if (entry.kind === 'dir') {
      button.classList.add('dir');
      button.setAttribute('aria-expanded', String(!fileTreeState().closed.has(entry.relPath)));
      button.addEventListener('click', () => {
        const collapsed = button.getAttribute('aria-expanded') === 'true';
        const state = fileTreeState();
        const closed = $('file-filter').value.trim() ? state.searchClosed : state.closed;
        if (collapsed) closed.add(entry.relPath); else closed.delete(entry.relPath);
        filterTree();
        if (!$('file-filter').value.trim()) void persistTree();
      });
    } else {
      button.addEventListener('click', () => openFile(entry.relPath));
    }
    if (entry.kind !== 'dir') fileLabels.decorate(button);
    tree.append(button);
  }
  if(state.showHidden){const notice=document.createElement('p');notice.className='quiet tree-visibility-notice';notice.textContent='正在显示已隐藏项 · 隐藏文件夹仅列入口，不展开子树；右键“显示”恢复。';tree.prepend(notice);}
  if (result.value.truncated) {
    const note = document.createElement('p');
    note.className = 'quiet';
    note.textContent = `只显示前 ${result.value.limit} 个未隐藏项；可右键隐藏不需要的文件夹，让出显示额度。`;
    tree.append(note);
  }
  // Tree hiding is a presentation preference, not document-link availability.
  const linkListing=await invoke('project.list',{projectId:id});
  if(project!==ui.project)return;
  if(linkListing.ok)ui.filePaths=new Set(linkListing.value.entries.filter(entry=>entry.kind!=='dir').map(entry=>entry.relPath));
  await refreshOpenFileAvailability(project);
  if(project!==ui.project)return;
  window.dispatchEvent(new CustomEvent('nozeli-project-files-refreshed',{detail:{projectId:id}}));
  filterTree();
  treeActions.paint();
  for(const node of tree.querySelectorAll('button'))node.setAttribute('aria-current',String(node.dataset.path===ui.file?.relPath));
  tree.scrollTop=scrollTop;
  if(focused){const node=[...tree.querySelectorAll('button')].find(n=>n.dataset.path===focused);if(node&&!node.hidden)node.focus({preventScroll:true});}
}
mountProjectFileRefresh({subscribe:fn=>window.nozeli.subscribe('agent',fn),getProject:()=>ui.project,
  refresh:project=>enqueue(async()=>{if(ui.project===project)await renderTree();}),onError:error=>workspace.toast('目录刷新失败：'+error.message)});
window.addEventListener('nozeli-report-exported',event=>{const project=ui.project;if(project?.id===event.detail?.projectId)void enqueue(async()=>{if(ui.project===project)await renderTree();}).catch(showFailure);});

const projectMenu = mountContextMenu({id:'project-context-menu',label:'项目操作',onError:message=>workspace.toast(message)});
async function removeProjectEntry(projectId) {
  if (ui.project?.id === projectId) {
    rememberCurrentNote();
    if (!(await flushNow()).ok) return;
    if (!(await writeView()).ok) return;
  }
  const result = await invoke('project.remove', {projectId});
  if (!result.ok) return workspace.toast(result.error.message);
  if (ui.project?.id === projectId) location.reload();
  else await renderRecent();
}
async function renderRecent() {
  const result = await invoke('project.recent');
  const host = $('recent');
  host.replaceChildren();
  if (!result.ok) return;
  const projects = [...result.value.projects].sort((a, b) => String(a.openedAt ?? '').localeCompare(String(b.openedAt ?? '')) || a.id.localeCompare(b.id));
  for (const project of projects) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = (project.name || '?').slice(0, 1);
    button.title = project.available ? project.name : `${project.name}（目录不可用）`;
    button.setAttribute('aria-disabled', String(!project.available));
    button.dataset.projectId = project.id;
    button.addEventListener('contextmenu', event => {event.preventDefault();projectMenu.open([{id:'remove',label:'从 Nozeli 移除项目',hint:'保留磁盘文件、草稿及工作记录'}],{x:event.clientX,y:event.clientY,focus:button,run:()=>enqueue(()=>removeProjectEntry(project.id))});});
    button.setAttribute('aria-current', String(project.id === ui.project?.id));
    button.addEventListener('click', () => project.available ? activateProject(project.id) : workspace.toast('项目目录不可用，可右键移除入口。'));
    host.append(button);
  }
}

  async function activateProjectNow(projectId) {
    frozenChangeReader.restore({focus:false});
    rememberCurrentNote();
    const flushed = await flushNow();
    if (!flushed.ok) {
      if (flushed.error?.code === 'COMPOSING') setStatus('dirty', flushed.error.message);
      return;
    }
    const leaving = await writeView();
    if (!leaving.ok && leaving.error?.code !== 'VIEW_UNREADABLE') return;
    await invoke('lsp.stop').catch(() => {});
    const opened = await invoke('project.open', { projectId });
    if (!opened.ok) {
    setStatus('error', opened.error.message);
    return;
  }
  window.dispatchEvent(new Event('nozeli-project-change'));
  ui.project = opened.value.project;
  ui.file = null;
  openFilesState={paths:[],active:null,dirty:false,collapsed:false};
  closeBeside();
  destroySurface();
  $('project-name').textContent = ui.project.name;
  $('project-name').title = ui.project.root || ui.project.name;
  document.title = ui.project.name;
  $('file-path').textContent = '选择文件开始阅读';
  renderEmptyState();
  $('context-bar').textContent = ui.project.name + ' · 项目对话';
  $('composer').disabled = false;
  $('file-filter').value = '';
  await renderTree();
  await renderRecent();
  const state = await invoke('state.read', { projectId });
  if (!state.ok) {
    ui.viewBlocked = true;
    showFailure({ code: state.error?.code || 'VIEW_UNREADABLE', message: (state.error?.message || '视图未能读取') + ' 未覆盖已保存的工作区。可重试读取。' });
    return;
  }
  ui.viewBlocked = false;
  ui.projectSettings = { focusMode: state.value.state?.projectSettings?.focusMode === true };
  openFilesState={paths:[...(state.value.state?.workspace?.openFiles||[])],collapsed:state.value.state?.workspace?.openFilesCollapsed===true,active:null,dirty:false};
  await refreshOpenFileAvailability(ui.project);
  renderFileTabs();
  workspace.restore(state.value.state?.workspace, ui.projectSettings);
  window.__composerMaterials?.setProject(projectId);
  window.__composerMaterials?.restore(state.value.state?.composerMaterials);
  showRetained(state.value.state?.workspace);
  if (state.value.state?.currentRelPath) await openFileNow(state.value.state.currentRelPath, state.value.state);
  else renderEmptyState();
  window.__agentProject?.(ui.project.id, {draft:state.value.state?.workspace?.draft ?? ''});
}

async function pickProject() {
  const picked = await invoke('project.pick', {});
  if (!picked.ok) {
    setStatus('error', picked.error.message);
    return;
  }
  if (picked.value.canceled) return;
  await activateProject(picked.value.project.id);
}

$('pick-project').addEventListener('click', pickProject);
$('pdf-prev').addEventListener('click', () => enqueue(async () => { await ui.pdf?.go((ui.pdf.current() || 1) - 1); }));
$('pdf-next').addEventListener('click', () => enqueue(async () => { await ui.pdf?.go((ui.pdf.current() || 1) + 1); }));
$('pdf-page').addEventListener('change', () => {
  const page = Number($('pdf-page').value);
  enqueue(async () => { await ui.pdf?.go(page); });
});
  $('note-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const project = ui.project, file = ui.file;
    const note = $('note-input').value;
    const selected = ui.editor?.adapter.getSelection();
    const selection = selected ? { from: selected.from, to: selected.to, empty: selected.from === selected.to } : null;
    const selectedText = ui.editor?.adapter.getText();
    const selectedPage = ui.pdf?.current() || 1;
    const pdfSelection = ui.pdfSelection ? structuredClone(ui.pdfSelection) : null;
    enqueue(async () => {
    if (project !== ui.project || file !== ui.file) return;
    if (!ui.project || !ui.file) return;
    if (ui.file.kind === 'text') {
      const flushed = await flushNow();
      if (!flushed.ok) return;
    }
    if (!ui.materialDigest) return;
    if (ui.file.sourceChanged) { setStatus('error', '来源已变化，未把旧备注改绑到当前内容。'); return; }
    const frozen = sameNoteTarget(ui.frozenNote) ? ui.frozenNote : null;
    let anchor;
    let kind;
    if (ui.file.kind === 'text') {
      if (ui.editor && selectedText !== ui.editor.adapter.getText()) {
        setStatus('error', '选段在等待保存时已变化，请重新选择后保存备注。');
        return;
      }
      if (!(frozen?.kind === 'text-selection' && frozen.anchor)) { setStatus('error', '先选中一段文字。'); return; }
      kind = 'text-selection';
      anchor = frozen.anchor;
    } else if (['word','ppt'].includes(ui.file.kind)) {
      if(ui.dirty || !frozen?.anchor || !['word-selection','word-region','ppt-selection','ppt-region'].includes(frozen.kind)){setStatus('error','Word 已变化，请重新选中原文添加备注。');return;}
      kind=frozen.kind;anchor=frozen.anchor;
    } else if (ui.file.kind === 'image') {
      const selection=frozen?.kind==='image-region'?frozen:pdfSelection;if(!selection?.anchor)return;kind='image-region';anchor=selection.anchor;
    } else if (ui.file.kind === 'pdf') {
      if (frozen?.anchor && ['pdf-page', 'pdf-selection', 'pdf-region'].includes(frozen.kind)) {
        kind = frozen.kind;
        anchor = frozen.anchor;
      } else if (pdfSelection?.anchor) {
        kind = pdfSelection.kind || 'pdf-page';
        anchor = pdfSelection.anchor;
      } else { setStatus('error', '先选定页面或选区。'); return; }
    } else return;
    const result = await invoke('annotation.add', {
      projectId: ui.project.id,
      relPath: ui.file.relPath,
      materialDigest: ui.materialDigest,
      kind,
      anchor,
      note,
      regionImage:frozen?.regionImage,drawing:frozen?.drawing,sourceDraftDigest:frozen?.sourceDraftDigest,annotatedImage:frozen?.drawing?await compositeDrawing(frozen.regionImage.dataUrl,frozen.drawing):undefined,displayLocation:frozen?.displayLocation,
    });
    if (!result.ok) {
      setStatus('error', result.error.message);
      return;
    }
    const submitted = { projectId: ui.project.id, relPath: ui.file.relPath, materialDigest: ui.materialDigest, kind, anchor, text: note };
    if ($('note-input').value === note) {
      $('note-input').value = '';
      workspace.rememberNote({ ...submitted, text: '' });
      if (ui.frozenNote && ui.frozenNote.materialDigest === submitted.materialDigest && JSON.stringify(ui.frozenNote.anchor) === JSON.stringify(submitted.anchor)) ui.frozenNote = null;
      const form = $('note-form');
      form.hidden = true;
      form.classList.remove('anchored');
      form.style.removeProperty('left');
      form.style.removeProperty('top');
    } else rememberCurrentNote();
    $('selection-menu').hidden = true;
    ui.pdfSelection = null;
    await refreshNotes();
    }, true);
  });
  $('note-input').addEventListener('input', () => rememberCurrentNote());
$('recover-sheet-close').addEventListener('click',()=>enqueue(async()=>{
 if(ui.file?.kind!=='sheet'||!ui.word?.snapshot)return;
 try{
  const bytes=await ui.word.snapshot();const result=await invoke('sheet.recover',{projectId:ui.project.id,relPath:ui.file.relPath,bytes});
  if(!result.ok)return showFailure(result.error);
  ui.wordDirty=false;ui.dirty=false;clearFailure();
  workspace.toast('未覆盖原文件。完整编辑快照已保留：'+result.value.recoveryPath);
  await closeCurrentSubject();
 }catch(error){showFailure(error);}
}));
$('retry-save').addEventListener('click', () => { if (ui.viewBlocked) retryViewRead(); else flushCurrent(); });
$('export-draft').addEventListener('click', () => {
  const text = ui.editor?.adapter.getText() ?? '';
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'nozeli-draft.txt';
  link.click();
  URL.revokeObjectURL(link.href);
});
$('overwrite-draft').addEventListener('click', () => enqueue(() => flushNow(true), true));

function filterTree() {
  const buttons = [...document.querySelectorAll('#file-tree button')];
  const query = $('file-filter').value.trim().toLocaleLowerCase();
  const state = fileTreeState();
  const closed = new Set(query ? state.searchClosed : state.closed);
  if(state.showHidden)for(const hidden of state.hidden){const parts=hidden.split('/');parts.pop();while(parts.length){closed.delete(parts.join('/'));parts.pop();}}
  const visible = new Set();
  if (query) for (const button of buttons) {
    if (!(button.dataset.searchText || button.dataset.path).toLocaleLowerCase().includes(query)) continue;
    const parts = button.dataset.path.split('/');
    while (parts.length) { visible.add(parts.join('/')); parts.pop(); }
  }
  const prefixes = [...closed].map(path => path + '/');
  for (const button of buttons) {
    const path = button.dataset.path;
    button.hidden = (query && !visible.has(path)) || prefixes.some(prefix => path.startsWith(prefix));
    if (button.classList.contains('dir')) {
      const collapsed = closed.has(path);
      button.dataset.collapsed = String(collapsed);
      button.setAttribute('aria-expanded', String(!collapsed));
      button.querySelector('.tree-expander').replaceChildren(uiIcon(collapsed?'chevron-right':'chevron-down'));
      updateFileIcon(button.querySelector('.file-type-icon'),button.dataset.path,{directory:true,expanded:!collapsed});
    }
  }
}
function settleNoteEdit(projectId, id, submitted, text, saved) {
  if (!submitted || ui.project?.id !== projectId) return;
  const current = workspace.editDraft(projectId, id);
  if (current === submitted && current.text === text) workspace.clearEdit(current);
  else if (current && current.baselineUpdatedAt === submitted.baselineUpdatedAt) workspace.rememberEdit({ ...current, baselineUpdatedAt: saved.updatedAt });
}
function noteActions(projectId) {
  return {
    filePath: () => ui.file?.relPath || '', sourceText: () => ui.editor?.adapter.getText() || '',
    draw: id => editSavedDrawing(id),
    size: workspace.chatSize, resize: workspace.resizeChat,
    offset: workspace.offset,
    draft: id => { const draft = ui.project?.id === projectId && workspace.editDraft(projectId, id); return draft ? { value: draft.text } : null; },
    onDraft: (id, text, origin) => {
      if (ui.project?.id !== projectId || !origin || origin.id !== id || ui.file?.relPath !== origin.relPath) return;
      const previous = workspace.editDraft(projectId, id);
      const draft = previous || { projectId, annotationId: id, baselineUpdatedAt: origin.updatedAt, relPath: origin.relPath, materialDigest: origin.materialDigest, kind: origin.kind, anchor: structuredClone(origin.anchor) };
      const retained = workspace.rememberEdit({ ...draft, text, updatedAt: Date.now() });
      if (!retained) workspace.toast('备注编辑草稿未持久化：已有 40 条草稿；输入仍保留在内存。请明确保存或删除此备注编辑，切换和关闭已阻止。');
      void writeView().then(result => { if (!result.ok) workspace.toast(`备注编辑草稿未持久化，输入仍保留在内存；请勿关闭并处理保存错误：${result.error?.message || '工作区无法写入'}`); });
    },
    open: id => ui.noteOpenStates.get(`${projectId}:${id}`) ?? true,
    onOpen: (id, open) => {
      const note = (ui.annotations || []).find(note => note.id === id && !note.projection);
      if (ui.project?.id !== projectId || !note) return;
      ui.noteOpenStates.set(`${projectId}:${id}`, open);
      const payload = {projectId, relPath:note.relPath, annotationId:id, collapsed:!open};
      void enqueue(async () => {
        const result = await invoke('tag.view', payload);
        if (!result.ok) workspace.toast(`备注显示状态未能保存：${result.error.message}`);
      });
    },
    execute: (note, text) => enqueue(async () => {
      if (ui.project?.id !== projectId || ui.file?.relPath !== note.relPath) { workspace.toast('来源已变化，未执行；备注仍保留。'); return; }
    if (note.execute?.jobId || (ui.executeSent || new Set()).has(note.id)) { setExecuteDisplay(note.id, '已提交 · 见工作与待办'); workspace.toast('这条备注已发送过执行，状态见标签与工作栏。'); return; }
      const instruction = String(text ?? note.note ?? '').trim();
      if (!instruction) { workspace.toast('备注内容为空，未执行。'); return; }
      setExecuteDisplay(note.id, '保存并发送…');
      // Reliable save first: a failed save must never dispatch.
      const editDraft = workspace.editDraft(projectId, note.id);
      if (!(await flushNow(false, true)).ok) { setExecuteDisplay(note.id, ''); workspace.toast('文档保存失败，未发送执行。'); return; }
      const savedNote = await invoke('annotation.update', { projectId, annotationId: note.id, materialDigest: editDraft?.materialDigest ?? note.materialDigest, expectedUpdatedAt: editDraft?.baselineUpdatedAt ?? note.updatedAt, note: instruction });
      if (!savedNote.ok) { setExecuteDisplay(note.id, ''); workspace.toast(`备注保存失败，未发送执行：${savedNote.error.message}`); return; }
      const saved = savedNote.value?.annotation || savedNote.annotation;
      settleNoteEdit(projectId, note.id, editDraft, text, saved);
      await writeView();
      const result = await window.__agentSelectionAction?.({ action:'task', excerpt: note.anchor?.quote || '（区域备注，材料与位置见随附冻结附件）', relPath: note.relPath, annotationRef: { relPath: note.relPath, annotationId: note.id }, comment: instruction, background: true });
      if (result.legacy) { (ui.executeSent ||= new Set()).add(note.id); setExecuteDisplay(note.id, '已按前台问题发送（兼容模式，无后台执行链）'); return; }
      const linked = await invoke('annotation.update', { projectId, annotationId: note.id, materialDigest: note.materialDigest, expectedUpdatedAt: saved.updatedAt, note: instruction, execute: { jobId: result.requestId } });
      if (!linked.ok) workspace.toast('执行已提交，但执行状态链接保存失败；可在工作栏查看该任务。');
      if (linked.ok) {
        const current = workspace.editDraft(projectId, note.id);
        const linkedNote = linked.value?.annotation || linked.annotation;
        if (current && linkedNote && current.baselineUpdatedAt === saved.updatedAt) {
          workspace.rememberEdit({ ...current, baselineUpdatedAt: linkedNote.updatedAt });
          await writeView();
        }
      }
      (ui.executeLinks ||= new Map()).set(note.id, { jobId: result.requestId, projectId });
      setExecuteDisplay(note.id, '已接收 · 排队中');
      await refreshNotes();
    }, true),
    update: (note, text) => enqueue(async () => {
      if (ui.project?.id !== projectId || ui.file?.relPath !== note.relPath ) {
        workspace.toast('来源已变化，备注草稿仍保留。'); return null;
      }
      const editDraft = workspace.editDraft(projectId, note.id);
      if (!(await flushNow(false, true)).ok) return null;
      const result = await invoke('annotation.update', { projectId, annotationId: note.id, materialDigest: editDraft?.materialDigest ?? note.materialDigest, expectedUpdatedAt: editDraft?.baselineUpdatedAt ?? note.updatedAt, note: text });
      if (!result.ok) { workspace.toast(result.error.code === 'UNKNOWN_OP' ? '备注更新接口尚未接通；修改草稿仍在当前标签中。' : result.error.message); return null; }
      const saved = result.annotation || result.value?.annotation;
      if (!saved) { workspace.toast('备注更新未返回持久记录；修改草稿仍在当前标签中。'); return null; }
      settleNoteEdit(projectId, note.id, editDraft, text, saved);
      await writeView();
      await refreshNotes();
      return { ...saved, text: saved.note ?? text };
    }, true),
    move: workspace.moveNote,
    remove: id => enqueue(async () => {
      if (ui.project?.id !== projectId) return;
      const editDraft = workspace.editDraft(projectId, id);
      if (!(await flushNow(false, true)).ok) return;
      const result = await invoke('annotation.remove', {projectId,annotationId:id});
      if (!result.ok) return workspace.toast(result.error.message);
      if (editDraft) { workspace.clearEdit(editDraft); await writeView(); }
      ui.noteOpenStates.delete(`${projectId}:${id}`);
      await refreshNotes();
    },true),
  };
}
for(const [id,value] of [['word-zoom-out','out'],['word-zoom-in','in'],['word-zoom-reset','reset'],['word-fit','fit']])$(id).addEventListener('click',()=>ui.word?.zoom?.(value));
$('word-region').addEventListener('click',()=>ui.word?.region?.($('word-region').getAttribute('aria-pressed')!=='true'));
$('pdf-region').addEventListener('click', () => {
  const enabled = $('pdf-region').getAttribute('aria-pressed') !== 'true';
  $('pdf-region').setAttribute('aria-pressed',String(enabled)); ui.pdf?.region(enabled);
});
function activeTags() {
  if (!ui.project || !ui.file) return [];
  return [...ui.threads.values()].filter(tag => !tag.removed && tag.projectId === ui.project.id && tag.relPath === ui.file.relPath && tag.resolution?.anchor && tag.resolution.targetDigest === ui.materialDigest);
}
function renumberTags() {
  if (!ui.file || !ui.project) return;
  const conversations = [...ui.threads.values()].filter(tag => tag.projectId === ui.project.id && tag.relPath === ui.file.relPath);
  ui.noteDisplayOrdinals = tagDisplayOrdinals(ui.annotations || [], conversations);
  for (const tag of conversations) if (!tag.removed) tag.ordinal = ui.noteDisplayOrdinals.get(tag.id);
}
function updateDisplayedOrdinals() {
  for (const node of document.querySelectorAll('#text-host .note-anchor,#text-preview .note-anchor,#pdf-host .note-anchor,#image-host .note-anchor,#word-host .note-anchor')) {
    const ordinal = ui.noteDisplayOrdinals.get(node.dataset.annotation);
    if (ordinal) node.setOrdinal?.(ordinal);
  }
}
function projectTags() {
  renumberTags();
  const focused = document.activeElement;
  const editingId = focused?.classList?.contains('tag-editor') ? focused.closest('.note-anchor')?.dataset.annotation : null;
  const selection = editingId ? [focused.selectionStart, focused.selectionEnd] : null;
  const editingSurface = focused?.closest('#text-preview,#text-host,#pdf-host,#word-host,#image-host') || $('text-host');
  const tags = activeTags();
  ui.editor?.setTags?.(tags.filter(tag => tag.anchorKind === 'text-selection').map(tag => ({ ...tag.anchor, tag, locationStatus: tag.resolution.locationStatus, contentStatus: tag.resolution.contentStatus })));
  ui.pdf?.setTags?.(tags.filter(tag => ['pdf-selection','pdf-region','image-region'].includes(tag.anchorKind)));
  ui.word?.setTags?.(tags.filter(tag=>['word-selection','word-region','ppt-selection','ppt-region'].includes(tag.anchorKind)));
  if (!$('text-preview').hidden && ui.file?.kind === 'text') projectPreviewTags();
  updateDisplayedOrdinals();
  renderTagPathNotices();
  if (editingId) {
    const editor = [...editingSurface.querySelectorAll('.note-anchor')].find(node => node.dataset.annotation === editingId)?.querySelector('.tag-editor');
    if (editor && !editor.hidden) { editor.focus({ preventScroll: true }); editor.setSelectionRange(...selection); }
  }
}
function consumeInitialTagEdit(id, surface) {
  if (ui.initialTagId !== id || ui.initialTagSurface !== surface) return false;
  ui.initialTagId = null; ui.initialTagSurface = null;
  return true;
}
function projectPreviewTags() {
  if(!ui.file || $('text-preview').hidden || !ui.editor || $('text-preview')._markdownSourceText!==ui.editor.adapter.getText())return;
  const seen=new Set();
  const projections=[
    ...visibleNotes(ui.file,ui.annotations||[]).filter(note=>note.kind==='text-selection').map(note=>({note,anchor:note.anchor})),
    ...activeTags().filter(tag=>tag.anchorKind==='text-selection').map(tag=>({tag,anchor:tag.anchor})),
  ].filter(p=>{const id=p.tag?.id||p.note?.id;if(!id||seen.has(id))return false;seen.add(id);return true;});
  const preview=$('text-preview');
  let layer=preview.querySelector('.markdown-annotations');
  // Projection ownership follows the mode: in split the interactive cards live
  // only on the left source editor; the preview keeps marks without mounting a
  // second editor copy (and stale read-mode cards must not survive the switch).
  if(ui.textMode!=='read'){layer?.replaceChildren();if(CSS.highlights&&typeof Highlight==='function')previewTagHighlights(projections,preview);}
  if(ui.textMode!=='read'){authorship.projectMarkdown();return;}
  if(!layer){layer=document.createElement('div');layer.className='markdown-annotations';preview.append(layer);}
  const previous=new Map(Array.from(layer.children,node=>[node.dataset.annotation,node]));
  const retained=new Set();
  const highlights={note:[],discuss:[]},base=preview.getBoundingClientRect(),positions=new Map();
  for(const projection of projections){
    const range=markdownRange(preview,projection.anchor);if(!range)continue;
    highlights[projection.tag?'discuss':'note'].push(range);
    const start=range.cloneRange();start.collapse(true);
    const rect=start.getBoundingClientRect();if(!rect.height)continue;
    const data=projection.tag||projection.note;
    // Layout/font changes reposition the same interactive projection. Retain
    // its input, focus, selection and any open menu until its content changes.
    const version=tagProjectionContent({...data,anchor:projection.anchor});
    let root=previous.get(data.id);
    if(root&&root._projectionVersion!==version&&projection.tag&&root.updateConversation?.(projection.tag))root._projectionVersion=version;
    if(!root||root._projectionVersion!==version){root?.remove();root=projection.tag?makeAnchorTag(projection.tag,{...tagActions,autoEdit:id=>consumeInitialTagEdit(id,'preview')}):makeNoteTag(projection.note,{...noteActions(ui.project.id),autoEdit:()=>false});root._projectionVersion=version;layer.append(root);}
    root.updateAnchor?.(projection.anchor);
    retained.add(data.id);
    const positionKey=Math.round(rect.left)+':'+Math.round(rect.top),slot=positions.get(positionKey)||0;positions.set(positionKey,slot+1);
    root.style.left=(rect.left-base.left+slot*20)+'px';root.style.top=(rect.top-base.top)+'px';root.relayout?.();
  }
  for(const [id,node]of previous)if(!retained.has(id))node.remove();
  if(CSS.highlights && typeof Highlight==='function')for(const [kind,ranges]of Object.entries(highlights))CSS.highlights.set('nozeli-md-'+kind,new Highlight(...ranges));
  authorship.projectMarkdown();
}
function previewTagHighlights(projections,preview){
  const highlights={note:[],discuss:[]};
  for(const projection of projections){const range=markdownRange(preview,projection.anchor);if(range)highlights[projection.tag?'discuss':'note'].push(range);}
  for(const [kind,ranges]of Object.entries(highlights))CSS.highlights.set('nozeli-md-'+kind,new Highlight(...ranges));
}
function addTag(material, { autoEdit = true, status = 'draft', text = '' } = {}) {
  const relPath = material.relPath || material.fileRelPath;
  if (!material.anchor || !ui.materialDigest) {
    workspace.toast('此选区没有可靠原文锚点，未创建标签。'); return null;
  }
  const tag = { id: crypto.randomUUID(), ordinal: 1, kind: 'discuss', drawing:material.drawing,anchorKind: material.kind, kindLabel: '对话', status, text, open: true, anchor: structuredClone(material.anchor), projectId: ui.project.id, relPath, materialDigest: ui.materialDigest, material, originAnchor: structuredClone(material.anchor), resolution: { targetDigest: ui.materialDigest, anchor: structuredClone(material.anchor), locationStatus: 'exact', contentStatus: 'unchanged' } };
  bindTagMessages(tag);
  ui.threads.set(tag.id, tag);
  persistTag(tag);
  if (autoEdit) {
    ui.initialTagId = tag.id;
    ui.initialTagSurface = ui.file.kind === 'image' ? 'image' : ui.file.kind === 'word' ? 'word' : ui.file.kind === 'pdf' ? 'pdf' : ui.textSelectionSurface === 'preview' && ui.textMode !== 'split' ? 'preview' : 'text';
  }
  projectTags();
  queueMicrotask(() => { if (ui.initialTagId === tag.id) { ui.initialTagId = null; ui.initialTagSurface = null; } });
  return tag;
}
function persistTag(tag) {
  const payload = { projectId: tag.projectId, relPath: tag.relPath, tagId: tag.id, regionImage:tag.material?.imageDataUrl?{dataUrl:tag.material.imageDataUrl,captureMode:tag.material.captureMode||'image-pixels',clipped:false}:undefined,drawing:tag.material?.drawing,annotatedImage:tag.material?.annotatedImage,sourceDraftDigest:tag.material?.sourceDraftDigest, displayLocation:tag.material?.displayLocation, materialDigest: tag.materialDigest, kind: tag.anchorKind, anchor: structuredClone(tag.originAnchor || tag.material.anchor), projection: { kind: tag.kind === 'explain' ? 'explain' : 'discuss', text: tag.text || '', draftText: tag.draftText || '', open: tag.open !== false, removed: tag.removed === true, status: tag.status, requestId: tag.requestId, messageId: tag.messageId,messageIds:tag.messageIds||[], history: (tag.history || []).map(entry => ({ question: entry.question, status: entry.status, requestId: entry.requestId, messageId: entry.messageId,messageIds:entry.messageIds||[] })), execute: tag.execute || null } };
  return enqueue(async () => { const result = await invoke('tag.put', payload); if (!result.ok) workspace.toast(`标签保存失败：${result.error.message}`); else tag.information=result.value?.annotation?.information||tag.information;return result; });
}
const discussionDrafts = createDiscussionDrafts();
const tagActions = {
  draw: id => editSavedDrawing(id),
  filePath: () => ui.file?.relPath || '', sourceText: () => ui.editor?.adapter.getText() || '',
  offset: workspace.offset, move: workspace.moveNote,
  size: workspace.chatSize, resize: workspace.resizeChat,
  remove: id => {
    const tag = ui.threads.get(id);
    if (!tag || tag.projectId !== ui.project?.id) return;
    // Removing a document projection never deletes messages or cancels the request.
    tag.removed = true; persistTag(tag);
    discussionDrafts.delete(tag.projectId,id);
    if (ui.initialTagId === id) { ui.initialTagId = null; ui.initialTagSurface = null; }
    projectTags();
  },
  onOpen: (id, open) => { const tag = ui.threads.get(id); if (tag) { tag.open = open; persistTag(tag); } },
  onDraft: (id, text) => {
    const tag = ui.threads.get(id);
    if (!tag || tag.projectId !== ui.project?.id) return;
    const previous = discussionDrafts.get(tag.projectId,id) || { version: 0, text: '' };
    discussionDrafts.set(tag.projectId,id, { ...previous, version: previous.version + 1, text });
    if (tag) { tag.draftText = text; if (tag.status === 'draft') tag.text = text; persistTag(tag); }
  },
  save: async (id, text) => {
    const tag = ui.threads.get(id);
    if (!tag || tag.kind !== 'discuss') return null;
    if (!text.trim() || tag.projectId !== ui.project?.id || tag.relPath !== ui.file?.relPath ) {
      workspace.toast('选区来源已变化或问题为空；草稿仍保留。'); return null;
    }
    if (tag.status === 'pending' || tag.status === 'accepted-awaiting-reply') return null;
    if (!['draft', 'completed', 'failed'].includes(tag.status)) return null;
    const projectId = tag.projectId;
    const before = discussionDrafts.get(projectId,id) || { version: 0, text: tag.text || '' };
    if (before.pending) return before.pending;
    const submittedVersion = before.version;
    const submittedText = text;
    const requestToken = Symbol(id);
    const state = { ...before, pendingToken: requestToken };
    const request = (async () => {
      try {
        const saved=await persistTag(tag);
        if(!saved?.ok)return null;
        if (ui.project?.id !== projectId || ui.threads.get(id) !== tag) return null;
        const result = await window.__agentSelectionAction?.({ action:'discuss', ...tag.material, annotationRef:{relPath:tag.relPath,annotationId:tag.id}, comment: submittedText });
        if (!result?.accepted) return null;
        const current = discussionDrafts.get(projectId,id);
        if (!ownsDiscussionReceipt({projectId,currentProjectId:ui.project?.id,tag,currentTag:ui.threads.get(id),state:current,token:requestToken})) return null;
        const accepted = { requestId: result.requestId, text: submittedText, status: 'accepted-awaiting-reply' };
        const draftChanged = current.version !== submittedVersion || current.text !== submittedText;
        discussionDrafts.set(projectId,id, { ...current, pending: null, pendingToken: null, accepted });
        tag.acceptedRequestId = accepted.requestId;
        tag.acceptedText = accepted.text;
        const previousRequestId=tag.requestId,previousMessageId=tag.messageId,previousMessageIds=tag.messageIds||[];
        tag.requestId = accepted.requestId;
        tag.messageId = null;tag.messageIds=[];
        tag.history = [...(tag.history?.length ? tag.history : (previousRequestId ? [{ question: tag.text, status: 'completed', requestId: previousRequestId, messageId: previousMessageId,messageIds:previousMessageIds }] : [])), { question: submittedText, status: 'accepted-awaiting-reply', requestId: accepted.requestId }];
        bindTagMessages(tag);
        if (draftChanged) { tag.status = 'draft'; tag.text = current.text; persistTag(tag); projectTags(); return null; }
        tag.status = 'accepted-awaiting-reply'; tag.text = submittedText; tag.draftText = ''; persistTag(tag); projectTags();
        return { text: submittedText };
      } finally {
        const current = discussionDrafts.get(projectId,id);
        if (current?.pendingToken === requestToken) discussionDrafts.set(projectId,id, { ...current, pending: null, pendingToken: null });
      }
    })();
    state.pending = request;
    discussionDrafts.set(projectId,id, state);
    return request;
  },

  execute: async (id, text) => {
    const tag = ui.threads.get(id);
    if (!tag || tag.kind !== 'discuss' || tag.projectId !== ui.project?.id) { workspace.toast('标签来源已变化，未执行。'); return; }
    if (tag.relPath !== ui.file?.relPath) { workspace.toast('请先打开该标签的来源文件再执行。'); return; }
    if (tag.execute?.jobId || (ui.executeSent || new Set()).has(id)) { setExecuteDisplay(id, '已提交 · 见工作与待办'); workspace.toast('这条标签已发送过执行，状态见标签与工作栏。'); return; }
    const instruction = String(text ?? tag.draftText ?? tag.text ?? '').trim();
    if (!instruction) { workspace.toast('先写下要执行的修改要求。'); return; }
    setExecuteDisplay(id, '保存并发送…');
    const saved = await persistTag(tag);
    if (!saved?.ok) { setExecuteDisplay(id, ''); workspace.toast('标签材料保存失败，未发送。'); return; }
    const result = await window.__agentSelectionAction?.({ action:'task', ...tag.material, annotationRef: { relPath: tag.relPath, annotationId: tag.id }, comment: instruction, background: true });
    if (result.legacy) { (ui.executeSent ||= new Set()).add(id); setExecuteDisplay(id, '已按前台问题发送（兼容模式，无后台执行链）'); return; }
    tag.execute = { jobId: result.requestId };
    (ui.executeLinks ||= new Map()).set(id, { jobId: result.requestId, projectId: tag.projectId });
    persistTag(tag);
    setExecuteDisplay(id, '已接收 · 排队中');
  },
};
const {bind:bindTagMessages,apply:applyAgentMessages}=createTagSessionProjection({
  currentProjectId:()=>ui.project?.id,tags:()=>ui.threads.values(),persistTag,renderTags:projectTags,
});

// Execute entries reuse the managed work chain; the tag only ever displays
// status derived from the program's own work records (never model wording).
const executeLabels = { pending:'已接收 · 排队中', queued:'已接收 · 排队中', transferring:'转入后台执行…', clarify:'需补充：请在对话中补充说明', failed:'执行失败 · 可从待办恢复', interrupted:'已中断 · 重启后可恢复', running:'执行中…', paused:'已暂停 · 见待办说明', review:'待你审查结果', closing:'历史结束处理中…', ended:'已结束 · 成果处置与技术收尾见工作记录' };
function setExecuteDisplay(annotationId, label) {
  for (const node of document.querySelectorAll(`[data-annotation="${CSS.escape(annotationId)}"]`)) node.updateExecuteStatus?.(label || '');
}
function syncExecuteLinks() {
  ui.executeLinks ||= new Map();
  for (const tag of ui.threads.values()) if (tag.execute?.jobId) ui.executeLinks.set(tag.id, { jobId: tag.execute.jobId, projectId: tag.projectId });
  for (const note of ui.annotations || []) if (note.execute?.jobId) ui.executeLinks.set(note.id, { jobId: note.execute.jobId, projectId: ui.project?.id });
}
function updateExecuteStatuses(state, projectId) {
  ui.executeLinks ||= new Map();
  if (!state || projectId !== ui.project?.id) return;
  const records = managedWorkRecords(state);
  for (const [annotationId, link] of ui.executeLinks) {
    if (link.projectId !== ui.project?.id) continue;
    const record = records.find(item => item.id === 'request:' + link.jobId || (item.jobIds || []).includes(link.jobId));
    setExecuteDisplay(annotationId, record ? (executeLabels[record.status] || '已提交 · 见工作与待办') : '已提交 · 见工作与待办');
  }
}
globalThis.window?.nozeli?.subscribe?.('agent', event => { if (event?.kind === 'managed-state') updateExecuteStatuses(event.state, event.projectId); });
function selectedMaterial() {
  if (!ui.project || !ui.file || !materialVisible(ui.file)) return null;
  if(sameNoteTarget(ui.frozenNote)&&ui.frozenNote.drawing){const d=ui.frozenNote;return {excerpt:'所选区域及其中的笔迹，文件和位置见随附材料',relPath:d.relPath,kind:d.kind,anchor:structuredClone(d.anchor),imageDataUrl:d.regionImage.dataUrl,captureMode:d.regionImage.captureMode,sourceDraftDigest:d.sourceDraftDigest,drawing:d.drawing};}
  if (ui.file.kind === 'text' && ui.editor) {
    const excerpt = ui.textMode === 'read' || ui.textSelectionSurface === 'preview' ? ui.previewAnchor?.quote : (() => {
      const selection = ui.editor.adapter.getSelection();
      return (selection.from === selection.to) ? '' : ui.editor.adapter.getText().slice(selection.from, selection.to);
    })();
    return excerpt?.trim() ? { excerpt, relPath: ui.file.relPath, materialText: ui.editor.adapter.getText(), anchor: captureLiveAnchor()?.anchor, kind: 'text-selection' } : null;
  }
  if(['word','ppt'].includes(ui.file.kind)){
    const selected=ui.wordSelection;if(!selected?.anchor)return null;
    return {excerpt:selected.anchor.quote||(selected.kind.endsWith('-region')?'所选区域，文件和位置见附件':''),relPath:ui.file.relPath,displayLocation:selected.displayLocation,anchor:structuredClone(selected.anchor),kind:selected.kind||'word-selection'};
  }
  const selection = ui.pdfSelection;
  if (!selection?.anchor) return null;
  const excerpt = selection.anchor.quote || (selection.kind.endsWith('-region') ? `图片 ${ui.file.relPath} 的所选区域（${selection.anchor.width}×${selection.anchor.height}，坐标见附件）` : '');
  return { excerpt, relPath: ui.file.relPath, anchor: structuredClone(selection.anchor), kind: selection.kind || 'pdf-selection', imageDataUrl: selection.anchor.imageDataUrl || selection.material?.imageDataUrl || '' };
}
const regionDriver=()=>ui.file?.kind==='ppt'?ui.word:ui.pdf;
const regionDrawing=mountRegionDrawing({
 getRect:d=>sameNoteTarget(d)?regionDriver()?.regionRect(d.anchor):null,
 getViewport:()=>{const frame=ui.file?.kind==='ppt'?$('ppt-frame'):null;return (frame||$('reader-scroll')).getBoundingClientRect();},
 onOwnership:value=>{regionDriver()?.drawingActive?.(value);$('selection-menu').hidden=true;},
 onError:message=>workspace.toast(message),
 onChange:drawing=>{if(!ui.frozenNote)return;ui.frozenNote={...ui.frozenNote,drawing};workspace.rememberNote(ui.frozenNote);writeView();},
 onCancel:(target,previous)=>{const {drawingEdit,...selection}=target;ui.frozenNote={...selection,drawing:previous};workspace.rememberNote(ui.frozenNote);writeView();const r=regionDriver()?.regionRect(target.anchor);if(r){if(ui.file.kind==='ppt')ui.wordSelection={kind:target.kind,anchor:target.anchor,rect:r};else ui.pdfSelection={kind:target.kind,anchor:target.anchor,viewportRect:r,material:{imageDataUrl:target.regionImage.dataUrl}};showSelectionMenu(r);}},
 onFinish:async(target,drawing,annotatedImage)=>{
  if(!sameNoteTarget(target))return;
  ui.frozenNote={...target,drawing,annotatedImage};workspace.rememberNote(ui.frozenNote);await writeView();
  if(target.drawingEdit){const result=await invoke('annotation.drawing',{projectId:target.projectId,relPath:target.relPath,annotationId:target.drawingEdit.id,materialDigest:target.materialDigest,expectedUpdatedAt:target.drawingEdit.updatedAt,regionImage:target.regionImage,drawing,annotatedImage});if(!result.ok){workspace.toast(result.error.message);$('note-form').hidden=false;updateNoteSource();return;}consumeDrawingDraft();await refreshNotes();return;}
  const r=regionDriver()?.regionRect(target.anchor);if(r){if(ui.file.kind==='ppt')ui.wordSelection={kind:target.kind,anchor:target.anchor,rect:r};else ui.pdfSelection={kind:target.kind,anchor:target.anchor,viewportRect:r,material:{imageDataUrl:target.regionImage.dataUrl}};showSelectionMenu(r);}else{workspace.toast('涂鸦草稿已保留，请回到原页继续。');$('note-form').hidden=false;updateNoteSource();}
 }
});
function consumeDrawingDraft(){if(!sameNoteTarget(ui.frozenNote)||!ui.frozenNote.drawing)return;workspace.rememberNote({...ui.frozenNote,text:'',drawing:null});ui.frozenNote=null;$('note-form').hidden=true;writeView();}
async function startDrawing(existing){
 const source=ui.file;if(!source||!['image','pdf','ppt'].includes(source.kind))return;
 try{
  if(!(await flushCurrent()).ok||ui.file!==source)return;
  let draft=existing;
  if(!draft){const selection=ui.file.kind==='ppt'?ui.wordSelection:ui.pdfSelection;if(!selection?.kind.endsWith('-region'))return;
   if(sameNoteTarget(ui.frozenNote)&&JSON.stringify(ui.frozenNote.anchor)===JSON.stringify(selection.anchor))draft=ui.frozenNote;
   else{rememberCurrentNote();let sourceDraftDigest;if(ui.file.kind==='ppt'){const r=await invoke('annotation.drawing.source',{projectId:ui.project.id,relPath:source.relPath,materialDigest:ui.materialDigest});if(!r.ok)throw Error(r.error.message);sourceDraftDigest=r.value.digest;}const regionImage=ui.file.kind==='ppt'?await ui.word.captureRegion(selection.anchor):{dataUrl:selection.material.imageDataUrl,captureMode:ui.file.kind==='image'?'image-pixels':'pdf-canvas',clipped:false};if(ui.file!==source)return;draft={projectId:ui.project.id,relPath:source.relPath,materialDigest:ui.materialDigest,kind:selection.kind,anchor:structuredClone(selection.anchor),regionImage,sourceDraftDigest,text:''};}
  }
  if(draft.kind==='ppt-region'){if(!(await flushCurrent()).ok||ui.file!==source)return;const r=await invoke('annotation.drawing.source',{projectId:draft.projectId,relPath:draft.relPath,materialDigest:draft.materialDigest});if(!r.ok||r.value.digest!==draft.sourceDraftDigest)throw Error('PPT草稿已变化；旧涂鸦保留，请重新框选');}
  if(!sameNoteTarget(draft)||!regionDriver()?.regionRect(draft.anchor))return workspace.toast('原页面或内容已变化，请回到原页；草稿仍保留。');
  ui.frozenNote=draft;$('note-input').value=draft.text||'';$('note-form').hidden=true;await regionDrawing.start(draft);
 }catch(error){workspace.toast(error.message);}
}
async function editSavedDrawing(id){
 const record=ui.annotations.find(n=>n.id===id);if(!record?.information?.drawing)return;
 try{const result=await invoke('annotation.drawing.read',{projectId:ui.project.id,relPath:ui.file.relPath,annotationId:id});if(!result.ok)throw Error(result.error.message);const v=result.value;await startDrawing({projectId:ui.project.id,relPath:record.relPath,materialDigest:record.materialDigest,kind:record.kind,anchor:record.anchor,text:'',regionImage:v.regionImage,sourceDraftDigest:v.sourceDraftDigest,drawing:record.information.drawing,drawingEdit:{id,updatedAt:record.updatedAt}});}catch(error){workspace.toast(error.message);}
}
$('selection-draw').onclick=()=>startDrawing();
async function preparedMaterial(){
 const material=selectedMaterial();if(!material)return null;
 if(/^(image|pdf|ppt)-region$/.test(material.kind)){
  if(!material.imageDataUrl&&material.kind==='ppt-region'){const image=await ui.word.captureRegion(material.anchor);material.imageDataUrl=image.dataUrl;material.captureMode=image.captureMode;}
  material.captureMode||=material.kind==='pdf-region'?'pdf-canvas':'image-pixels';
  if(material.drawing)material.annotatedImage=await compositeDrawing(material.imageDataUrl,material.drawing);
 }
 return material;
}
$('selection-discuss').addEventListener('click', async () => {
  const source = ui.file;
  if (!(await flushCurrent()).ok || ui.file !== source) return;
  const material = await preparedMaterial();
  if (!material) return workspace.toast('请选中可读取的文字或 PDF 区域。');
  if (material.kind==='word-region') return workspace.toast('当前模型未验证图片发送能力，区域已冻结并保留，未发送。');
  const tag=addTag(material);if(tag){const saved=await persistTag(tag);if(saved?.ok)consumeDrawingDraft();$('selection-menu').hidden = true;}
});
$('selection-explain').addEventListener('click', async () => {
  const source = ui.file;
  if (!(await flushCurrent()).ok || ui.file !== source) return;
  const selected = await preparedMaterial();
  if (!selected) return workspace.toast('请选中可读取的文字或 PDF 区域。');
  if (selected.kind==='word-region') return workspace.toast('当前模型未验证图片发送能力，区域已冻结并保留，未发送。');
  const question = '请解释这处选区。';
  const tag = addTag(selected, { autoEdit: false, status: 'pending', text: question });
  if (!tag) return;
  $('selection-menu').hidden = true;
  const saved=await persistTag(tag);
  if(!saved?.ok){tag.status='failed';projectTags();return;}
  consumeDrawingDraft();
  const result = await window.__agentSelectionAction?.({ action:'explain', ...selected, annotationRef:{relPath:tag.relPath,annotationId:tag.id} });
  tag.requestId = result?.requestId || null;
  tag.acceptedRequestId = result?.accepted ? result.requestId : null;
  tag.acceptedText = result?.accepted ? question : null;
  tag.status = result?.accepted ? 'accepted-awaiting-reply' : 'failed';
  tag.text = question;
  persistTag(tag); projectTags();
});
document.addEventListener('pointerdown', event => {
  if (event.button === 2 && event.target.closest('#documents')) return;
  if (event.target.closest('.nozeli-context-menu,#selection-menu,#note-form,#region-drawing,.textLayer,.region-selecting,#text-host')) return;
  $('selection-menu').hidden = true;
  if ($('note-form').hidden) { ui.pdfSelection = null; ui.pdf?.clearSelection(); }
});
// Selecting text inside todo/status buttons must not trigger their action.
document.addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0) return;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount || !String(selection).trim()) return;
  const range = selection.getRangeAt(0);
  const holder = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  if (holder && (holder === event.target || holder.contains(event.target))) {
    event.preventDefault(); event.stopPropagation();
  }
}, true);
const documentMenu = mountDocumentContextMenu({
  root: $('documents'),
  hideQuickActions: () => { $('selection-menu').hidden = true; },
  status: message => workspace.toast(message),
  surfaceAt(target) {
    if (target.closest('.document-diff')) {
      const diff = beside.diff;
      const editor = diff?.merge.a.dom.contains(target) ? diff.merge.a : diff?.merge.b.dom.contains(target) ? diff.merge.b : null;
      if (!editor) return null;
      const adapter = codeMirrorAdapter(editor, { readOnly: true });
      adapter.offsetAtPoint = (x, y) => editor.posAtCoords({ x, y });
      adapter.command = () => openSearchPanel(editor);
      return { adapter, snapshot: () => {
        const selection = adapter.getSelection(), text = adapter.getText();
        return { kind: 'text', secondary: true, editable: false, adapter, selection, text, copyText: text.slice(selection.from, selection.to), selected: selection.from !== selection.to, fontSize:workspace.snapshot().fontSize,canChangeComparison:true,diffVisible:true,current: () => beside.diff === diff };
      } };
    }
    const secondary = Boolean(target.closest('#secondary-text,#secondary-pdf,#secondary-scroll'));
    const file = secondary ? (beside.tex ? beside.texFile : beside.file) : ui.file;
    if (!file || target.closest('.document-diff')) return null;
    let element = target.closest('#text-host,#text-preview,#pdf-host,#secondary-text,#secondary-pdf,#image-host,#word-host,#unsupported');
    if (!element && target.closest('#markdown-preview-scroll')) element = $('text-preview');
    if (!element && secondary && target.closest('#secondary-scroll')) element = beside.pdf ? $('secondary-pdf') : $('secondary-text');
    if (!element || element.hidden || !['text', 'pdf','image','word','sheet','ppt','unsupported','legacy-word'].includes(file.kind)) return null;
    const editor = secondary ? beside.editor : ui.editor;
    const reading = ['pdf','image'].includes(file.kind) || element.id === 'text-preview';
    const adapter = !reading ? editor?.adapter : null;
    const projectId = ui.project.id;
    const sourceAtOpen = ui.file;
    // Recompilation replaces an artifact, not the source document owning its
    // preview controls. Keep that menu usable while a new PDF is published.
    const current = () => ui.project?.id === projectId && (secondary && file.generated
      ? beside.tex && ui.file === sourceAtOpen && beside.texFile?.relPath === file.relPath
      : (secondary ? beside.file : ui.file) === file) && element.isConnected && !element.hidden;
    return {
      adapter, reading, selectionRect: !secondary && ui.pdfSelection?.kind?.endsWith('-region') ? ui.selectionRect : null,
      clearSelection() { window.getSelection()?.removeAllRanges(); if (!secondary) { ui.previewAnchor = null; ui.pdfSelection = null; ui.selectionRect = null; ui.pdf?.clearSelection(); } },
      snapshot() {
        let selection = adapter?.getSelection(), text = adapter?.getText();
        const dom = window.getSelection();
        const domText = dom?.rangeCount && dom.anchorNode && dom.focusNode && element.contains(dom.anchorNode) && element.contains(dom.focusNode) ? dom.toString() : '';
        if (!secondary && reading && file.kind === 'text') {
          ui.textSelectionSurface = 'preview';
          const source = editor.adapter.getText();
          ui.previewAnchor = domText && element._markdownSourceText === source ? markdownSelection(element, dom.getRangeAt(0), source) : null;
        }
        const selected = adapter ? selection.from !== selection.to : Boolean(domText || (!secondary && ui.pdfSelection?.kind === 'pdf-region'));
        const anchor = secondary ? null : captureLiveAnchor();
        if (selected && reading) {
          const rect = dom?.rangeCount && !dom.isCollapsed ? dom.getRangeAt(0).getBoundingClientRect() : ui.selectionRect;
          if (rect && !secondary) ui.selectionRect = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        }
        return { kind: ['legacy-word','unsupported'].includes(file.kind)?'unsupported':file.kind, secondary, reading, editable: file.kind==='text'&&!secondary&&!reading, code: Boolean(languageIdForPath(file.relPath)), selected,
          relPath: file.relPath, buildId:file.buildId, projectId, adapter, editor, element, current, selection, text,link:element.id==='text-preview'?target.closest('a[href],.conversation-file-link'):null,
          panel:true,generated:file.generated,fontSize:file.kind==='text'?workspace.snapshot().fontSize:null,
          canOpenBeside:!secondary&&['text','pdf','image'].includes(file.kind),
          readingWidth:file.kind==='text'&&isMarkdownPath(file.relPath)?workspace.snapshot().readingWidth:null,
          canMode:!secondary&&file.kind==='text'&&!isCodePath(file.relPath)&&!/\.tex$/i.test(file.relPath),
          region:$(file.kind==='image'?'image-region':file.kind==='word'?'word-region':'pdf-region').getAttribute('aria-pressed')==='true',
          outline:$('pdf-outline-toggle').getAttribute('aria-expanded')==='true',canExport:file.kind==='ppt',
          canLog:!$('tex-diagnostics').hidden,logVisible:$('tex-diagnostics').open,
          canChangeComparison:secondary&&!beside.tex&&Boolean(beside.file),canDiff:secondary&&ui.file?.kind==='text'&&file.kind==='text',diffVisible:Boolean(beside.diff),
          texOptions:!$('tex-toolbar').hidden&&(!secondary||beside.tex)?{roots:Array.from($('tex-root').options,n=>n.value).filter(Boolean),root:$('tex-root').value,engines:Array.from($('tex-engine').options,n=>n.value).filter(Boolean),engine:$('tex-engine').value,building:!$('tex-cancel').hidden}:null,
          copyText: adapter ? text.slice(selection.from, selection.to) : domText,
          canAuthorship: !secondary && ['text','word'].includes(file.kind),authorshipVisible:authorship.isVisible(),
          canFind:['text','pdf'].includes(file.kind),canCompare:!secondary&&file.kind==='text',wordWrap:adapter?.isWrapped?.(),
          canFold:typeof adapter?.foldAll==='function'&&typeof adapter?.unfoldAll==='function',
          preview: !secondary && file.kind==='text' && isMarkdownPath(file.relPath) ? {
            kind:'markdown',visible:ui.textMode==='split',linked:markdownWorkspace.snapshot().linked,
          } : (secondary && beside.tex || !secondary && file.kind==='text' && /\.(tex|sty|cls)$/i.test(file.relPath) && !$('tex-toolbar').hidden) ? {
            kind:'tex',visible:beside.tex&&$('tex-preview').getAttribute('aria-pressed')==='true',linked:$('tex-sync').getAttribute('aria-pressed')==='true',
            automatic:$('tex-auto').checked,available:$('tex-sync').dataset.state!=='unavailable',hint:$('tex-sync').title,
          } : null,
          canAnnotate: !secondary && !file.sourceChanged && (file.kind === 'pdf' || Boolean(anchor)),
          canDiscuss: !secondary && selected && Boolean(anchor) && !ui.pdfSelection?.kind?.includes('region'),
          canExplain: !secondary && !$('selection-explain').disabled && selected && Boolean(anchor) && !ui.pdfSelection?.kind?.includes('region'),
          page: (secondary ? beside.pdf : ui.pdf)?.current() || 1,
          pages:(secondary ? beside.pdf : ui.pdf)?.pageCount?.(),
        };
      },
    };
  },
  async run(command, s) {
    if(command.startsWith('document-font-')) {
      const control={'document-font-larger':'font-larger','document-font-smaller':'font-smaller','document-font-reset':'font-reset'}[command];
      return (control?$(control):document.querySelector('[data-reader-font="'+command.slice(14)+'"]'))?.click();
    }
    if(command.startsWith('reading-width-'))return document.querySelector('[data-reading-width="'+command.slice(14)+'"]')?.click();
    if(command==='text-mode')return $('text-mode-toggle').click();
    if(command==='openBeside')return $('open-beside').click();
    if(command==='comparison-change')return comparisonChange.click();
    if(command==='comparison-diff')return setDiffMode(!s.diffVisible);
    if(command==='exportPpt')return $('ppt-export')?.click();
    if(command==='tex-log'){ $('tex-diagnostics').open=!$('tex-diagnostics').open; return; }
    if(command==='tex-cancel')return $('tex-cancel').click();
    if(command.startsWith('tex-root-')||command.startsWith('tex-engine-')){
      const root=command.startsWith('tex-root-'),control=$(root?'tex-root':'tex-engine');
      control.value=(root?s.texOptions.roots:s.texOptions.engines)[Number(command.split('-').at(-1))];
      control.dispatchEvent(new Event('change'));return;
    }
    if(command==='pdf-outline')return $('pdf-outline-toggle').click();
    if(command==='region')return $(s.kind==='image'?'image-region':s.kind==='word'?'word-region':'pdf-region').click();
    if(command==='zoom-in'||command==='zoom-out')return $(s.secondary?'secondary-zoom-'+(command==='zoom-in'?'in':'out'):s.kind==='image'?'image-'+(command==='zoom-in'?'in':'out'):s.kind==='word'?'word-'+command:'pdf-'+command).click();
    if(command==='page-prev'||command==='page-next')return $(s.secondary?'secondary-'+(command==='page-prev'?'prev':'next'):'pdf-'+(command==='page-prev'?'prev':'next')).click();
    if(command==='authorship-toggle')return authorship.toggle();
    if(command==='authorship-history')return authorship.history();
    if(command==='compareFile'||command==='compareHistory')return comparison.open(command==='compareFile'?'file':'history');
    if(command==='texBuild')return $('tex-build').click();
    if(command==='tex-auto')return $('tex-auto').click();
    if(command==='preview-toggle')return $(s.preview.kind==='markdown'?'markdown-preview-toggle':'tex-preview').click();
    if(command==='preview-link')return $(s.preview.kind==='markdown'?'markdown-sync':'tex-sync').click();
    if(command==='linkOpen')return s.link?.click();
    if(command==='linkCopy')return invoke('document.clipboard',{action:'write',text:s.link?.getAttribute('href')||s.link?.dataset.path||s.link?.textContent||''});
    if(['openExternal','reveal','relativePath'].includes(command)){
      if(command==='openExternal'&&!s.secondary){const saved=await flushNow();if(!saved.ok||!s.current())return;}
      const result=await invoke('tree.path',{projectId:s.projectId,relPath:s.relPath,action:command});if(!result.ok)throw Error(result.error.message);return result;
    }
    if(command==='imageInfo')return workspace.toast($('image-size').textContent+' · '+s.relPath);
    if(command==='wordWrap')return s.adapter?.command('wordWrap');
    if(command==='foldAll'||command==='unfoldAll')return s.adapter?.[command]();
    if(command==='page')return $('pdf-page').focus();
    const adapter = s.adapter;
    const stillSame = () => s.current() && (!adapter || (adapter.getText() === s.text && adapter.getSelection().anchor===s.selection.anchor && adapter.getSelection().head===s.selection.head));
    const clipboard = async (action, text) => { const result = await invoke('document.clipboard', { action, text }); if (!result.ok) throw new Error(result.error.message); return result.value; };
    if (command === 'copy') return clipboard('write', s.copyText);
    if (command === 'pageReference') return clipboard('write', `${s.relPath}${s.preview?.kind==='tex'?'（编译PDF · '+s.buildId.slice(0,8)+'）':''} · 第 ${s.page} 页`);
    if (command === 'cut' || command === 'paste') {
      const insert = command === 'paste' ? await clipboard('read') : (await clipboard('write', s.copyText), '');
      if (!stillSame()) return workspace.toast('文档内容已变化，未应用剪贴板操作。');
      adapter.applyEdit({ from: s.selection.from, to: s.selection.to, insert }); adapter.setSelection(s.selection.from + insert.length); adapter.focus(); return;
    }
    if (command === 'undo' || command === 'redo') { adapter[command](); adapter.focus(); return; }
    if (command === 'selectAll') { adapter.setSelection(0, adapter.getText().length); adapter.focus(); return; }
    if (command === 'format' || command === 'formatSelection') return formatEditor({ ...s, status: message => { $('code-status').textContent = message; } }, command === 'formatSelection');
    if (command === 'definition') return s.editor.jumpToDefinition?.();
    if (command === 'comment' || command === 'replace' || (command === 'find' && adapter)) return adapter.command(command);
    if (command === 'find') {
      if (s.kind === 'pdf' && !s.secondary) { $('pdf-search').hidden = false; $('pdf-query').focus(); return; }
      return findInReadingSurface(s.element, message => workspace.toast(message));
    }
    if (command === 'edit') { setTextMode(isMarkdownPath(s.relPath)?'split':'edit'); return writeView(); }
    if(['fit','fitPage','actual'].includes(command)){if(s.kind==='word')return ui.word?.zoom?.(command==='fit'?'fit':'reset');const view=s.secondary?beside.pdf:ui.pdf;await view?.zoom(command==='fit'?null:command==='fitPage'?'page':'actual');if(s.preview?.kind==='tex')await texWorkspace.persist();return;}
  },
});

// Header menus inspect the current surface without moving its live caret.
function primaryMenuTarget(){return [$('text-host'),$('text-preview'),$('pdf-host'),$('image-host'),$('word-host'),$('unsupported')].find(node=>!node.hidden);}
$('document-more').addEventListener('click',()=>{const target=primaryMenuTarget();if(target)documentMenu.openMore(target,$('document-more'));});
$('secondary-more').addEventListener('click',()=>{const target=beside.diff?.merge.b.dom||(beside.pdf?$('secondary-pdf'):$('secondary-text'));documentMenu.openMore(target,$('secondary-more'));});
// A driver can notify the host asynchronously after its own menu is visible.
// Close the current native menu directly when any host menu takes ownership.
window.addEventListener('project-view-change',event=>{if(event.detail==='terminal')regionDrawing.suspend();});
window.addEventListener('nozeli-context-menu-open',event=>{if(['word','sheet','ppt'].includes(ui.file?.kind)&&event.detail!==ui.file.kind)ui.word?.closeContextMenu?.();});

// Only deliberate selection input can reactivate the annotation toolbar.
$('documents').addEventListener('pointerdown',event=>{if(event.button===0&&!event.target.closest('.tag-window,.note-anchor,#note-form,input,button,a')&&event.target.closest('#text-host,#text-preview,#pdf-host,#image-host,#secondary-text,#secondary-pdf'))documentMenu.resumeSelection();},true);
$('documents').addEventListener('keydown',event=>{if((event.shiftKey&&/^(Arrow|Home|End)/.test(event.key))||((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'))documentMenu.resumeSelection();},true);

$('file-filter').addEventListener('input', () => { fileTreeState().searchClosed.clear(); filterTree(); });
// The empty workspace is its own base layer under files and reports; it never
// forces the conversation layout and keeps whatever the user last arranged.
function renderEmptyState() {
  const project = ui.project;
  $('empty-title').textContent = project ? '工作区暂无打开的文件' : '从一份材料开始';
  $('empty-desc').textContent = project ? '从左侧选择文件继续阅读，或打开对话讨论。关闭文件不会结束后台任务。' : '打开项目，阅读论文，留下想法。';
  $('welcome-open').hidden = Boolean(project);
  $('empty-browse').hidden = !project;
  $('empty-hint').hidden = Boolean(project);
  $('empty').hidden = false;
  if (project) { $('subject-title').textContent = '未打开文件'; $('file-section-label').textContent = '文件'; }
}
$('empty-browse').addEventListener('click', () => {
  if ($('file-toggle').getAttribute('aria-expanded') !== 'true') $('file-toggle').click();
  $('file-filter').focus();
});
async function closeCurrentSubject(preserveDraft=false) {
  if (workspace.hasOverflowEdits(ui.project?.id)) { await flushNow(); return false; }
  frozenChangeReader.restore({focus:false});
  if(preserveDraft){
    if(ui.file?.kind!=='text'||!ui.editor)return false;
    if(ui.composing){workspace.toast('输入法组合尚未结束，未关闭。');return false;}
    window.clearTimeout(ui.timer);
    const saved=await invoke('file.retain',{projectId:ui.project.id,relPath:ui.file.relPath,baseDigest:ui.baseDigest,text:ui.editor.adapter.getText()});
    if(!saved.ok){showFailure(saved.error);return false;}
  }else if (!(await flushNow()).ok) return false;
  const viewed = await writeView();
  if (!viewed.ok) return false;
  destroySurface(); closeBeside(); ui.file = null; ui.dirty = false;
  clearFailure();
  window.dispatchEvent(new Event('nozeli-content-closed'));
  ui.managedReport = null;
  await invoke('lsp.stop').catch(() => {});
  renderEmptyState();
  $('file-path').textContent = '选择文件开始阅读';
  $('context-bar').textContent = ui.project?.name || '项目对话';
  document.querySelectorAll('#file-tree button').forEach(b => b.setAttribute('aria-current', 'false'));
  projectTags();
  setStatus('idle', '未打开'); await writeView(); return true;
}
$('close-subject').addEventListener('click', () => enqueue(()=>ui.file?closeFileTab(ui.file.relPath):closeCurrentSubject(), true));
$('retain-file-close').addEventListener('click',()=>enqueue(async()=>{if(ui.file?.kind==='text'&&await closeCurrentSubject(true)){renderFileTabs();workspace.toast('文本副本已保留，仍可从已打开列表查看；未重建原路径。');}},true));
document.addEventListener('keydown',event=>{if(!(event.ctrlKey||event.metaKey)||document.body.classList.contains('provider-console-open')||document.querySelector('dialog[open]'))return;if(event.key.toLowerCase()==='w'&&ui.file){event.preventDefault();enqueue(()=>closeFileTab(ui.file.relPath),true);}if(event.key==='Tab'&&openFilesState.paths.length){event.preventDefault();const paths=openFilesState.paths,index=paths.indexOf(ui.file?.relPath);openFile(paths[(index+(event.shiftKey?-1:1)+paths.length)%paths.length]);}});
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); flushCurrent(); } });
for (const [id, factor] of [['pdf-zoom-in', 1.2], ['pdf-zoom-out', 1/1.2], ['pdf-fit', null]]) $(id).addEventListener('click', () => enqueue(() => ui.pdf?.zoom(factor)));
$('pdf-outline-toggle').addEventListener('click', () => enqueue(async () => {
  if (!ui.pdf) return;
  const opening = $('pdf-outline').hidden;
  $('pdf-outline').hidden = !opening; $('pdf-outline-toggle').setAttribute('aria-expanded', String(opening));
  if (!opening) return;
  const entries = await ui.pdf.outline(); $('pdf-outline').replaceChildren();
  if (!entries.length) $('pdf-outline').textContent = '此 PDF 没有内置目录。';
  for (const entry of entries) {
    const b = document.createElement('button'); b.textContent = entry.title; b.style.paddingLeft = (entry.depth * 12 + 4) + 'px';
    b.addEventListener('click', () => enqueue(() => ui.pdf?.go(entry.page))); $('pdf-outline').append(b);
  }
  }));
  $('pdf-search-toggle').addEventListener('click', () => { $('pdf-search').hidden = !$('pdf-search').hidden; if (!$('pdf-search').hidden) $('pdf-query').focus(); });
  async function searchPdf(next = false) {
    const pdf = ui.pdf;
    if (!pdf) return;
    const token = ++searchToken;
    $('pdf-search-status').textContent = '查找中…';
    try {
      const result = await pdf.search($('pdf-query').value, next, () => token !== searchToken || ui.pdf !== pdf);
      if (!result || result.cancelled || token !== searchToken || ui.pdf !== pdf) return;
      $('pdf-search-status').textContent = result.total ? (result.index + 1) + ' / ' + result.total + ' 页匹配' : '未找到（扫描页需要 OCR）';
    } catch {
      if (token !== searchToken || ui.pdf !== pdf) return;
      $('pdf-search-status').textContent = '搜索已中断';
    }
  }
  $('pdf-search').addEventListener('submit', event => { event.preventDefault(); searchPdf(); });
  $('pdf-search-next').addEventListener('click', () => searchPdf(true));
function closeBeside() {
  if (beside.tex) texWorkspace.paneClosed();
  beside.tex = false; beside.texBuildId = null; beside.texFile = null;
  setDiffMode(false);
  $('secondary-pane').querySelector('.compare-switch').hidden = false;
  $('secondary-pane').classList.remove('tex-stale');
  $('secondary-pane').setAttribute('aria-label', '对照文档，只读');
  documentMenu.close();
  beside.editor?.destroy(); beside.editor = null; beside.pdf?.destroy(); beside.pdf = null; beside.file = null;
  $('diff-mode').disabled = true; $('diff-mode').title = '需要两侧都打开文本文件';
  $('secondary-pane').hidden = true; $('pane-divider').hidden = true; $('documents').classList.remove('dual');
}
$('secondary-close').addEventListener('click', () => closeBeside());
$('secondary-prev').addEventListener('click', () => enqueue(() => beside.pdf?.go(beside.pdf.current() - 1)));
$('secondary-next').addEventListener('click', () => enqueue(() => beside.pdf?.go(beside.pdf.current() + 1)));
$('secondary-zoom-out').addEventListener('click', () => enqueue(async () => { await beside.pdf?.zoom(1 / 1.15); await texWorkspace.persist(); }));
$('secondary-zoom-in').addEventListener('click', () => enqueue(async () => { await beside.pdf?.zoom(1.15); await texWorkspace.persist(); }));
$('secondary-fit').addEventListener('click', () => enqueue(async () => { await beside.pdf?.zoom(null); $('secondary-scroll').scrollTop = 0; $('secondary-scroll').scrollLeft = 0; await texWorkspace.persist(); }));
async function openBesideSnapshot(file, diff=false) {
    if(!ui.project)return;
    if (ui.textMode === 'split') setTextMode('edit');
    closeBeside();const relPath=file.relPath;
    beside.file = { ...file, text: file.draft?.text ?? file.text };
    $('secondary-text').hidden = true; $('secondary-pdf').hidden = true; $('secondary-tools').hidden = true; $('secondary-message').hidden = true;
    $('secondary-pane').hidden = false; $('pane-divider').hidden = false; $('documents').classList.add('dual'); $('secondary-path').dataset.iconPath=relPath; $('secondary-path').textContent = relPath+(file.version?' · '+versionCaption(file.version):'');$('secondary-path').title=$('secondary-path').textContent+(file.draft?' · 草稿快照':' · 只读快照');
    $('secondary-pane').setAttribute('aria-label',file.version?'历史版本，只读':'对照文档，只读');
    $('diff-mode').disabled = ui.file?.kind !== 'text' || file.kind !== 'text';
    $('diff-mode').title = $('diff-mode').disabled ? 'Diff 仅支持两侧文本文件' : '比较当前文本与右侧打开时的快照';
    if (file.kind === 'text') beside.editor = mountText({ parent: $('secondary-text'), relPath, text: beside.file.text, readOnly: true });
    else if (file.kind === 'pdf') {
      $('secondary-tools').hidden = false;
      beside.pdf = await mountPdf({ parent: $('secondary-pdf'), bytes: file.bytes, page: 1, onPage: (p, count) => { $('secondary-page').textContent = p + ' / ' + count; } });
    } else { $('secondary-message').hidden = false; $('secondary-message').textContent = file.unsupportedReason || '此格式尚未迁移。'; }
    if(diff)setDiffMode(true);
}

  window.__nozeliInput = {
    text: () => ui.editor?.adapter.getText() ?? '',
    selection: () => ui.editor?.adapter.getSelection() ?? null,
    focus: () => ui.editor?.adapter.focus?.(),
    insert(text) {
      const view = ui.editor;
      if (!view) return '';
      view.adapter.applyEdit({ from: view.adapter.getText().length, insert: text });
      return view.adapter.getText();
    },
    selectAll() {
      const view = ui.editor;
      if (!view) return;
      view.adapter.setSelection(0, view.adapter.getText().length);
    },
    select(from, to) {
      const view = ui.editor;
      if (!view) return;
      view.adapter.setSelection(from, to);
    },
    replace(text) {
      const view = ui.editor;
      if (!view) return '';
      view.adapter.applyEdit({ from: 0, to: view.adapter.getText().length, insert: text });
      return view.adapter.getText();
    },
  };
  window.nozeli.subscribe('session.flush', () => enqueue(async () => {
    rememberCurrentNote();
    await texWorkspace.persist();
    const saved = await flushNow();
    if (!saved.ok || ui.viewBlocked) return saved;
    return writeView();
  }, true));
  window.nozeli.subscribe('document.sync',request=>{
    void enqueue(async()=>{
      if(ui.project?.id!==request.projectId||ui.file?.relPath!==request.relPath)return {ok:true};
      // Reject synchronization before making the surface inert: taking focus
      // away here would terminate an in-flight native IME composition.
      if(ui.composing)return flushNow();
      // 持锁期间不再 inert：Agent 合入的串行化由宿主文件锁保证，用户键入经
      // flushNow 冲刷，合成事件经 rebased.pending 保留；阻断键入会丢字。
      if(request.hold)ui.documentHolds.add(request.requestId);
      return flushNow();
    }).then(result=>invoke('document.synced',{requestId:request.requestId,result}));
  });
  window.nozeli.subscribe('document.release',requestId=>{ui.documentHolds.delete(requestId);$('text-host').inert=ui.documentHolds.size>0;});
  async function applyDocumentEvent(event) {
    if (ui.project?.id !== event.projectId || ui.file?.relPath !== event.relPath || ui.file.kind !== 'text') return;
    if (!event.changes || typeof event.text !== 'string' || !event.authorship || !ui.editor?.adapter.applyRemoteChanges) return;
    if (ui.composing) { ui.pendingDocumentEvents.push(event); return; }
    if (event.digest === ui.baseDigest) return;
    if (event.beforeDigest !== ui.baseDigest) {
      workspace.toast('文档版本与当前工作面不一致；已保留你的输入，请查看修改记录。');
      return;
    }
    const adapter = ui.editor.adapter;
    let rebased;
    try { rebased = rebaseDocumentEvent({ before: ui.lastSavedText, current: adapter.getText(), transactions: ui.anchorTransactions, event }); }
    catch (error) { workspace.toast('Agent 修改未覆盖当前输入：' + error.message); return; }
    adapter.applyRemoteChanges(rebased.remote);
    ui.baseDigest = ui.file.digest = event.digest;
    ui.materialDigest = ui.file.materialDigest = event.materialDigest;
    ui.lastSavedText = ui.file.text = event.text;
    ui.file.draft = null; ui.file.sourceChanged = false; ui.file.diskPresent = true;
    ui.file.authorship = event.authorship;
    ui.anchorTransactions = rebased.pending.empty ? [] : [rebased.pending];
    ui.dirty = !rebased.pending.empty;
    authorship.saved(event.authorship, event.text);
    if (ui.dirty) authorship.changed({ before: event.text, text: adapter.getText(), changes: rebased.pending });
    else {
      window.clearTimeout(ui.timer); window.clearTimeout(ui.maxTimer); ui.maxTimer = 0; ui.dirtySince = 0;
      clearFailure(); setStatus('saved', '已保存 · Agent 修改已合入');
    }
    renderFileTabs();
    markdownWorkspace.refresh();
    await refreshNotes();
  }
  window.nozeli.subscribe('document', event => { void enqueue(() => applyDocumentEvent(event)); });
  async function openManaged(report) {
    return enqueue(async () => {
      if(report.projectId&&report.projectId!==ui.project?.id)return {ok:false,error:{message:'项目已切换，原报告未打开。'}};
      if(report.isCurrent&&!report.isCurrent())return {ok:false};
      const flushed = await flushNow();
      if (!flushed.ok) return flushed;
      if(report.projectId&&report.projectId!==ui.project?.id||report.isCurrent&&!report.isCurrent())return {ok:false};
      destroySurface();
      ui.file = null;
      const {isCurrent,...material}=report;ui.managedReport = material;
      renderFileTabs();
      $('close-subject').hidden = false;
      workspace.revealContent();
      $('file-section-label').textContent = '文件';
      $('empty').hidden = true;
      $('managed-doc').hidden = false;
      $('managed-doc').textContent = report.text || '';
      $('file-path').textContent = report.history ? (report.historyMode==='offline'?'离线历史':'历史报告')+' · 原版本只读 · 原件保留' : report.objectId ? '外置报告 · 原件保留' : report.writtenBack === false ? '报告 · 未写回源文件' : report.writtenBack === true ? '报告 · 已检测到源文件变化' : '报告 · 写回未核验';
      $('subject-title').textContent = report.title || '报告';
      $('save-status').dataset.state = 'idle';
      $('save-status').textContent = report.historyError ? '读取失败 · 原记录保留' : report.history ? '只读 · 可另存到项目目录' : report.objectId ? '可另存到项目目录' : report.writtenBack === false ? '未写回源文件' : report.writtenBack === true ? '源文件有变化' : '写回未核验';
    });
  }
  mountAgent({invoke,toast:text=>workspace.toast(text),attachment:()=>ui.managedReport || ui.file?.kind!=='text'?null:ui.file.relPath,openManaged,openFrozenChange,onMessages:applyAgentMessages,
    onConversation:info=>workspace.conversationContent(info),
    openProjectFile:target=>target.projectId===ui.project?.id?openMarkdownTarget(target):null,
    openExternal:url=>invoke('links.openExternal',{url}).then(result=>{if(!result.ok)workspace.toast(result.error.message);}),
  });
      let openingExternal=false, externalAgain=false;
      async function drainExternalOpen(){
        if(!window.__nozeliReady)return;
        if(openingExternal){externalAgain=true;return;}
        openingExternal=true;
        try{do{externalAgain=false;for(;;){const next=await invoke('session.takeOpen');if(!next.ok){workspace.toast('打开文件失败：'+next.error.message);break;}if(!next.value)break;const {projectId,relPath}=next.value;if(ui.project?.id!==projectId)await activateProject(projectId);if(ui.project?.id===projectId&&relPath)await openFile(relPath);}}while(externalAgain);}
        finally{openingExternal=false;}
      }
      window.nozeli.subscribe('external.open',()=>void drainExternalOpen().catch(showFailure));
      window.__nozeliReady = false;
      async function restoreLast() {
        await authorship.ready;
        const recent = await invoke('project.recent');
        const project = recent.ok ? recent.value.projects.find((item) => item.available) : null;
        if (project) await activateProject(project.id);
        else await renderRecent();
      }
      restoreLast()
        .catch((error) => showFailure(error))
        .finally(() => { window.__nozeliReady = true; void drainExternalOpen().catch(showFailure); });
