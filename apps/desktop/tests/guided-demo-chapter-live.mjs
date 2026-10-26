import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createGuidedDemoHarness, selectedChapter} from './guided-demo-live-helper.mjs';
import JSZip from 'jszip';
import {DOMParser} from '@xmldom/xmldom';

const chapterId = selectedChapter();
const harness = await createGuidedDemoHarness({kind: 'chapter', chapterId});
const {report} = harness;
let shell, controls;

const mark = (name, evidence = {}) => report.checks.push({name, ...evidence});
const surfaceSnapshot = async projectId => harness.invoke(shell, 'workspace.windows.list', {projectId});
const visibleSurfaces = windows => windows.flatMap(window => (window.surfaces || []).map(surface => ({...surface, windowId: window.id, nativeWindowId: window.nativeWindowId}))).filter(surface => surface.visible && surface.bounds?.width > 0 && surface.bounds?.height > 0);

async function demoRoot(projectId) {
  const state = await harness.invoke(shell, 'demo.state', {projectId});
  const root = state.project?.rootDisplay || state.project?.root;
  assert(root && path.isAbsolute(root), 'Demo state must expose the real isolated project root');
  return {state, root};
}

async function startThroughDisclosure() {
  ({page: shell} = await harness.scope(scope => scope.role === 'shell', 'real shell WebContents'));
  if (await shell.$eval('#configuration-setup', element => element.open).catch(() => false)) await shell.click('#configuration-cancel');
  await shell.waitForSelector('#start-demo-entry', {visible: true, timeout: 15_000});
  await shell.click('#start-demo-entry');
  await shell.waitForSelector('#guided-demo-disclosure[open]', {timeout: 10_000});
  const chapters = await shell.$$eval('#guided-demo-disclosure select[aria-label="从章节开始"] option', options => options.map(option => ({id: option.value, title: option.textContent})));
  assert.deepEqual(chapters.map(chapter => chapter.id), report.chapters.map(chapter => chapter.id));
  await shell.select('#guided-demo-disclosure select[aria-label="从章节开始"]', chapterId);
  await shell.click('#demo-create-confirm');
  ({page:controls}=await harness.scope(scope=>scope.role==='demo-controls','native demo controls'));
  await controls.waitForSelector('#guided-demo-player:not([hidden])', {timeout: 30_000});
  const projectId = await harness.until(async () => (await harness.invoke(shell, 'workspace.bootstrap')).projectId, 'real demo project binding');
  const identity = await controls.$eval('#guided-demo-player', element => ({state: element.dataset.demoState, sessionId: element.dataset.sessionId, epoch: Number(element.dataset.epoch)}));
  report.projectId = projectId;
  report.session = identity;
  mark('public disclosure created and bound a real demo project', {projectId, sessionId: identity.sessionId});
  if (chapterId === 'intro' && identity.state === 'playing') {
    const point = await shell.$eval('#app', element => { const rect = element.getBoundingClientRect(); return {x: rect.left + 20, y: rect.top + 20}; });
    await shell.mouse.click(point.x, point.y);
    const paused = await harness.until(async () => { const value = await controls.$eval('#guided-demo-player', element => ({state: element.dataset.demoState, epoch: Number(element.dataset.epoch)})); return value.state === 'paused' ? value : null; }, 'trusted user pointer pauses demo');
    assert(paused.epoch > identity.epoch, 'User interruption must advance epoch');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await controls.$eval('#guided-demo-player', element => element.dataset.demoState), 'paused', 'Late action receipt must not resume playback');
    await harness.until(()=>controls.$eval('[data-demo-control="play"]',node=>!node.disabled),'original operation settles before continue');
    await controls.click('[data-demo-control="play"]');
    mark('trusted native-surface input paused and stale work did not resume playback', {epochBefore: identity.epoch, epochAfter: paused.epoch});
  }
  return projectId;
}

async function awaitChapterEvidence(projectId) {
  const samples = [];
  await harness.until(async () => {
    const current = await controls.$eval('#guided-demo-player', element => ({chapterId: element.querySelector('select[aria-label="演示章节"]')?.value, state: element.dataset.demoState, subtitle: document.querySelector('#demo-subtitle')?.textContent}));
    const windows = await surfaceSnapshot(projectId);
    samples.push({at: Date.now(), current, surfaces: visibleSurfaces(windows)});
    if(chapterId==='results'&&!report.renderedReport){
      for(const page of await harness.browser.pages()){
        if(!page.url().endsWith('/report.html'))continue;
        const rendered=await page.evaluate(()=>({title:document.querySelector('h1')?.textContent,table:document.querySelector('table')?.textContent,label:document.querySelector('small')?.textContent}));
        if(rendered.title==='两种观测方法的比较'&&rendered.table?.includes('固定测点 A')&&rendered.table.includes('移动测点 B')){assert(rendered.label.includes('演示内容'));report.renderedReport=rendered;await harness.capture(page,'rendered-demo-report');break;}
      }
    }
    return current.chapterId !== chapterId || current.state === 'finished' || (chapterId!=='finish'&&current.subtitle?.includes('本章已完成')) || current.subtitle?.includes('已暂停：');
  }, `real ${chapterId} chapter actions`, 60_000);
  report.samples = samples;
  const own = samples.filter(sample => sample.current.chapterId === chapterId);
  assert(own.length, 'No sample was observed while the selected chapter was active');
  assert(!own.some(sample => sample.current.subtitle?.includes('已暂停：')), 'Chapter paused on a failed native action');
  const paths = new Set(own.flatMap(sample => sample.surfaces.map(surface => surface.relPath).filter(Boolean)));
  const expectedPaths = {
    intro: ['research-notes.txt'], reading: ['research-notes.txt'], anchors: ['research-notes.txt'], discussion: ['research-notes.txt'],
    pdf: ['paper.pdf'], image: ['methods.png'], ppt: ['presentation.pptx'], word: ['manuscript.docx'], sheet: ['measurements.xlsx'],
    workspace: ['research-notes.txt'], results: ['comparison-before.txt'], finish: [],
  }[chapterId];
  for (const relPath of expectedPaths) assert(paths.has(relPath), `${chapterId} never exposed the real ${relPath} surface`);
  if (chapterId === 'finish') assert(own.some(sample => sample.current.state==='finished'), 'Finish chapter never reached its terminal retained state');
  if (chapterId === 'workspace') {
    assert(own.some(sample => sample.surfaces.length >= 2), 'Workspace chapter never exposed a real split');
    assert(own.some(sample => sample.surfaces.some(surface => surface.windowId && surface.windowId !== 'main')), 'Workspace chapter never exposed an independent native window');
  }
  if (chapterId === 'discussion') {
    const state = await harness.invoke(shell, 'demo.state', {projectId});
    assert(state.messages?.some(message => message.speaker === 'agent' && message.source === 'demo-fixture' && message.text.includes('本地固定回复')), 'Discussion chapter did not persist the fixed offline reply');
  }
  mark('selected chapter exposed expected native surfaces', {paths: [...paths]});
}

async function assertChapterOutcome(projectId) {
  const {state, root} = await demoRoot(projectId);
  const template = relPath => path.join(harness.appRoot, 'assets/guided-demo', relPath), copy = relPath => path.join(root, relPath);
  if (chapterId === 'intro') {
    assert.notEqual(root, path.join(harness.appRoot, 'assets/guided-demo'));
    assert.equal(await fs.readFile(copy('research-notes.txt'), 'utf8'), await fs.readFile(template('research-notes.txt'), 'utf8'));
  } else if (chapterId === 'reading') {
    const saved = await fs.readFile(copy('research-notes.txt'), 'utf8'); assert.match(saved, /演示记录：方法 B/);
    const surface = await harness.scope(scope => scope.projectId === projectId && scope.relPath === 'research-notes.txt', 'real text editor');
    const before = await fs.readFile(copy('research-notes.txt')); await surface.page.click('#text-host .cm-content'); await surface.page.keyboard.type(' UI_SAVE_EVIDENCE');
    await harness.until(async () => !(await fs.readFile(copy('research-notes.txt'))).equals(before), 'real editor keyboard autosave');
    report.keyboardSave = {beforeBytes: before.length, afterBytes: (await fs.readFile(copy('research-notes.txt'))).length};
  } else if (['anchors', 'discussion', 'image', 'ppt'].includes(chapterId)) {
    const relPath = chapterId === 'image' ? 'methods.png' : chapterId === 'ppt' ? 'presentation.pptx' : 'research-notes.txt';
    const value = await harness.invoke(shell, 'annotation.list', {projectId, relPath}), annotations = value.annotations || value;
    assert(annotations.length, `${chapterId} did not persist real annotation state`); report.annotations = annotations;
    if (chapterId === 'image') {
      assert(annotations.some(annotation => annotation.information?.drawing?.strokes?.length), 'Image chapter did not persist drawing strokes');
      const message=state.messages.find(message=>message.speaker==='user'&&message.attachments?.some(attachment=>attachment.source==='drawing'));
      assert(message,'Explicit drawing discussion must carry a registered frozen PNG');
      const ref=message.attachments.find(attachment=>attachment.source==='drawing'),frozen=await harness.invoke(shell,'material.read',ref),bytes=Buffer.from(frozen.bytes,'base64');
      assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      assert(message.materialSources.some(source=>source.relPath==='methods.png'&&source.materialDigest));
      await fs.appendFile(copy('methods.png'),Buffer.from('USER_EXPLORED_CURRENT_IMAGE'));
      const retained=await harness.invoke(shell,'material.read',ref);assert.deepEqual(Buffer.from(retained.bytes,'base64'),bytes,'Later source edits must not rewrite the sent PNG');
      await shell.click('#workspace-open-conversation');
      const conversation=await harness.scope(scope=>scope.projectId===projectId&&scope.kind==='conversation','normal conversation surface with frozen image');
      await conversation.page.waitForSelector('[data-digest="'+ref.digest+'"]',{visible:true});await conversation.page.click('[data-digest="'+ref.digest+'"]');
      await conversation.page.waitForFunction(()=>document.querySelector('.mv-image')?.naturalWidth>0);
      const size=await conversation.page.$eval('.mv-image',image=>({width:image.naturalWidth,height:image.naturalHeight}));assert.deepEqual(size,{width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)});
      await harness.capture(conversation.page,'frozen-drawing-preview',{digest:ref.digest,...size});report.frozenDrawing={digest:ref.digest,...size,sourceEditsDidNotRewrite:true};
    }
    if (chapterId === 'discussion') assert(state.messages?.some(message => message.speaker === 'agent' && message.source === 'demo-fixture' && message.text.includes('本地固定回复')), 'Discussion did not persist fixed reply');
  } else if (chapterId === 'pdf') {
    const surface = await harness.scope(scope => scope.projectId === projectId && scope.relPath === 'paper.pdf', 'real PDF surface');
    const pdf = await surface.page.evaluate(() => ({pageTwo: !!document.querySelector('[data-page-number="2"],.pdf-page[data-page="2"]'), selection: getSelection()?.toString()}));
    assert(pdf.pageTwo || pdf.selection, 'PDF chapter did not expose page-two or real selection evidence'); report.pdf = pdf;
  } else if (chapterId === 'word') {
    const zip=await JSZip.loadAsync(await fs.readFile(copy('manuscript.docx'))),doc=new DOMParser().parseFromString(await zip.file('word/document.xml').async('string'),'application/xml');
    const text=[...Array.from(doc.getElementsByTagNameNS('*','t'))].map(node=>node.textContent).join('');assert.match(text,/演示修订：继续核查样本。/);report.savedWordText=text;
  } else if (chapterId === 'sheet') {
    const zip=await JSZip.loadAsync(await fs.readFile(copy('measurements.xlsx'))),doc=new DOMParser().parseFromString(await zip.file('xl/worksheets/sheet1.xml').async('string'),'application/xml');
    const cells=new Map(Array.from(doc.getElementsByTagNameNS('*','c')).map(cell=>[cell.getAttribute('r'),cell.textContent]));assert.equal(Number(cells.get('B2')),12.5);assert.equal(Number(cells.get('C2')),31);assert.match(cells.get('A2'),/地点一/);report.savedCells={B2:cells.get('B2'),C2:cells.get('C2'),A2:cells.get('A2')};
  }
  else if (chapterId === 'workspace') {
    assert(report.samples.some(sample => sample.surfaces.length >= 2), 'No persisted split bounds were sampled');
    assert(report.samples.some(sample => sample.surfaces.some(surface => surface.windowId !== 'main')), 'No detached native window identity was sampled');
  } else if (chapterId === 'results') {
    assert(state.todos?.some(todo => todo.source === 'demo-fixture' && todo.kind === 'result'), 'Results chapter did not publish a fixture todo');
    assert.equal(report.renderedReport?.title,'两种观测方法的比较','Report must be rendered HTML, not just its source file');
    assert(await harness.until(async () => { for (const page of await harness.browser.pages()) if (await page.$('.cm-mergeView')) return true; return false; }, 'real comparison view', 10_000), 'Results chapter did not open a real diff');
  } else if (chapterId === 'finish') {
    const exploration = path.join(root, 'user-exploration.txt'); await fs.writeFile(exploration, 'retain me'); const before = await fs.readdir(root);
    await shell.evaluate(() => { window.__guidedCleanup = null; window.addEventListener('nozeli-demo-cleanup', event => { window.__guidedCleanup = event.detail; }, {once: true}); });
    await controls.click('#demo-more summary');await controls.click('[data-demo-control="cleanup"]');
    const preview = await harness.until(() => shell.evaluate(() => window.__guidedCleanup || null), 'cleanup preview');
    assert.equal(preview.preview.requiresUserConfirmation, true); assert.equal(preview.preview.canAutomaticallyDelete, false); assert.equal(preview.preview.preserveByDefault, true); assert(preview.preview.changes.some(change => JSON.stringify(change).includes('user-exploration.txt')), 'Preview omitted user exploration file'); assert.deepEqual(await fs.readdir(root), before, 'Preview must not delete project bytes'); report.cleanupPreview = preview;
  }
  mark('chapter persisted its real semantic outcome', {chapterId, root});
}

try {
  await harness.launch();
  ({page: shell} = await harness.scope(scope => scope.role === 'shell', 'shell before demo'));
  await harness.enumerateChapters(shell);
  // enumerateChapters opens the help disclosure; close it so the required start
  // entry path below creates a fresh disclosure through the public control.
  await shell.keyboard.press('Escape');
  const projectId = await startThroughDisclosure();
  await awaitChapterEvidence(projectId);
  await assertChapterOutcome(projectId);
  const exampleRoots = await fs.readdir(path.join(harness.root, 'examples'), {withFileTypes: true});
  assert(exampleRoots.some(entry => entry.isDirectory()), 'Demo creation did not produce an isolated on-disk project copy');
  mark('isolated example project exists on disk', {entries: exampleRoots.map(entry => entry.name)});
  await harness.capture(shell, `chapter-${chapterId}`, {projectId});
  await harness.auditIsolation();
  assert.deepEqual(report.errors, [], 'Renderer errors occurred');
  await harness.closeNormally(shell);
  report.ok = true;
} catch (error) {
  report.failure = error.stack || String(error);
  await shell?.screenshot({path: path.join(harness.root, 'failure.png')}).catch(() => {});
  report.pageDiagnostics=[];
  for(const page of await harness.browser.pages()){
    const identity=await page.evaluate(async()=>{const result=await window.nozeli?.invoke('workspace.bootstrap',{});return result?.ok?result.value:null;}).catch(()=>null);
    const detail=await page.evaluate(() => ({
      toasts: [...document.querySelectorAll('[role="status"],.toast')].map(node => node.textContent).filter(Boolean).slice(-8),
      tags: [...document.querySelectorAll('[data-annotation]')].map(node => node.textContent.slice(0,100)),
      subtitle: document.querySelector('#demo-subtitle')?.textContent,
    })).catch(() => null);
    report.pageDiagnostics.push({identity,detail});
  }
  await harness.auditIsolation().catch(audit => { report.auditFailure = audit.stack || String(audit); });
  await harness.cleanupAfterFailure();
  process.exitCode = 1;
} finally {
  await harness.save();
}
