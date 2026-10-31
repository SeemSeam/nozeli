// Fetch and verify the pinned upstream Git archive before applying the host bridge.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
import fs from 'node:fs/promises';import path from 'node:path';
const revision='82ecf10040ca8da67832f173b58d3baf5da59887';
const sourceSha256='f23dfaf45708a1cf04cabaa08077a16e00c2b5244e76d6821df56265a1c67c81';
const root=path.resolve(import.meta.dirname,'..'),vendor=path.join(root,'vendor/pptist');
const output=path.join(root,'.test-output');await fs.mkdir(output,{recursive:true});
const temporary=await fs.mkdtemp(path.join(output,'pptist-build-')),work=path.join(temporary,'source');
const archive=path.join(temporary,'upstream.tar');
const run=(bin,args)=>{const r=spawnSync(bin,args,{cwd:work,stdio:'inherit',shell:process.platform==='win32'});if(r.error)throw r.error;if(r.status!==0)throw Error(bin+' failed with status '+r.status);};
try {
await fs.mkdir(work);
run('git',['init','.']);
run('git',['remote','add','origin','https://github.com/pipipi-pikachu/PPTist.git']);
run('git',['fetch','--depth=1','origin',revision]);
run('git',['-c','core.autocrlf=false','archive','--format=tar','--output='+archive,revision]);
const digest=createHash('sha256');for await(const chunk of createReadStream(archive))digest.update(chunk);
const actual=digest.digest('hex');if(actual!==sourceSha256)throw Error('PPTist source SHA-256 mismatch: '+actual);
run('tar',['-xf',archive]);
const app=path.join(work,'src/App.vue');let s=await fs.readFile(app,'utf8');
s=s.replace("import { onMounted } from 'vue'","import { onMounted } from 'vue'\nimport useImport from '@/hooks/useImport'\nimport useExport from '@/hooks/useExport'\nimport { toCanvas } from 'html-to-image'\nimport { cancelPendingSnapshot } from '@/hooks/useHistorySnapshot'\nimport { db } from '@/utils/database'\nimport { flushPptTextCommits } from '@/utils/nozeliTextCommits'");
// Chromium copies logical inset declarations too; reset both logical and
// physical coordinates on the detached screenshot root to avoid canvas offsets.
s=s.replace('const slidesStore = useSlidesStore()',`const slidesStore = useSlidesStore()
const importer=useImport(),exporter=useExport()
;(window as any).__nozeliPptist={ready:false,captureSlide:async()=>{await document.fonts.ready;const node=document.querySelector('.canvas .viewport-wrapper') as HTMLElement;if(!node)throw Error('幻灯片尚未显示');const b=node.getBoundingClientRect(),operates=node.querySelector('.operates'),background=node.querySelector('.viewport-background');return toCanvas(node,{width:b.width,height:b.height,pixelRatio:2,fontEmbedCSS:'',style:{position:'relative',inset:'auto',insetBlock:'auto',insetInline:'auto',insetBlockStart:'0px',insetInlineStart:'0px',insetBlockEnd:'auto',insetInlineEnd:'auto',left:'0px',top:'0px',right:'auto',bottom:'auto',margin:'0px',boxShadow:'none'},filter:(n:HTMLElement)=>!n.classList?.contains('grid-lines')&&(!operates?.contains(n)||n===operates||!!background?.contains(n))})},flushText:flushPptTextCommits,store:slidesStore,main:mainStore,history:useSnapshotStore(),resetHistory:async()=>{await cancelPendingSnapshot();await db.snapshots.clear();await useSnapshotStore().initSnapshotDatabase()},importFile:importer.importPPTXFile,exportFile:()=>{flushPptTextCommits();return exporter.exportPPTX(slidesStore.slides,false,false)},busy:()=>importer.exporting.value||exporter.exporting.value}`);
s=s.replace('snapshotStore.initSnapshotDatabase()', 'await snapshotStore.initSnapshotDatabase()\n    ;(window as any).__nozeliPptist.ready=true');
s=s.replace('store:slidesStore,main:mainStore,',`setReadOnly:(value:boolean)=>{if(!value)return;screenStore.setScreening(true);screenStore.$subscribe(()=>{if(!screenStore.screening)screenStore.setScreening(true)},{flush:'sync'});document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation()}},true)},store:slidesStore,main:mainStore,`);
await fs.writeFile(app,s);
// Import/restore establishes a document-specific undo baseline. Shared pending
// snapshots must flush before undo, including an undo immediately after a menu
// action; independent debounce instances could otherwise restore the demo.
const history=path.join(work,'src/hooks/useHistorySnapshot.ts');
s=await fs.readFile(history,'utf8');
s=s.replace("import { debounce, throttle} from 'lodash'",`import { throttle } from 'lodash'
let pending: ReturnType<typeof setTimeout> | undefined
let requested=false
let writing: Promise<unknown>=Promise.resolve()
export async function flushPendingSnapshot(){
  clearTimeout(pending);pending=undefined
  if(requested){requested=false;writing=writing.then(()=>useSnapshotStore().addSnapshot())}
  await writing
}
export async function cancelPendingSnapshot(){clearTimeout(pending);pending=undefined;requested=false;await writing}`);
s=s.replace(/const addHistorySnapshot = debounce\(function\(\) \{\s*snapshotStore\.addSnapshot\(\)\s*\}, 300, \{ trailing: true \}\)/,`const addHistorySnapshot = () => {clearTimeout(pending);requested=true;pending=setTimeout(()=>{void flushPendingSnapshot()},300)}`);
s=s.replace('throttle(function() {\n    snapshotStore.reDo()', 'throttle(async function() {\n    await flushPendingSnapshot()\n    await snapshotStore.reDo()');
s=s.replace('throttle(function() {\n    snapshotStore.unDo()', 'throttle(async function() {\n    await flushPendingSnapshot()\n    await snapshotStore.unDo()');
await fs.writeFile(history,s);
// Rich text is debounced upstream. Every host snapshot/export must first
// commit the live editor value, rather than exporting a stale Pinia model.
await fs.copyFile(path.join(root,'src/renderer/ppt-text-commits.mjs'),path.join(work,'src/utils/nozeliTextCommits.js'));
const richText=path.join(work,'src/views/components/element/ProsemirrorEditor.vue');
s=await fs.readFile(richText,'utf8');
if(!s.includes('const handleInput = debounce(function(isHanldeHistory = false) {'))throw Error('Pinned PPTist text commit hook changed');
s=s.replace("import { debounce } from 'lodash'","import { debounce } from 'lodash'\nimport { registerPptTextCommit } from '@/utils/nozeliTextCommits'");
if((s.match(/editorView\.dom\.innerHTML/g)||[]).length!==2)throw Error('Pinned PPTist text serialization hook changed');
s=s.replaceAll('editorView.dom.innerHTML','html');
s=s.replace('const handleInput = debounce(function(isHanldeHistory = false) {',`let lastCommittedValue: string | undefined
let commitRevision = 0
const commitInput = function(isHanldeHistory = false) {
  const html = editorView.dom.innerHTML`);
s=s.replace("  emit('update', {",`  if (lastCommittedValue === html) return
  lastCommittedValue = html
  commitRevision++
  emit('update', {`);
s=s.replace('}, 300, { trailing: true })',`}
const handleInput = debounce(commitInput, 300, { trailing: true })
const flushInput = () => {
  if (!editorView) return false
  if (editorView.composing) throw Object.assign(new Error('输入法组合尚未结束，PPTX 草稿未交接'), {code:'COMPOSING'})
  const before = commitRevision
  handleInput.flush()
  commitInput()
  return commitRevision !== before
}
const unregisterCommit = registerPptTextCommit(flushInput)`);
s=s.replace('const handleBlur = () => {','const handleBlur = () => {\n  if (!editorView.composing) flushInput()');
s=s.replace('watch(textContent, () => {','watch(textContent, () => {\n  lastCommittedValue = undefined');
s=s.replace('  editorView && editorView.destroy()','  unregisterCommit()\n  handleInput.cancel()\n  editorView && editorView.destroy()');
await fs.writeFile(richText,s);
const clipboard=path.join(work,'src/utils/clipboard.ts');s=await fs.readFile(clipboard,'utf8');
s=s.replace('if (navigator.clipboard?.readText)', 'if ((window as any).__nozeliPptist?.readClipboard || navigator.clipboard?.readText)');
s=s.replace('navigator.clipboard.readText().then(text => {',`const engine=(window as any).__nozeliPptist
      const context=()=>JSON.stringify([engine?.store.slides,engine?.store.slideIndex,engine?.main.activeElementIdList])
      const captured=context()
      const read=engine?.readClipboard || (()=>navigator.clipboard.readText())
      read().then((text: string) => {
        if(engine&&captured!==context()){reject('幻灯片内容或选中对象已变化，未粘贴旧位置');return}`);
s=s.replace('return resolve(text)\n      })', 'return resolve(text)\n      }).catch(reject)');await fs.writeFile(clipboard,s);
const exp=path.join(work,'src/hooks/useExport.ts');s=await fs.readFile(exp,'utf8');s=s.replaceAll('pptx.writeFile({ fileName: `${title.value}.pptx` })',"pptx.write({ outputType: 'blob' }).then(blob => (window as any).__nozeliExport?.(blob))");await fs.writeFile(exp,s);
// Host provides the only export path. Hide cloud and alternate import/export entrypoints.
const html=path.join(work,'index.html');s=await fs.readFile(html,'utf8');s=s.replace('</head>',`<style>.editor-header{display:none!important}</style></head>`);await fs.writeFile(html,s);
run('npm',['ci','--ignore-scripts','--no-audit','--no-fund']);run('npm',['run','build-only']);
await fs.rm(path.join(vendor,'dist'),{recursive:true,force:true});
await fs.cp(path.join(work,'dist'),path.join(vendor,'dist'),{recursive:true});
// Retain the verified, unmodified upstream tree for corresponding-source distribution.
await pipeline(createReadStream(archive),createGzip(),createWriteStream(path.join(vendor,'upstream.tar.gz')));
} finally {
await fs.rm(temporary,{recursive:true,force:true});
}
