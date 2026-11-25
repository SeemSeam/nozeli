// Production single-source bilingual action catalog (ui-actions.mjs).
// Confirmed baseline: demos/icon-list-v2 (2026-11-13, 45 keys). Semantically
// distinct entries added on top at shard request: jump-definition,
// diff-previous, diff-next, window-minimize, window-maximize,
// choose-comparison, focus-editor, show-conversation, browse-back,
// browse-forward, reload, stop-load, open-project, cancel-drawing,
// remove-tag, parent-directory. Glyph geometry lives ONLY in ui-icons.mjs;
// pages never embed a second SVG copy.
//
// actionList is an object keyed by action key (insertion order follows the
// catalog groups below); use Object.values(actionList) for the ordered array.
// Each action: {key, icon|null, presentation, labels, hints, tooltip, candidate}
//   presentation 'icon' = pure icon tool; 'label' = icon + short caption;
//   'text' = caption only; 'status' = visible state, never a button.
//   tooltip:false marks user-confirmed icon-only actions (delete/reconnect/
//   accept): accurate zh/en labels stay in aria-label, no hover/focus hint.
import {setIconButton} from './ui-icons.mjs';
import {setUiHint} from './ui-tooltip.mjs';

// [key, glyph|null, presentation, zh label, en label, zh hint, en hint]
// Rows without dedicated hints intentionally reuse their labels as hints.
const table = [
  ['window','窗口与布局','Windows & layout',[
    ['close-view','close','icon','关闭当前内容','Close current content'],
    ['hide-conversation','close','icon','关闭对话面板，保留消息与草稿','Close conversation panel; keep messages and draft'],
    ['show-conversation','message-square','icon','打开当前项目对话','Open project conversation','打开项目对话；消息与草稿保持不变','Open the project conversation; messages and drafts stay unchanged'],
    ['float-view','floating','icon','在独立窗口打开','Open in a separate window'],
    ['dock-view','panel-top','icon','返回主窗口','Dock to main window','将独立窗口内容移回主工作区','Move this content back to the main workspace'],
    ['layout','layout','icon','布局与分屏','Layout and split view'],
    ['maximize-content','maximize','icon','最大化内容','Maximize content'],
    ['restore-content','minimize','icon','恢复内容大小','Restore content size'],
    ['more','ellipsis','icon','更多操作','More actions'],
    ['window-minimize','minus','icon','最小化窗口','Minimize window','最小化当前窗口；内容与对话保持打开','Minimize this window; content and conversations stay open'],
    ['window-maximize','maximize','icon','最大化或还原窗口','Maximize or restore window','在最大化与原大小之间切换当前窗口','Switch this window between maximized and its original size']
  ]],
  ['navigation','导航与查看','Navigation & viewing',[
    ['search','search','icon','查找','Find'],
    ['outline','list-tree','icon','文档目录','Document outline'],
    ['parent-directory','chevron-up','icon','上级目录','Parent directory','返回上一级目录；目录仅浏览，不读取内容','Go up one directory level; directories are browsed only, no content is read'],
    ['read','book-open','icon','阅读','Read'],
    ['jump-definition','corner-up-right','icon','跳转定义','Go to definition','跳转到光标处符号的定义；不是查找','Jump to the definition of the symbol at the cursor; not a search'],
    ['diff-previous','chevron-up','icon','上一处差异','Previous difference','跳到上一处差异；不修改内容','Go to the previous difference; no content changes'],
    ['diff-next','chevron-down','icon','下一处差异','Next difference','跳到下一处差异；不修改内容','Go to the next difference; no content changes'],
    ['browse-back','chevron-left','icon','后退','Back','返回浏览历史中的上一页','Go back to the previous page in browsing history'],
    ['browse-forward','chevron-right','icon','前进','Forward','前往浏览历史中的下一页','Go forward to the next page in browsing history'],
    ['reload','rotate-cw','icon','刷新','Reload','重新加载当前页面','Reload the current page'],
    ['stop-load','square','icon','停止加载','Stop loading','停止加载当前页面；已收到的内容保留','Stop loading this page; content already received stays'],
    ['choose-comparison','layout','label','更换对照','Change comparison','更换对照文件或历史版本；当前内容不变','Change the comparison file or history version; current content stays unchanged'],
    ['focus-editor','square-pen','label','回到编辑位置','Back to editing position','从阅读副本回到编辑位置；不切换文件','Return to the editing position from the reading copy; no file switch'],
    ['expand','chevron-right','icon','展开详情','Expand details'],
    ['collapse','chevron-down','icon','收起详情','Collapse details'],
    ['previous','chevron-left','icon','上一页','Previous page'],
    ['next','chevron-right','icon','下一页','Next page'],
    ['scroll-up','chevron-up','icon','向上','Up'],
    ['scroll-bottom','arrow-down','icon','转到底部','Go to bottom'],
    ['zoom-in','plus','icon','放大','Zoom in'],
    ['zoom-out','minus','icon','缩小','Zoom out'],
    ['reset-view','reset','icon','重置视图','Reset view','恢复当前视图的位置与大小，不改文件','Restore view position and size; do not change the file']
  ]],
  ['annotation','批注与讨论','Annotations & discussion',[
    ['select-region','scan','icon','框选','Select region','拖动选择区域；再次点击退出框选','Drag to select a region; click again to leave this mode'],
    ['draw','pencil','icon','画笔','Pen'],
    ['erase','eraser','icon','橡皮擦','Eraser'],
    ['undo','undo','icon','撤销','Undo'],
    ['redo','redo','icon','重做','Redo'],
    ['cancel-drawing','close','icon','取消涂鸦','Cancel drawing','退出涂鸦；未保存的笔迹修改按确认放弃，冻结画面与已保留草稿不删除','Leave drawing; unsaved stroke changes are discarded after confirmation; the frozen capture and kept drafts are not deleted'],
    ['note','sticky-note','label','备注','Note','添加本地备注，不发送给 AI','Add a local note; do not send to AI'],
    ['discuss','message-square','label','讨论','Discuss','打开讨论，输入后再发送','Open discussion; compose before sending'],
    ['explain','circle-help','icon','请 AI 解释','Ask AI to explain','发送当前选区给 AI，请求解释','Send the current selection to AI for explanation'],
    ['remove-material','close','icon','移除材料引用，不删除原文件','Remove reference; keep original file'],
    ['remove-tag','close','icon','移除标签','Remove tag','移除对话标签；对话历史与原文件保留','Remove the conversation tag; conversation history and the original file are kept'],
    ['send','arrow','icon','发送','Send','发送给当前会话；忙时排队','Send to this conversation; queue if busy'],
    ['finish-drawing','check','icon','完成涂鸦','Finish drawing','完成涂鸦，不自动发送','Finish drawing; do not send automatically']
  ]],
  ['work','工作与文件','Work & files',[
    ['open-project','folder-open','icon','打开项目文件夹','Open project folder','选择本机项目文件夹打开；不移动、不复制文件','Pick a local project folder to open; files are neither moved nor copied'],
    ['edit','square-pen','icon','编辑人工稿','Edit draft','编辑当前人工稿','Edit the current draft'],
    ['save','save','icon','保存','Save','保存当前人工稿，不合入项目原件','Save the edited draft; do not merge into the project'],
    ['copy','copy','icon','复制','Copy','复制当前内容，不修改原件','Copy the current content; keep the original unchanged'],
    ['accept','check','icon','采纳并结束','Accept & finish','应用当前审核稿到项目并结束工作','Apply the reviewed draft to the project and finish the work'],
    ['return-work','message-square-reply','icon','交回修改','Return for revision','候选动作：交回继续修改，不采纳、不结束','Candidate action: return for revision; do not accept or finish'],
    ['export','download','icon','导出副本','Export copy','导出当前内容的独立副本，不改原件','Export a separate copy; keep the original unchanged'],
    ['return-drafts',null,'text','交回人工稿并发送','Return drafts & send','将已保存人工稿和意见交给 AI；不合入、不结束','Send saved edited drafts and feedback to AI; do not merge or finish'],
    ['compile','file-cog','label','编译','Compile','编译 TeX 主文档，使用当前编辑缓冲','Compile the TeX main document using the current editor buffer'],
    ['reconnect','plug-zap','icon','重新连接终端','Reconnect terminal','终端已退出时，将启动新 Shell','If the terminal has exited, a new shell will start'],
    ['stop-turn','square','label','停止本回合','Stop turn','保留已完成修改及排队输入，不结束任务','Keep completed changes and queued inputs; do not end the task'],
    ['delete','trash','icon','删除备注','Delete note','仅删除选定备注；不删除原文件','Delete the selected note only; keep the source file']
  ]],
  ['app','应用入口','Application',[
    ['open-store','storefront','icon','资源商店','Resource store'],
    ['settings','settings','icon','设置','Settings'],
    ['terminal','terminal','icon','终端','Terminal'],
    ['web','globe','icon','网页','Web'],
    ['warning','triangle-alert','status','需注意','Needs attention','具体问题应直接可见，不能只藏在提示中','Show the actual issue inline, not only in a tooltip']
  ]]
];
const NO_TOOLTIP = new Set([
  'close-view','hide-conversation','expand','collapse','previous','next','scroll-up','scroll-bottom',
  'zoom-in','zoom-out','window-minimize','window-maximize','search','parent-directory','browse-back','browse-forward','reload','stop-load',
  'draw','erase','undo','redo','send','open-project','edit','save','copy','export','settings','terminal','web',
  'delete','reconnect','accept'
]); // familiar controls keep precise aria names; hints remain for ambiguous or consequential actions
const CANDIDATES = new Set(['return-work']); // candidate entries, not standalone production entries

export const actionGroups = table.map(([id,zh,en,rows]) => ({id,zh,en,actions:rows.map(([key,icon,presentation,zh,en,hintZh,hintEn]) => ({
  key, icon, presentation,
  labels: {'zh-CN': zh, en},
  hints: hintZh ? {'zh-CN': hintZh, en: hintEn || en} : {'zh-CN': zh, en},
  tooltip: !NO_TOOLTIP.has(key),
  candidate: CANDIDATES.has(key)
}))}));

export const actionList = Object.fromEntries(actionGroups.flatMap(group => group.actions).map(action => [action.key, action]));

// setActionButton(button, key, {label, text, locale}={}) -> button
//   locale: 'zh-CN' (default) | 'en' (copy reserved; no production switch yet).
//   label: overrides the accessible name AND the hover/focus tooltip, so the
//     caller can carry the concrete object and consequences (e.g. 关闭 methods.md).
//   text: visible caption; text:'' forces pure icon even for label/text actions.
// Re-rendering the same key without label preserves caller-owned aria/hint
// state. Live routing and rejection reasons use setUiHint/getUiHint rather
// than native title; pass label to rewrite both name and initial hint.
// Business handling (onclick, aria-pressed, disabled, extra classes such as
// ui-danger) stays with the caller; existing classes are never rewritten.
export function setActionButton(button, key, {label, text, locale = 'zh-CN'} = {}) {
  const action = actionList[key];
  if (!action) throw new Error('setActionButton: unknown action key "' + key + '"');
  const lang = locale === 'en' ? 'en' : 'zh-CN';
  const name = label || action.labels[lang];
  const hint = label || action.hints[lang];
  const caption = text !== undefined ? text : (action.presentation === 'icon' && action.icon ? '' : action.labels[lang]);
  const refresh = button.dataset.action !== key || label !== undefined;
  button.dataset.action = key;
  if (action.icon) {
    setIconButton(button, action.icon, refresh ? {label: name, text: caption} : {text: caption});
  } else {
    let span = button.querySelector(':scope > .ui-icon-text');
    if (!span) { span = document.createElement('span'); span.className = 'ui-icon-text'; }
    if (span.textContent !== caption) span.textContent = caption;
    button.replaceChildren(span);
    button.classList.remove('ui-icon-button');
    button.classList.add('ui-icon-label');
    if (refresh) button.setAttribute('aria-label', name);
  }
  if (action.tooltip && hint) {
    if (refresh || !button.dataset.uiHint) setUiHint(button,hint);
  } else setUiHint(button,null);
  return button;
}
