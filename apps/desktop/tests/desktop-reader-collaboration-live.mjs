import { contentToolForPage } from './native-content-tools.fixture.mjs';
// Installed Linux reader acceptance. Paid execution is explicitly opt-in; never reset ROOT.
// NOZELI_REAL_OMP=1 NOZELI_OMP_IMPORT_API_KEYS=1 node apps/desktop/tests/desktop-reader-collaboration-live.mjs /absolute/release /absolute/fresh-root
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
import {parse, stringify} from 'yaml';
import {createReaderAcceptanceProject} from './reader-acceptance-project.mjs';
import {createAcceptanceCollector} from './acceptance-request-control.mjs';
import {DesktopHost} from '../src/main/host.mjs';
import {FileTags} from '../src/domain/file-tags.mjs';
import {resolveSystemOmpSource} from '../src/agents/managed/omp-system-source.mjs';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';
import {recoverOmpProvider} from '../src/agents/managed/omp-process-ownership.mjs';

const [release, root, ...extra] = process.argv.slice(2);
assert.equal(process.env.NOZELI_REAL_OMP, '1', 'Explicit paid-model opt-in required');
assert.equal(process.env.NOZELI_OMP_IMPORT_API_KEYS, '1', 'Explicit static-key import opt-in required');
assert.equal(process.platform, 'linux', 'Linux birth-stamped ownership required');
assert(extra.length === 0 && [release, root].every(p => typeof p === 'string' && path.isAbsolute(p)), 'Absolute release and fresh external root required');
const repository = path.resolve(import.meta.dirname, '../../..');
assert(!root.startsWith(repository + '/') && root !== repository && !root.startsWith(release + '/') && root !== release, 'Root must be outside repository and installed release');
await fs.access(path.join(release, 'nozeli'));
await fs.mkdir(root, {mode: 0o700}); // Exclusive, no same-root reset or replay.
const privateRoot = path.join(root, '.Nozeli'), profile = path.join(privateRoot, 'desktop');
const checks = [], operations = [], errors = [], owners = new Map(), runtimes = new Set();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (name, value) => fs.writeFile(path.join(root, name), JSON.stringify(value, null, 2), {mode: 0o600});
let collector, browser, page, child, exited, failure, activeId, stage = 'fixture', log = '';
let fixture, registrations, originalFiles, originalPaper, frozenNote, discussionId;
function check(name, condition, evidence) {
  checks.push({name, pass: Boolean(condition), stage, at: new Date().toISOString(), evidence});
  assert(condition, name);
}
async function invoke(op, payload = {}) {
  operations.push({layer: 'production-ipc', op, payload, at: Date.now()});
  const response = await page.evaluate(({op, payload}) => window.nozeli.invoke(op, payload), {op, payload});
  if (!response.ok) throw Object.assign(Error(op + ': ' + response.error?.message), {response});
  return response.value;
}
async function state(id = activeId) {
  const value = await invoke('managed.status', {projectId: id});
  if (value.runtimeRoot) { assert(value.runtimeRoot.startsWith(profile + '/')); runtimes.add(value.runtimeRoot); }
  for (const record of Object.values(value.state.providers || {})) if (record.pid && record.stamp) owners.set(record.pid, {record, runtime: value.runtimeRoot});
  return value.state;
}
async function wait(fn, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ledger = collector?.snapshot();
    if (ledger?.stopped) throw Error('Collector stopped: ' + ledger.stopped);
    const bad = ledger?.events.find(e => e.kind === 'transport-error' || e.kind === 'response' && e.status >= 400);
    if (bad) { await collector.stop('upstream-failure-no-retry'); throw Error('Original upstream failure; no retry: ' + JSON.stringify(bad)); }
    const result = await fn(); if (result) return result;
    if (child && (child.exitCode !== null || child.signalCode)) throw Error('Electron exited: ' + label);
    await pause(150);
  }
  throw Error('Timeout, not retried: ' + label);
}
async function click(selector) {
  operations.push({layer: 'real-dom-click', selector, at: Date.now()});
  await page.waitForSelector(selector, {visible: true, timeout: 15000});
  await page.locator(selector).setTimeout(15000).click();
}
async function fill(selector, text) {
  await click(selector); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.sendCharacter(text);
}
async function launch() {
  const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
  const env = {...process.env, PATH: '/usr/bin:/bin', NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: privateRoot,
    NOZELI_USER_DATA: profile, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0', NOZELI_SHOT_DIR: root};
  for (const key of ['ELECTRON_RUN_AS_NODE','NOZELI_AGENT_FIXTURE','NOZELI_OMP_BIN','PI_CODING_AGENT_DIR','PI_CONFIG_DIR','OMP_PROFILE','PI_PROFILE','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','OMP_AUTH_BROKER_URL','OMP_AUTH_BROKER_TOKEN','NOZELI_TEST_PICK']) delete env[key];
  child = spawn(path.join(release, 'nozeli'), ['--ozone-platform=' + (process.env.NOZELI_OZONE || 'wayland')], {cwd: fixture.projectA, env, detached: true, stdio: ['ignore','pipe','pipe']});
  child.ownedStamp = await processStamp(child.pid);
  exited = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; });
  await wait(async () => { try { return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok; } catch { return false; } }, 'installed debugging endpoint', 45000);
  browser = await puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null});
  page = await (await browser.waitForTarget(t => t.url().startsWith('http://127.0.0.1:'))).page();
  page.on('pageerror', error => errors.push(error.stack));
  await page.waitForFunction(() => window.__nozeliReady);
}
async function close() {
  if (!page || !child || child.exitCode !== null || child.signalCode) return;
  await invoke('session.requestClose');
  // Cold project switches may still be attaching native residents. Honor the
  // real close confirmation rather than treating a protected window as a hang.
  const closing = await Promise.race([
    exited.then(result => ({result})),
    page.waitForSelector('#quit-choice[open]', {visible:true,timeout:15000}).then(() => ({confirm:true})).catch(() => ({})),
  ]);
  if (closing.confirm) await click('#quit-cancel');
  assert.deepEqual(await Promise.race([exited, pause(90000).then(() => null)]), {code: 0, signal: null}, 'Normal app close');
  await browser.disconnect(); browser = null; page = null;
}
async function switchProject(key) {
  const project = registrations[key]; activeId = project.id;
  // Recent-project UI activates renderer, persisted views and conversation context together.
  if (await page.$eval('#app', el => el.classList.contains('files-collapsed') || el.classList.contains('narrow-layout') && !el.classList.contains('drawer-files-open'))) await click('#file-toggle');
  await click('#recent button[title=' + JSON.stringify(project.name) + ']');
  await page.waitForFunction(id => document.querySelector('#recent button[data-project-id="'+id+'"]')?.getAttribute('aria-current') === 'true',{},project.id);
  await openPaper();
  const marker = key === 'A' ? fixture.files.markerA : fixture.files.markerB;
  await wait(() => page.$eval('#text-preview', (el, marker) => el.textContent.includes(marker), marker), 'project source identity ' + key);
}
async function openPaper() {
  if (await page.$eval('#file-path', (el, name) => el.textContent.trim() === name, fixture.files.paper).catch(() => false)) return;
  if (await page.$eval('#app', el => el.classList.contains('files-collapsed') || el.classList.contains('narrow-layout') && !el.classList.contains('drawer-files-open'))) await click('#file-toggle');
  await click('#file-tree button[data-path=' + JSON.stringify(fixture.files.paper) + ']');
  await page.waitForFunction(name => document.querySelector('#file-path').textContent.trim() === name, {}, fixture.files.paper);
}
// Browser closures cannot see Node variables; every fixture value crosses explicitly.
async function resize(width) {
  await invoke('session.resize', {width, height: width === 390 ? 844 : 1000});
  await page.waitForFunction(width => innerWidth === width, {}, width);
  await pause(200);
}
async function clearSelectionObstructions(points,label) {
  const sourceBefore=await fs.readFile(path.join(activeId===registrations.A.id?fixture.projectA:fixture.projectB,fixture.files.paper),'utf8');
  for(let count=0;count<4;count++) {
    const obstruction=await page.evaluate(points=>{
      for(const [x,y] of [[points.x,points.y],[points.end,points.endY??points.y]]) {
        const root=document.elementFromPoint(x,y)?.closest('.note-anchor');if(!root)continue;
        const owner=root.closest('#text-preview:not([hidden]),#text-host:not([hidden])');
        const head=root.querySelector('.note-projection-head'),card=root.querySelector('.note-projection')?.getBoundingClientRect();
        if(!owner||!head||!card)return {id:root.dataset.annotation,unmovable:true,reason:'missing visible owner/header'};
        const candidates=[...head.querySelectorAll('.tag-window-title,.note-projection-content,.tag-ordinal'),head];
        let start;
        for(const candidate of candidates)for(const rect of candidate.getClientRects()) {
          if(rect.width<2||rect.height<2)continue;
          for(const fraction of [.5,.25,.75]) {
            const px=rect.left+rect.width*fraction,py=rect.top+rect.height/2;
            if(px<=0||py<=0||px>=innerWidth||py>=innerHeight)continue;
            const hit=document.elementFromPoint(px,py);
            if(hit?.closest('.note-anchor')===root&&head.contains(hit)&&!hit.closest('button,textarea,input')){start={x:px,y:py,hitTag:hit.tagName,hitClass:hit.className};break;}
          }
          if(start)break;
        }
        if(!start)return {id:root.dataset.annotation,unmovable:true,reason:'no visible unobstructed non-button header drag point',before:card.toJSON()};
        const dy=y+card.height+36<innerHeight?card.height+48:-card.height-48;
        return {id:root.dataset.annotation,owner:owner.id,start,before:card.toJSON(),dy,destinationY:Math.max(35,Math.min(start.y+dy,innerHeight-35))};
      }
      return null;
    },points);
    if(!obstruction)return;
    assert(!obstruction.unmovable,'Obstructing tag has no physical drag handle');
    const number=operations.filter(op=>op.layer==='physical-card-obstruction-move').length+1;
    const beforeScreenshot='selection-obstruction-'+number+'.png',afterScreenshot='selection-obstruction-'+number+'-after.png';
    await page.screenshot({path:path.join(root,beforeScreenshot),fullPage:false});
    await page.mouse.move(obstruction.start.x,obstruction.start.y);await page.mouse.down();
    await page.mouse.move(obstruction.start.x,obstruction.destinationY,{steps:18});await page.mouse.up();
    await pause(200);
    await page.screenshot({path:path.join(root,afterScreenshot),fullPage:false});
    const after=await page.$eval(':is(#text-preview:not([hidden]),#text-host:not([hidden])) .note-anchor[data-annotation='+JSON.stringify(obstruction.id)+'] .note-projection',el=>el.getBoundingClientRect().toJSON());
    const evidence={layer:'physical-card-obstruction-move',finding:'Visible annotation card obstructs exact source selection; physical movement required',label,...obstruction,after,beforeScreenshot,afterScreenshot,at:Date.now()};operations.push(evidence);
    await save('reading-obstructions.json',operations.filter(op=>op.layer==='physical-card-obstruction-move'));
    check('Physical tag movement actually changes visible card position '+label+' '+count,Math.hypot(after.x-obstruction.before.x,after.y-obstruction.before.y)>10,evidence);
    check('Physical tag movement preserves source '+label+' '+count,await fs.readFile(path.join(activeId===registrations.A.id?fixture.projectA:fixture.projectB,fixture.files.paper),'utf8')===sourceBefore,evidence);
  }
}
async function exactPhysicalSelection(quote, points, label) {
  const observe = () => page.evaluate(() => {
    const selection=window.getSelection(),anchor=selection?.anchorNode,focus=selection?.focusNode;
    return {text:selection?.toString()||'',anchorOffset:selection?.anchorOffset,focusOffset:selection?.focusOffset,
      anchorText:anchor?.textContent,focusText:focus?.textContent,rect:selection?.rangeCount?selection.getRangeAt(0).getBoundingClientRect().toJSON():null,
      viewport:{width:innerWidth,height:innerHeight,devicePixelRatio}};
  });
  await clearSelectionObstructions(points,label);
  const hitTest = await page.evaluate(({points,quote}) => {
    return [[points.x,points.y],[points.end,points.endY??points.y]].map(([x,y])=>{
      const el=document.elementFromPoint(x,y),source=el?.closest('#text-preview h2,#text-preview p');
      return {x,y,tag:el?.tagName,classes:el?.className,text:el?.textContent?.slice(0,200),
        clear:Boolean(source&&source.textContent.includes(quote)&&!el.closest('.note-anchor,.note-projection,#selection-menu'))};
    });
  },{points,quote});
  operations.push({layer:'selection-hit-test',label,points,hitTest,at:Date.now()});
  if(!hitTest.every(hit=>hit.clear)) {
    await save('selection-observations.json',operations.filter(op=>op.layer.startsWith('selection-')||op.layer==='physical-selection'));
    throw Error('Harness selection endpoint obscured before drag: '+label+' '+JSON.stringify(hitTest));
  }
  await page.mouse.move(points.x,points.y);await page.mouse.down();
  await page.mouse.move(points.end,points.endY ?? points.y,{steps:16});await page.mouse.up();
  const samples=[await observe()];
  // A native hit-test can round the final glyph's edge inward. Correct only a
  // verified prefix/suffix mismatch at the moving endpoint, never the origin.
  // Bound correction by the requested quote, retaining exact-origin and final
  // equality checks even when a native drag stops more than eight glyphs short.
  for(let count=0;samples.at(-1).text!==quote&&count<quote.length;count++) {
    const selected=samples.at(-1).text;
    const direction=selected&&quote.startsWith(selected)?'ArrowRight':selected.startsWith(quote)?'ArrowLeft':null;
    if(!direction)break;
    await page.keyboard.down('Shift');await page.keyboard.press(direction);await page.keyboard.up('Shift');
    samples.push(await observe());
  }
  operations.push({layer:'physical-selection',label,expected:quote,points,samples,exact:samples.at(-1).text===quote,at:Date.now()});
  await save('selection-observations.json',operations.filter(op=>op.layer==='physical-selection'));
  assert.equal(samples.at(-1).text,quote,'Harness physical selection must be exact before opening note UI: '+label);
  await page.waitForSelector('#selection-menu:not([hidden])',{visible:true});
}
async function selectQuote() {
  const {quote, secondQuotePrefix} = fixture.files;
  await page.evaluate(({quote,secondQuotePrefix}) => {
    const paragraph=[...document.querySelectorAll('#text-preview p')].find(el=>el.textContent.includes(secondQuotePrefix)&&el.textContent.includes(quote));
    if(!paragraph)throw Error('Missing second repeated quote');paragraph.scrollIntoView({block:'center'});
  },{quote,secondQuotePrefix});
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const points = await page.evaluate(({quote, secondQuotePrefix}) => {
    const p = [...document.querySelectorAll('#text-preview p')].find(p => p.textContent.includes(secondQuotePrefix) && p.textContent.includes(quote));
    if (!p) return null;
    const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let node;
    while ((node = walk.nextNode())) { const offset = node.textContent.indexOf(quote); if (offset < 0) continue;
      const first=document.createRange();first.setStart(node,offset);first.setEnd(node,offset+1);
      const last=document.createRange();last.setStart(node,offset+quote.length-1);last.setEnd(node,offset+quote.length);
      const a=first.getBoundingClientRect(),b=last.getBoundingClientRect();
      return {x:a.left+.1,y:a.top+a.height/2,end:b.right-.1,endY:b.top+b.height/2}; }
    return null;
  }, {quote, secondQuotePrefix});
  assert(points, 'Fixture second occurrence must be visible rendered text');
  await exactPhysicalSelection(quote,points,'second repeated quote');
}
async function selectDensityAnchor(quote) {
  // Reading headings are real rendered source, unlike the virtualized source
  // editor: scroll the heading first, wait for layout, then physically drag.
  await page.evaluate(quote => {
    const heading = [...document.querySelectorAll('#text-preview h2')].find(el => el.textContent.includes(quote));
    if (!heading) throw Error('Missing rendered fixture heading ' + quote);
    heading.scrollIntoView({block:'center'});
  },quote);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let previousBounds;
  await wait(async()=>{
    const bounds=await page.evaluate(quote=>{
      const heading=[...document.querySelectorAll('#text-preview h2')].find(el=>el.textContent.includes(quote));
      const b=heading?.getBoundingClientRect();return b?{x:b.x,y:b.y,width:b.width,height:b.height}:null;
    },quote);
    const stable=bounds&&previousBounds&&Object.keys(bounds).every(key=>Math.abs(bounds[key]-previousBounds[key])<.25);
    previousBounds=bounds;return stable;
  },'stable density heading layout '+quote);
  const points = await wait(() => page.evaluate(quote => {
    const heading = [...document.querySelectorAll('#text-preview h2')].find(el => el.textContent.includes(quote));
    if (!heading) return null;
    const walker = document.createTreeWalker(heading,NodeFilter.SHOW_TEXT); let node;
    while ((node=walker.nextNode())) {
      const offset=node.textContent.indexOf(quote); if(offset<0)continue;
      const first=document.createRange();first.setStart(node,offset);first.setEnd(node,offset+1);
      const last=document.createRange();last.setStart(node,offset+quote.length-1);last.setEnd(node,offset+quote.length);
      const a=first.getBoundingClientRect(),b=last.getBoundingClientRect(),pane=document.querySelector('#reader-scroll').getBoundingClientRect();
      if(a.width<=0||a.top<Math.max(0,pane.top)||b.bottom>Math.min(innerHeight,pane.bottom))return null;
      return {x:a.left+.1,end:b.right-.1,y:a.top+a.height/2,endY:b.top+b.height/2};
    }
    return null;
  },quote),'visible rendered density anchor '+quote);
  await exactPhysicalSelection(quote,points,'density '+quote);
}
// Both source and preview projections may remain mounted. Interact only with
// the public owner of the current mode; never let a hidden source card win.
const tag = id => ':is(#text-preview:not([hidden]),#text-host:not([hidden])) .note-anchor[data-annotation=' + JSON.stringify(id) + ']';
const annotations = async () => (await invoke('annotation.list', {projectId: activeId, relPath: fixture.files.paper})).annotations;
const admissionCount = () => Object.keys(collector.snapshot().attempts).length;
async function noDispatch(label, before) {
  await pause(600); const after = await state();
  check(label, after.jobs.length === before.jobs && admissionCount() === before.http, {jobs: after.jobs.map(j => j.id), http: admissionCount(), before});
}
async function snapshotFiles(directory, prefix = '') {
  const result = {};
  for (const entry of await fs.readdir(path.join(directory, prefix), {withFileTypes: true})) {
    if (['.nozeli','.git'].includes(entry.name)) continue;
    const rel = path.join(prefix, entry.name);
    assert(!entry.isSymbolicLink(), 'Synthetic fixture must not link to user data');
    if (entry.isDirectory()) Object.assign(result, await snapshotFiles(directory, rel));
    else result[rel] = createHash('sha256').update(await fs.readFile(path.join(directory, rel))).digest('hex');
  }
  return result;
}
async function timeline() {
  const entries = new Map(); let cursor;
  do {
    const frame = await invoke('managed.timeline.page', {projectId: activeId, limit: 200, ...(cursor ? {cursor} : {})});
    for (let entry of frame.entries) {
      if (entry.availability === 'read-required') { const original = await invoke('managed.timeline.read', {projectId: activeId, id: entry.id}); entry = original.entry || original; }
      entries.set(entry.id, entry);
    }
    assert(!frame.hasMore || frame.nextCursor && frame.nextCursor !== cursor, 'History advances');
    cursor = frame.hasMore ? frame.nextCursor : null;
  } while (cursor);
  return [...entries.values()];
}
async function sendTag(question, label, duringOutput) {
  const before = await state(), accepted = new Set(before.jobs.map(j => j.id));
  await fill(tag(discussionId) + ' .tag-editor', question);
  check(label + ': focused actual tag editor', await page.$eval(tag(discussionId) + ' .tag-editor', el => document.activeElement === el));
  operations.push({layer: 'physical-keyboard', key: 'Control+Enter', question, at: Date.now()});
  await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
  const job = await wait(async () => (await state()).jobs.find(j => !accepted.has(j.id)), label + ' exact job admission');
  const admittedState=await state();
  check(label+': explicit tag send preserves unrelated unsent main draft at admission',admittedState.drafts.frontdesk===before.drafts.frontdesk&&await page.$eval('#composer',el=>el.value)===before.drafts.frontdesk,{jobId:job.id,before:before.drafts.frontdesk,after:admittedState.drafts.frontdesk});
  check(label + ': exact user question and frozen quote remain in accepted input', job.text.includes(question) && job.text.includes(fixture.files.quote), {jobId: job.id,questionPreserved:job.text.includes(question),quotePreserved:job.text.includes(fixture.files.quote)});
  if (duringOutput) await duringOutput(job);
  const after = await wait(async () => {
    const s = await state(), current = s.jobs.find(j => j.id === job.id);
    if (['failed','unknown','interrupted'].includes(current?.status)) throw Object.assign(Error(label + ': original job ' + current.status), {job: current});
    return current && !['queued','running'].includes(current.status) && !s.busyTargets.length ? s : null;
  }, label + ' actual model completion', 300000);
  check(label + ': exactly one accepted job', after.jobs.length === before.jobs.length + 1, {jobId: job.id, status: after.jobs.find(j => j.id === job.id).status});
  check(label+': actual tag response preserves unrelated unsent main draft',after.drafts.frontdesk===before.drafts.frontdesk&&await page.$eval('#composer',el=>el.value)===before.drafts.frontdesk,{jobId:job.id,before:before.drafts.frontdesk,after:after.drafts.frontdesk});
  const entries = (await timeline()).filter(e => e.jobId === job.id && ['agent','tool'].includes(e.speaker));
  const reply = entries.findLast(e => e.speaker === 'agent' && !e.tool && !e.toolCalls?.length && e.text);
  check(label + ': actual native reply', Boolean(reply && admissionCount() > 0), {jobId: job.id, replyId: reply?.id, entries: entries.map(e => ({id: e.id, speaker: e.speaker, tool: e.tool?.name}))});
  await wait(async () => (await annotations()).find(n => n.id === discussionId)?.projection?.history?.some(h => h.messageId === reply.id), label + ' tag shared native identity');
  if (await page.$eval('#conversation-panel', el => el.classList.contains('compact-composer'))) await click('#chat-history-toggle');
  await wait(() => page.$$eval('#conversation .session-message', (nodes, ids) => nodes.filter(n => ids.includes(n.dataset.message)).length === 1, entries.map(e => e.id)), label + ' one task reply bubble');
  check(label + ': tag/main share exact persisted reply identity', true, {jobId: job.id, replyId: reply.id});
  await save(label + '-timeline.json', entries);
  return {job, reply, entries};
}
async function shot(name) { await page.screenshot({path: path.join(root, name + '.png'), fullPage: false}); }
async function frozenOrigin() {
  const note = (await annotations()).find(n => n.id === frozenNote.id);
  assert.deepEqual(note.anchor, frozenNote.anchor); assert.equal(note.materialDigest, frozenNote.materialDigest); assert.equal(note.note, frozenNote.note);
  assert.equal((await new FileTags(fixture.projectA).materials.get(note.materialDigest)).toString(), originalPaper);
  return note;
}
async function persistedDrafts(noteId, discussionDraft, mainDraft) {
  await wait(async () => (await annotations()).find(n => n.id === discussionId)?.projection?.draftText === discussionDraft && (await state()).drafts.frontdesk === mainDraft, 'tag/main draft persistence');
  if (noteId) {
    await click(tag(noteId) + ' .note-index');
    await click(tag(noteId) + ' .tag-edit');
    check('Unsent local note edit draft restored', await page.$eval(tag(noteId) + ' .tag-editor', el => el.value) === 'UNSENT_LOCAL_NOTE_ALPHA');
    await click(tag(noteId) + ' .tag-close');
  }
}
const systemSource = resolveSystemOmpSource();
async function officialMetadata() {
  const result = {};
  for (const name of ['config.yml','config.yaml','models.yml','models.yaml','agent.db','auth.db']) {
    const s = await fs.stat(path.join(systemSource.agentDir, name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (s) result[name] = {size: s.size, mtimeMs: s.mtimeMs, ino: s.ino};
  }
  return result;
}
const officialBefore = await officialMetadata();
try {
  fixture = await createReaderAcceptanceProject(root);
  assert(fixture.projectA !== fixture.projectB && [fixture.projectA, fixture.projectB].every(p => path.isAbsolute(p) && p.startsWith(root + '/')));
  assert.deepEqual(Object.keys(fixture.questions).sort(), ['explain','followup','readable']);
  await save('questions.json', {questions: fixture.questions, source: 'Synthetic fixture natural reading questions; no internal protocol requested from model', calls: 3});
  originalPaper = await fs.readFile(path.join(fixture.projectA, fixture.files.paper), 'utf8');
  originalFiles = {A: await snapshotFiles(fixture.projectA), B: await snapshotFiles(fixture.projectB)};
  const host = new DesktopHost(profile);
  registrations = {A: (await host.pick(fixture.projectA)).project, B: (await host.pick(fixture.projectB)).project};
  collector = await createAcceptanceCollector({ledgerPath: path.join(root, 'ledger.json'),
    allowedDestinations: ['https://sub.1983070.xyz/responses','https://sub.1983070.xyz/v1/responses'], allowedModels: ['gpt-6.1-sol'],
    onStop: async reason => { if (!['complete','failure'].includes(reason) && child?.ownedStamp && await processStamp(child.pid) === child.ownedStamp) child.kill('SIGTERM'); }});
  stage = 'configuration'; await launch();
  await page.waitForSelector('#configuration-setup[open]'); await click('#configuration-api-keys'); await click('#configuration-import');
  await page.waitForFunction(() => !document.querySelector('#configuration-setup').open);
  const setup = await invoke('config.status'); check('Actual configuration UI imports only explicitly allowed static keys', setup.initialized && setup.choice === 'import');
  const control = path.join(privateRoot, 'control'); await fs.mkdir(control, {recursive: true});
  const extension = path.join(control, 'reader-acceptance.mjs');
  await fs.writeFile(extension, `import {installAcceptanceControl} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'acceptance-request-control.mjs')).href)};\nexport default pi => installAcceptanceControl(pi,{endpoint:${JSON.stringify(collector.endpoint)},roleInstance:process.env.NOZELI_AGENT_DIR,brokerURL:process.env.OMP_AUTH_BROKER_URL??null});\n`, {mode: 0o600});
  const configPath = path.join(privateRoot, 'omp/config.yml'), config = parse(await fs.readFile(configPath, 'utf8'));
  config.modelRoles = Object.fromEntries(['default','smol','slow','plan','designer'].map(role => [role,'paratera/gpt-6.1-sol']));
  config.defaultThinkingLevel = 'low'; config.extensions = [extension]; await fs.writeFile(configPath, stringify(config), {mode: 0o600});
  stage = 'local-note'; await resize(1440); await switchProject('A');
  const baseline = {jobs: (await state()).jobs.length, http: admissionCount()};
  await selectQuote(); await click('#selection-note'); await page.waitForSelector('#note-form:not([hidden])');
  await fill('#note-input', 'Local reader note: keep the second 60-second quote frozen.'); await click('#add-note');
  frozenNote = await wait(async () => (await annotations()).find(n => n.note === 'Local reader note: keep the second 60-second quote frozen.'), 'local note save');
  const expectedOffset = originalPaper.indexOf(fixture.files.quote, originalPaper.indexOf(fixture.files.quote) + 1);
  check('Physical selection anchors exact second repeated quote', expectedOffset >= 0 && frozenNote.anchor.start === expectedOffset && frozenNote.anchor.end === expectedOffset + fixture.files.quote.length && frozenNote.anchor.quote === fixture.files.quote, frozenNote);
  await noDispatch('Local note save causes zero jobs and zero HTTP', baseline); await frozenOrigin();
  await click(tag(frozenNote.id)+' .tag-close');
  await wait(()=>page.$eval(tag(frozenNote.id)+' .note-projection',el=>el.classList.contains('is-collapsed')),'initial note physically collapsed before density');
  stage = 'annotation-density';
  await page.waitForSelector('#text-preview h2',{visible:true});
  const denseNotes = [];
  for (const section of [1,2,3,4,8,12,16,20,24,28,32,36]) {
    const quote = 'ANCHOR_' + String(section).padStart(2, '0'), offset = originalPaper.indexOf(quote);
    assert(offset >= 0, 'Synthetic density anchor exists: ' + quote);
    await selectDensityAnchor(quote); await click('#selection-note');
    const text = 'Local density note ' + quote;
    await fill('#note-input',text); await click('#add-note');
    const note = await wait(async () => (await annotations()).find(n => n.note === text), 'density note ' + quote);
    check('Density exact source and frozen quote ' + quote, note.anchor.start === offset && note.anchor.quote === quote && (await new FileTags(fixture.projectA).materials.get(note.materialDigest)).toString() === originalPaper, {id:note.id,offset,quote});
    denseNotes.push(note.id);
    await click(tag(note.id) + ' .tag-close');
    await wait(()=>page.$eval(tag(note.id)+' .note-projection',el=>el.classList.contains('is-collapsed')),'density note physically folded '+quote);
  }
  check('Twelve actual local notes retain twelve distinct sidecar identities across offscreen sections', new Set(denseNotes).size === 12, denseNotes);
  await noDispatch('Dense local annotation creation remains zero jobs and zero HTTP',baseline);
  await shot('dense-local-notes'); await selectQuote();
  await page.keyboard.press('Escape');
  stage = 'local-drafts';
  await click(tag(frozenNote.id) + ' .note-index');
  await click(tag(frozenNote.id) + ' .tag-edit'); await fill(tag(frozenNote.id) + ' .tag-editor', 'UNSENT_LOCAL_NOTE_ALPHA');
  await click(tag(frozenNote.id) + ' .tag-close');
  await wait(async () => (await annotations()).find(n => n.id === frozenNote.id)?.view?.collapsed === true, 'local note fold saved');
  await selectQuote(); await click('#selection-discuss');
  discussionId = await wait(async () => (await annotations()).find(n => n.projection)?.id, 'discussion draft identity');
  await fill(tag(discussionId) + ' .tag-editor', 'UNSENT_TAG_ALPHA'); await fill('#composer', 'UNSENT_MAIN_ALPHA');
  await persistedDrafts(null, 'UNSENT_TAG_ALPHA', 'UNSENT_MAIN_ALPHA');
  await switchProject('B');
  check('Same paper name in project B has no project A annotations', (await annotations()).length === 0);
  check('Main draft does not leak from project A', await page.$eval('#composer', el => el.value) !== 'UNSENT_MAIN_ALPHA');
  await selectQuote(); await click('#selection-note'); await fill('#note-input', 'Local beta note'); await click('#add-note');
  const betaNote = await wait(async () => (await annotations()).find(n => n.note === 'Local beta note'), 'beta note');
  await click(tag(betaNote.id) + ' .tag-close');
  await selectQuote(); await click('#selection-discuss');
  const betaDiscussion = await wait(async () => (await annotations()).find(n => n.projection), 'beta discussion');
  await fill(tag(betaDiscussion.id) + ' .tag-editor', 'UNSENT_TAG_BETA'); await fill('#composer', 'UNSENT_MAIN_BETA');
  await wait(async () => (await annotations()).find(n => n.id === betaDiscussion.id)?.projection?.draftText === 'UNSENT_TAG_BETA' && (await state()).drafts.frontdesk === 'UNSENT_MAIN_BETA', 'beta drafts');
  await switchProject('A');
  check('Local note stays folded across project switching', await page.$eval(tag(frozenNote.id) + ' .note-projection', el => el.classList.contains('is-collapsed')));
  await persistedDrafts(frozenNote.id, 'UNSENT_TAG_ALPHA', 'UNSENT_MAIN_ALPHA');
  await noDispatch('Both projects local notes and unsent drafts dispatch nothing', baseline);

  stage = 'actual-model'; await invoke('managed.enable', {projectId: activeId});
  await wait(async () => (await invoke('managed.status', {projectId: activeId})).ready, 'real native reader resident', 120000);
  const explained = await sendTag(fixture.questions.explain, '01-explain');
  const readable = await sendTag(fixture.questions.readable, '02-readable', async job => {
    await wait(() => page.$('#conversation [role=status]'), 'actual streaming reply for scroll-away', 120000);
    const geometry = await wait(() => page.$eval('#conversation', el => el.scrollHeight > el.clientHeight + 30 ? {height:el.clientHeight,extent:el.scrollHeight} : null), 'actual streamed history becomes scrollable',120000);
    check('Long real conversation has scrollable history during output', geometry.extent > geometry.height + 30, geometry);
    const point = await page.$eval('#conversation', el => { const b = el.getBoundingClientRect(); return {x: b.x + b.width / 2, y: b.y + b.height / 2}; });
    await page.mouse.move(point.x, point.y); await page.mouse.wheel({deltaY: -10000});
    await page.focus('#composer');
    const start = await page.$eval('#conversation', el => ({top: el.scrollTop, height: el.scrollHeight}));
    await wait(async () => {
      const now = await page.$eval('#conversation', el => ({top: el.scrollTop, height: el.scrollHeight}));
      const s = await state(); return now.height > start.height + 20 || !['queued','running'].includes(s.jobs.find(j => j.id === job.id)?.status) ? now : null;
    }, 'real output after manual scroll away', 120000);
    const after = await page.$eval('#conversation', el => ({top: el.scrollTop, extent: el.scrollHeight, height: el.clientHeight, focus: document.activeElement?.id}));
    check('Streaming does not steal scrolled reading position or composer focus', after.top <= start.top + 3 && after.focus === 'composer' && after.extent - after.height - after.top > 20, {start, after});
    await shot('stream-scroll-away');
  });
  const replySelector = '#conversation [data-message=' + JSON.stringify(readable.reply.id) + ']';
  const rendering = await page.$eval(replySelector, el => ({headings: el.querySelectorAll('h1,h2,h3,h4').length, formulas: el.querySelectorAll('.katex').length, code: el.querySelectorAll('pre code').length, tables: el.querySelectorAll('table').length, errors: el.querySelectorAll('.katex-error').length, text: el.textContent}));
  check('Actual model answer renders headings, formula, code and table, not Markdown source', rendering.headings > 0 && rendering.formulas > 0 && rendering.code > 0 && rendering.tables > 0 && rendering.errors === 0, rendering);
  const numbers = JSON.parse(await fs.readFile(path.join(fixture.projectA, fixture.files.measurements || 'data/measurements.json'), 'utf8'));
  const [a,b] = numbers.conditions;
  const evidence = {points:100 * (b.hits/b.requests-a.hits/a.requests),p50:b.p50Ms-a.p50Ms,p95:a.p95Ms-b.p95Ms};
  check('Readable answer agrees with actual fixture numerical evidence', Math.abs(evidence.points-16)<1e-9 && evidence.p50===12 && evidence.p95===182 && /16\s*(?:个)?百分点/.test(readable.reply.text) && /182/.test(readable.reply.text) && /12/.test(readable.reply.text) && readable.reply.text.includes(fixture.files.paper), {evidence,reply:readable.reply.text});
  check('Actual reading questions caused real tool execution', [...explained.entries, ...readable.entries].some(e => e.tool || e.toolCalls?.length), {entries: [...explained.entries, ...readable.entries].map(e => e.id)});
  const process = replySelector + ' details.session-tool';
  await click(process + ' summary'); check('Actual process fold opens', await page.$eval(process, el => el.open)); await click(process + ' summary'); check('Actual process fold closes', !await page.$eval(process, el => el.open));
  await click(replySelector + ' .message-actions button:nth-child(2)');
  await page.waitForSelector(replySelector+' [data-message-copy="copied"]');
  check('Copy pure text copies the actual unabridged native reply', await invoke('document.clipboard', {action: 'read'}) === readable.reply.text);
  for (const width of [1440,800,390]) {
    await resize(width);
    await click(tag(discussionId) + ' .tag-close'); await click(tag(discussionId) + ' .note-index');
    // Per-card font dropdown is gone: the GLOBAL conversation menu (right-click
    // on the card) owns the size at every width.
    await click(tag(discussionId) + ' .tag-editor', {button: 'right'});
    await page.waitForSelector('#conversation-context-menu:not([hidden])', {visible: true});
    const sizeSelector='.nozeli-context-menu:not([hidden]) [data-command="chat-font-18"]';
    await page.focus('#conversation-context-menu [data-command="chat-font"]');await page.keyboard.press('ArrowRight');
    await page.waitForSelector(sizeSelector, {visible:true});
    await page.focus(sizeSelector);await page.keyboard.press('Enter');
    check('Global conversation font control sets the tag to 18px at ' + width, await page.$eval(tag(discussionId) + ' .tag-editor', el => getComputedStyle(el).fontSize === '18px'));
    await page.focus(tag(discussionId) + ' .tag-editor');
    const geometry = await page.evaluate(selector => {
      const card = document.querySelector(selector + ' .note-projection'), b = card.getBoundingClientRect();
      return {width: innerWidth, documentOverflow: document.documentElement.scrollWidth - innerWidth, bounds: b.toJSON(), cardOverflow: card.scrollWidth - card.clientWidth, focus: document.activeElement?.className};
    }, tag(discussionId));
    check('Actual reader card fits and retains input focus at ' + width, geometry.documentOverflow <= 1 && geometry.bounds.left >= -1 && geometry.bounds.right <= width + 1 && geometry.cardOverflow <= 1 && geometry.focus.includes('tag-editor'), geometry);
    await shot('reader-' + width);
  }
  await resize(1440);
  stage = 'source-version';
  // Real editor prefix edit creates a new version; frozen annotation is never rewritten.
  await contentToolForPage(page, ['view', 'text-mode']);
  await page.evaluate(() => { window.__nozeliInput.focus(); window.__nozeliInput.select(0,0); });
  const prefix = 'Reader-owned prefix version two.\n\n'; await page.keyboard.sendCharacter(prefix);
  await wait(() => page.$eval('#save-status', el => el.dataset.state === 'saved'), 'real source prefix autosave');
  check('Source prefix edit saved through actual editor', await fs.readFile(path.join(fixture.projectA, fixture.files.paper), 'utf8') === prefix + originalPaper);
  await contentToolForPage(page, ['view', 'text-mode']); await frozenOrigin();
  const continuation = await sendTag(fixture.questions.followup, '03-followup');
  check('Source-edit continuation retains same selection conversation', (await annotations()).find(n => n.id === discussionId)?.projection.history.length === 3, {discussionId, accepted: [explained.job.id,readable.job.id,continuation.job.id]});
  // Remove both current occurrences through the real editor, then bind the orphan to
  // the visible replacement. The original quote and material remain immutable.
  await contentToolForPage(page, ['view', 'text-mode']);
  const currentText = prefix + originalPaper, replacement = 'The revised cache expires after 75 seconds.';
  for (let index = currentText.lastIndexOf(fixture.files.quote); index >= 0; index = currentText.lastIndexOf(fixture.files.quote, index - 1)) {
    await page.evaluate(({index, length}) => { window.__nozeliInput.focus(); window.__nozeliInput.select(index, index + length); }, {index, length: fixture.files.quote.length});
    await page.keyboard.press('Backspace');
    if (index === 0) break;
  }
  await page.evaluate(() => { window.__nozeliInput.focus(); window.__nozeliInput.select(0,0); });
  await page.keyboard.sendCharacter(replacement + '\n\n');
  await wait(() => page.$eval('#save-status', el => el.dataset.state === 'saved'), 'replacement source save');
  const editedPaper = (await fs.readFile(path.join(fixture.projectA, fixture.files.paper), 'utf8'));
  await page.reload(); await page.waitForFunction(() => window.__nozeliReady);
  await page.waitForSelector('#unlocated-tags:not([hidden])');
  if (!await page.$eval('#unlocated-tags', el => el.open)) await click('#unlocated-tags > summary');
  const start = editedPaper.lastIndexOf(replacement); assert(start >= 0);
  await page.evaluate(({start,length}) => { window.__nozeliInput.focus(); window.__nozeliInput.select(start,start + length); }, {start,length:replacement.length});
  const relocate = '#unlocated-tags .unlocated-tag:has([data-annotation=' + JSON.stringify(frozenNote.id) + ']) .tag-relocate';
  await click(relocate);
  await wait(async () => (await annotations()).find(n => n.id === frozenNote.id)?.resolution?.method === 'manual', 'actual stale note reanchor');
  const reanchored = await frozenOrigin();
  check('Actual stale reanchor appends relocation without rewriting original quote/version', reanchored.relocations.length === 1 && reanchored.resolution.anchor.quote === replacement, reanchored);
  // The discussion remains orphaned until explicitly relocated independently.
  await page.evaluate(({start,length}) => { window.__nozeliInput.focus(); window.__nozeliInput.select(start,start + length); }, {start,length:replacement.length});
  await click('#unlocated-tags .unlocated-tag:has([data-annotation=' + JSON.stringify(discussionId) + ']) .tag-relocate');
  await wait(async () => (await annotations()).find(n => n.id === discussionId)?.resolution?.method === 'manual', 'discussion explicit reanchor');
  if (await page.$eval('#text-preview', el => el.hidden)) await contentToolForPage(page, ['view', 'text-mode']);
  await fill(tag(discussionId) + ' .tag-editor', 'UNSENT_TAG_ALPHA_REOPEN'); await fill('#composer', 'UNSENT_MAIN_ALPHA_REOPEN');
  await persistedDrafts(null, 'UNSENT_TAG_ALPHA_REOPEN', 'UNSENT_MAIN_ALPHA_REOPEN');
  if (!await page.$eval(tag(frozenNote.id) + ' .note-projection', el => el.classList.contains('is-collapsed'))) await click(tag(frozenNote.id) + ' .tag-close');
  stage = 'normal-reopen';
  const beforeA = await state(), beforeB = await state(registrations.B.id), beforeHTTP = admissionCount();
  const identities = s => ({jobs:s.jobs.map(j => ({id:j.id,status:j.status})),threads:Object.entries(s.residents||{}).map(([target,resident])=>({target,threadId:resident.threadId})).sort((a,b)=>a.target.localeCompare(b.target)),drafts:s.drafts});
  await page.$eval('#reader-scroll', el => { el.scrollTop = Math.min(300, el.scrollHeight - el.clientHeight); el.dispatchEvent(new Event('scroll')); }); await pause(800);
  const position = await page.$eval('#reader-scroll', el => el.scrollTop);
  await save('before-reopen.json', {A:beforeA,B:beforeB,position,annotations:await annotations()}); await shot('before-reopen');
  await close(); await launch();
  check('Initialized static-key setup remains dismissed on normal reopen', !await page.$eval('#configuration-setup', el => el.open));
  await page.waitForFunction(name => document.querySelector('#file-path')?.textContent.trim() === name, {}, fixture.files.paper);
  check('Active paper and reading position restored on normal reopen', Math.abs(await page.$eval('#reader-scroll', el => el.scrollTop) - position) < 3, {position});
  assert.deepEqual(identities(await state()), identities(beforeA)); assert.deepEqual(identities(await state(registrations.B.id)), identities(beforeB));
  check('Normal reopen preserves exact native thread IDs, accepted job IDs and both project drafts', true, {A:identities(beforeA),B:identities(beforeB)});
  check('Normal reopen does not replay a model HTTP request', admissionCount() === beforeHTTP, {beforeHTTP, afterHTTP:admissionCount()});
  await persistedDrafts(frozenNote.id, 'UNSENT_TAG_ALPHA_REOPEN', 'UNSENT_MAIN_ALPHA_REOPEN'); await frozenOrigin();
  await switchProject('B');
  check('Project B restores its own active paper, main/tag drafts and fold', await page.$eval('#composer', el => el.value) === 'UNSENT_MAIN_BETA' && (await annotations()).find(n => n.id === betaDiscussion.id)?.projection.draftText === 'UNSENT_TAG_BETA' && (await annotations()).find(n => n.id === betaNote.id)?.view.collapsed === true);
  await switchProject('A'); await noDispatch('Project reopening and switching admit no replay jobs or HTTP', {jobs:beforeA.jobs.length,http:beforeHTTP});
  const finalA = await snapshotFiles(fixture.projectA), finalB = await snapshotFiles(fixture.projectB);
  delete finalA[fixture.files.paper]; const unaskedA = {...originalFiles.A}; delete unaskedA[fixture.files.paper];
  assert.deepEqual(finalA, unaskedA); assert.deepEqual(finalB, originalFiles.B);
  check('Every original unasked source file and project B paper remains byte-identical', true, {A:finalA,B:finalB});
  check('New source version remains exact and frozen quote remains unchanged', await fs.readFile(path.join(fixture.projectA, fixture.files.paper), 'utf8') === editedPaper && (await frozenOrigin()).anchor.quote === fixture.files.quote);
  check('No renderer errors occurred', errors.length === 0, errors);
  await save('final-state.json', {A:await state(),B:await state(registrations.B.id),annotations:await annotations()}); await shot('after-reopen'); await close();
} catch (error) {
  failure = error;
  await save('error.json', {stage, name:error.name,message:error.message,stack:error.stack,response:error.response,job:error.job});
  if (page) {
    await save('failure-state.json', {state: activeId ? await state().catch(e => ({error:e.stack})) : null, annotations: activeId ? await annotations().catch(e => ({error:e.stack})) : null,
      dom: await page.evaluate(() => ({body:document.body.innerText,html:document.documentElement.outerHTML,focus:document.activeElement?.outerHTML})).catch(e => ({error:e.stack}))});
    await shot('failure').catch(() => {});
  }
} finally {
  await collector?.stop(failure ? 'failure' : 'complete');
  try { await close(); } catch (error) { failure ??= error; }
  await browser?.disconnect().catch(() => {});
  if (child?.ownedStamp && await processStamp(child.pid) === child.ownedStamp) {
    child.kill('SIGTERM'); const ended = await Promise.race([exited,pause(5000).then(() => null)]);
    if (!ended && await processStamp(child.pid) === child.ownedStamp) process.kill(-child.pid,'SIGKILL');
    await Promise.race([exited,pause(5000)]);
  }
  for (const runtime of runtimes) {
    const stored = JSON.parse(await fs.readFile(path.join(runtime,'state.json'),'utf8').catch(() => '{}'));
    for (const record of Object.values(stored.providers || {})) if (record.pid && record.stamp) owners.set(record.pid,{record,runtime});
  }
  let reaped = true;
  for (const {record,runtime} of owners.values()) {
    try { assert.equal((await recoverOmpProvider(record,runtime)).verified,true); } catch (error) { reaped=false; failure ??= error; }
  }
  if (reaped) {
    // Retain ALL native evidence, removing only known private credential copies.
    for (const runtime of runtimes) for (const entry of await fs.readdir(path.join(runtime,'agents'),{withFileTypes:true}).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      for (const name of ['auth.json','auth.db','auth.db-shm','auth.db-wal','config.yml','config.yaml','models.yml','models.yaml']) await fs.rm(path.join(runtime,'agents',entry.name,name),{force:true});
    }
    await fs.rm(path.join(privateRoot,'omp'),{recursive:true,force:true});
  }
  await fs.writeFile(path.join(root,'electron.log'),log,{mode:0o600});
  await save('operations.json',operations);
  const officialAfter = await officialMetadata();
  if (JSON.stringify(officialAfter) !== JSON.stringify(officialBefore)) failure ??= Error('Official OMP metadata changed');
  await save('result.json',{pass:!failure,installedRelease:release,root,stage,checks,bug:failure ? {message:failure.message,stack:failure.stack,stage} : null,
    errors,questions:fixture?.questions,ledger:collector?.snapshot(),officialBefore,officialAfter,ownedKeysRemoved:reaped,
    scopes:{platform:'Linux only',model:'Actual paid paratera/gpt-6.1-sol via strict destination collector; at most three natural reading questions, no automatic retry',
      deterministic:'Synthetic Markdown/TeX/Bib/JSON fixture, exact selection/source/draft/job/thread/clipboard/geometry assertions; no user papers or credentials modified',
      limits:'Normal close/reopen and renderer reload only. Long stability and native/main crash recovery remain the separate desktop-collab-workspace-live suite. No claim of cross-platform coverage.'}});
  await collector?.close();
}
console.log(JSON.stringify({pass:!failure,checks:checks.length,stage,root}));
process.exitCode = failure ? 1 : 0;
