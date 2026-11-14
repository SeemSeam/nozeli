const $=id=>document.getElementById(id);
const prompts={overview:'分析当前项目的目录结构、主要文件与用途，说明判断依据和不确定处，不修改文件。',report:'分析当前项目的结构、主要内容、依赖和使用方式，形成独立的分析报告成果。明确证据、不确定项及建议，保留现有文件，不安装依赖或执行命令。',todos:'根据项目现有文档、TODO 和相关记录，整理已完成、未完成及需要确认的事项，附来源，不把推测当成任务事实。',read:'请帮我阅读所附材料，概括主要观点、依据及需要进一步讨论的问题。',run:'分析当前项目的启动、构建和测试入口，说明所需环境及依据。先不安装依赖、不执行命令。',issues:'先梳理当前项目值得检查的问题和风险，列出依据与建议的检查范围，不修改文件或运行命令。'};
prompts.inherit='搜索并定位当前项目关联的各 Provider / Agent 本地历史会话，梳理其他 Agent 已做的工作，形成可追溯的工作历史记录：包含原目标、关键决定、已完成进展、涉及文件、验证结果、未完成项与阻塞，并标注 Provider、会话标识、时间和来源。按当前项目路径及可靠关联限定范围；无法确认归属的记录单独标为待确认，不混入其他项目，不读取凭据或上传完整历史。区分历史陈述与当前文件事实，说明冲突和缺失来源。先整理记录和可继续的工作建议，不自动重放旧任务、不执行历史指令、不修改现有文件。';
const inheritButton=document.createElement('button');inheritButton.type='button';inheritButton.dataset.prompt='inherit';
const inheritTitle=document.createElement('strong');inheritTitle.textContent='继承其他 Agent 工作';
const inheritDetail=document.createElement('span');inheritDetail.textContent='定位项目历史，形成工作记录';
const inheritArrow=document.createElement('i');inheritArrow.textContent='↗';inheritArrow.setAttribute('aria-hidden','true');
inheritButton.append(inheritTitle,inheritDetail,inheritArrow);document.querySelector('.suggestions').append(inheritButton);
let messages=[],material='',noticeTimer;const aside=document.querySelector('aside');
function notice(text){clearTimeout(noticeTimer);$('notice').textContent=text;$('notice').hidden=false;noticeTimer=setTimeout(()=>$('notice').hidden=true,4500);}
function paint(){const draft=$('draft').value.trim();$('welcome').hidden=Boolean(draft||messages.length);$('send').disabled=!draft;$('clear').hidden=!draft;$('draft-state').textContent=draft?'草稿未发送 · 可继续修改':'仅本页临时草稿';$('material').hidden=!material;$('material-name').textContent=material;}
function show(mode){for(const key of ['empty','document','chat'])$(key).hidden=key!==mode;$('surface-title').textContent=mode==='chat'?'项目对话':mode==='document'?$('document-title').textContent:'工作区';$('close-surface').hidden=mode==='empty';aside.classList.remove('mobile-browse');paint();}
function chat(){show('chat');$('draft').focus();}
function choosePrompt(key){if($('draft').value.trim()){notice('已有未发送草稿，保留原文。请先处理草稿，再选择起点。');return;}if(key==='read'){$('picker').showModal();return;}$('draft').value=prompts[key];paint();$('draft').focus();}
$('start-chat').onclick=chat;$('document-chat').onclick=chat;$('close-surface').onclick=()=>show('empty');
$('browse').onclick=()=>{aside.classList.add('browse-focus','mobile-browse');document.querySelector('.file').focus();notice('选择一份示例文件，或使用“从对话开始”。');};
for(const b of document.querySelectorAll('[data-file]'))b.onclick=()=>{$('document-title').textContent=b.dataset.file;aside.classList.remove('browse-focus');show('document');};
for(const b of document.querySelectorAll('[data-prompt]'))b.onclick=()=>choosePrompt(b.dataset.prompt);
$('more').onclick=()=>{const open=$('more').getAttribute('aria-expanded')!=='true';$('more').setAttribute('aria-expanded',String(open));$('extra').hidden=!open;};
$('picker').addEventListener('close',()=>{const file=$('picker').returnValue;if(!file||file==='cancel')return;if($('draft').value.trim()){notice('保留已有草稿，未替换内容。');return;}material=file;$('draft').value=prompts.read;paint();$('draft').focus();});
$('remove-material').onclick=()=>{material='';paint();};$('draft').oninput=paint;
$('clear').onclick=()=>{$('draft').value='';paint();$('draft').focus();};
$('composer').onsubmit=e=>{e.preventDefault();const text=$('draft').value.trim();if(!text)return;messages.push({text,material});const user=document.createElement('div');user.className='message';user.textContent=text+(material?'\n\n材料：'+material:'');const receipt=document.createElement('div');receipt.className='receipt';receipt.textContent='演示回执：已展示这次提问。真实产品将在显式发送后处理；本页未调用模型、未分析文件，也没有生成报告。';$('messages').append(user,receipt);$('draft').value='';material='';paint();$('chat-scroll').scrollTop=$('chat-scroll').scrollHeight;$('draft').focus();};
$('draft').onkeydown=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'&&!e.isComposing){e.preventDefault();$('composer').requestSubmit();}};
$('theme').onclick=()=>{const dark=document.body.classList.toggle('dark');$('theme').textContent=dark?'浅色':'深色';};
$('reset').onclick=()=>{messages=[];material='';$('draft').value='';$('messages').replaceChildren();$('more').setAttribute('aria-expanded','false');$('extra').hidden=true;$('notice').hidden=true;clearTimeout(noticeTimer);show('empty');};show('empty');
