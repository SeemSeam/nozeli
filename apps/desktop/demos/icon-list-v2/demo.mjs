import {uiIcon} from '../../src/renderer/ui-icons.mjs';
import {setActionButton} from '../../src/renderer/ui-actions.mjs';
import {mountUiTooltip,hideUiTooltip} from '../../src/renderer/ui-tooltip.mjs';
import {groups,actions} from './catalog.mjs';
const $=id=>document.getElementById(id),byKey=new Map(actions.map(a=>[a.key,a]));
let lang='zh-CN',selected=false,connected=false;
const t=(zh,en)=>lang==='zh-CN'?zh:en;
function el(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
// Single graphics source: every glyph comes from production ui-icons.mjs.
const glyph=uiIcon;
function feedback(text){$('feedback').textContent=t('演示反馈：','Preview: ')+text;}
async function confirmAction(action){hideUiTooltip();const d=$('confirm');$('confirm-title').textContent=action.labels[lang];$('confirm-body').textContent=action.hints[lang];$('confirm-note').textContent=t('仅为界面预览：确认后不会写入、删除、派工或停止真实任务。','UI preview only: confirmation does not write, delete, dispatch or stop real work.');$('cancel').textContent=t('取消','Cancel');$('proceed').textContent=action.labels[lang];d.returnValue='';d.showModal();const result=await new Promise(resolve=>d.addEventListener('close',()=>resolve(d.returnValue),{once:true}));if(result==='confirm')feedback(t('已确认预览，未执行真实操作','Preview confirmed; no real action was performed'));}
function button(key,{context=false}={}){
 // Presentation, glyph, bilingual labels and tooltip all come from the
 // production action catalog; hover/focus hints run through the delegated
 // ui-tooltip singleton instead of per-button listeners.
 const action=byKey.get(key),b=el('button');b.type='button';
 setActionButton(b,key,{locale:lang});
 if(action.presentation==='icon'&&action.icon)b.classList.add('icon-only');
 if(key==='select-region')b.setAttribute('aria-pressed',String(context&&selected));
 b.onclick=async()=>{
  hideUiTooltip();
  if(['accept','return-drafts','stop-turn'].includes(key))return confirmAction(action);
  if(key==='delete')return feedback(t('删除预览，未操作真实备注','Delete preview; no real note changed'));
  if(key==='edit'){
   return feedback(t('编辑入口预览；画笔工具保持独立','Edit entry preview; drawing remains a separate tool'));
  }
  if(key==='select-region'){
   const value=b.getAttribute('aria-pressed')!=='true';b.setAttribute('aria-pressed',String(value));
   if(context)selected=value;
   return feedback(t(value?'框选模式已开启（仅预览）':'已退出框选模式',value?'Region mode on (preview)':'Region mode off'));
  }
  if(context&&key==='compile'){
   b.disabled=true;b.lastElementChild.textContent=t('编译中…','Compiling…');b.setAttribute('aria-label',t('编译中','Compiling'));
   await new Promise(resolve=>setTimeout(resolve,650));
   b.disabled=false;b.lastElementChild.textContent=action.labels[lang];b.setAttribute('aria-label',action.labels[lang]);
   $('compile-state').textContent=t('演示状态：编译完成；没有运行真实编译器','Demo state: compilation complete; no compiler was run');return;
  }
  if(context&&key==='reconnect'){
   connected=true;
   $('terminal-state').textContent=t('演示状态：已连接；没有启动 Shell','Demo state: connected; no shell started');return;
  }
  const messages={save:t('人工稿已保存（演示），项目原件未修改','Draft saved (demo); project original unchanged'),export:t('已请求导出副本（演示），没有创建文件','Export requested (demo); no file created'),explain:t('当前选区将发送给 AI（演示），未调用模型','Selection would be sent to AI (demo); no model called'),send:t('消息已排队（演示），未实际发送','Message queued (demo); nothing sent')};
  feedback(messages[key]||action.labels[lang]+t('（仅展示）',' (preview only)'));
 };
 return b;
}
function heading(title,keys){const h=el('div','panel-head');h.append(el('strong','',title));const tools=el('div','tools');for(const key of keys)tools.append(button(key));h.append(tools);return h;}
function examples(){
 const wrapper=el('div','examples'),reader=el('section','panel');
 reader.append(el('span','pill',t('01 / 编辑器 · 通用操作去字','01 / Editor · familiar actions, less text')),heading('research-notes.tex',['float-view','more','close-view']));
 const tools=el('div','row');for(const key of ['edit','save','export','reset-view','select-region','compile'])tools.append(button(key,{context:true}));
 reader.append(tools);
 const text=el('div','manuscript');text.append(el('h3','','Research notes'),el('p','',t('图标负责快速辨识，必要含义放在上下文中。保存人工稿不等于合入项目。','Icons support recognition; context preserves meaning. Saving a draft is not merging it.')));reader.append(text);
 const notes=el('div','row');for(const key of ['note','discuss','explain'])notes.append(button(key));reader.append(notes);
 const drawing=el('div','review-part');drawing.append(el('h3','',t('涂鸦工具','Drawing tools')));const drawingTools=el('div','tools');for(const key of ['draw','erase','undo','redo','finish-drawing'])drawingTools.append(button(key));drawing.append(drawingTools);reader.append(drawing);
 const compile=el('p','hint',t('编译状态：就绪（演示）','Compiler state: ready (demo)'));compile.id='compile-state';reader.append(compile);
 const terminal=el('div','terminal');terminal.append(el('h3','',t('终端连接','Terminal connection')));
 const state=el('p','hint',t(connected?'演示状态：已连接':'演示状态：终端已退出',connected?'Demo state: connected':'Demo state: terminal exited'));state.id='terminal-state';terminal.append(state,button('reconnect',{context:true}));reader.append(terminal);
 const review=el('section','panel');review.append(el('span','pill',t('02 / 成果审阅 · 图标与上下文','02 / Review · icons in context')),heading(t('审核稿 · 方法章节','Reviewed draft · Methods'),['more','close-view']),el('p','',t('示例文件：methods.md · 审核版本 V3','Example file: methods.md · Review version V3')));
 const feedbackArea=el('div','review-part');feedbackArea.append(el('h3','',t('讨论与人工稿交回','Discussion & edited drafts')));
 const field=el('textarea');field.setAttribute('aria-label',t('修改意见','Revision feedback'));field.placeholder=t('写下修改意见…','Write revision feedback…');
 const row=el('div','row');row.append(button('send'),button('return-drafts'));feedbackArea.append(field,row);
 const candidate=el('div','review-part');candidate.append(el('h3','',t('交回修改 · 候选入口','Return for revision · candidate')),button('return-work'),el('p','hint',t('候选动作：请求继续修改，非独立生产入口。','Candidate action: request further revision; not a separate production entry.')));
 const decision=el('div','review-part');decision.append(el('h3','',t('应用决定','Apply decision')),el('p','',t('应用当前审核稿到项目，并结束工作。','Apply this reviewed draft to the project and finish the work.')));
 const accept=button('accept');accept.classList.add('primary');decision.append(accept);
 const secondary=el('div','review-part');secondary.append(el('h3','',t('回合与备注操作','Turn & note actions')));const options=el('div','row');options.append(button('stop-turn'),button('delete'));secondary.append(options);
 const warning=el('p','warning');warning.append(glyph('triangle-alert'),el('span','',t('仅为演示，不操作真实文件或任务。','Preview only; no real files or tasks are changed.')));
 review.append(feedbackArea,candidate,decision,secondary,warning);wrapper.append(reader,review);$('examples').replaceChildren(wrapper);
}
function renderList(){const query=$('search').value.trim().toLowerCase();$('catalog').replaceChildren();for(const group of groups){const rows=group.actions.filter(a=>[a.key,a.icon,...Object.values(a.labels),...Object.values(a.hints)].join(' ').toLowerCase().includes(query));if(!rows.length)continue;const section=el('section');section.append(el('h3','',t(group.zh,group.en)));const grid=el('div','grid');for(const action of rows){const card=el('article','card');card.dataset.key=action.key;const preview=el('div','preview');if(action.presentation==='status'){preview.append(glyph(action.icon),el('span','',action.labels[lang]));}else preview.append(button(action.key));card.append(preview,el('div','mode',action.candidate?t('候选动作 · 非独立生产入口','Candidate · not a production entry'):({icon:action.tooltip===false?t('纯图标','Icon only'):t('纯图标＋提示','Icon + tooltip'),label:t('图标＋短文字','Icon + short label'),text:t('必要文字','Essential text'),status:t('状态 · 非按钮','Status · not a button')})[action.presentation]),el('h3','',action.labels[lang]),el('span','key',`${action.key} · ${action.icon||'text'}`),el('div','secondary',action.labels[lang==='zh-CN'?'en':'zh-CN']));if(action.tooltip!==false)card.append(el('p','',action.hints[lang]));grid.append(card);}section.append(grid);$('catalog').append(section);}}
function render(){hideUiTooltip();document.documentElement.lang=lang;$('heading').textContent=t('少一点文字，多一点清晰','Less text. More clarity.');$('intro').textContent=t('删除、重连、采纳只留图标；编辑与画笔分开，交回修改加入统一清单。','Icon-only delete, reconnect and accept. Distinct edit and draw icons, plus return for revision.');$('brand-note').textContent=t('沿用现有品牌与线性图标风格','Existing brand · consistent line icons');$('list-heading').textContent=t(`完整动作清单 · ${actions.length} 项`,`Complete action list · ${actions.length} entries`);$('list-note').textContent=t('清单名称用于查阅，不是按钮常驻文字。所有点击仅为预览。','Catalog labels are for reference, not button captions. All clicks are previews.');$('search').placeholder=t('搜索名称、key 或提示','Search labels, keys or hints');$('language').textContent=lang==='zh-CN'?'English':'中文';$('feedback').textContent='';examples();renderList();}
$('language').onclick=()=>{lang=lang==='zh-CN'?'en':'zh-CN';render();};$('theme').onclick=()=>document.body.classList.toggle('dark');$('search').oninput=()=>{hideUiTooltip();renderList();};
// One delegated controller per document: hover/focus hints, Escape close and
// orphan cleanup all live in production ui-tooltip.mjs.
mountUiTooltip();render();
