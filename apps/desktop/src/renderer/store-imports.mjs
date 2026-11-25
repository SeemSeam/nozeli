const roles={frontdesk:'前台',orchestrator:'主控',worker:'Worker'};
const compatibility={compatible:'兼容',adaptation:'需要适配','analysis-only':'仅可分析',blocked:'已阻止'};
const sourcesStatus={installed:'已安装', 'skills-only':'仅发现技能目录',unverified:'未验证'};
function el(tag,text){const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;}
function button(parent,key,text,action){const b=el('button',text);b.type='button';b.dataset.importAction=key;b.onclick=action;parent.append(b);return b;}
function check(parent,key,value,text,checked,change){const label=el('label'),input=el('input');input.type='checkbox';input.dataset[key]=value;input.checked=checked;input.onchange=()=>change(input.checked);label.append(input,' '+text);parent.append(label);return input;}
function group(parent,title){const field=el('fieldset');field.append(el('legend',title));parent.append(field);return field;}

export function mountStoreImports(host,{invoke,getProjectId,search,openAnalysis}){
  let mode='',projectId=null,ticket=0,busy='',error='',notice='';
  let sources=null,scan=null,proposal=null,library=null,enable=false,reviewed=null,capacityConfig;
  const sourceIds=new Set(),analysisIds=new Set(),grants=new Map();
  function reset(){++ticket;busy=false;error=notice='';sources=scan=proposal=library=reviewed=null;capacityConfig=undefined;enable=false;sourceIds.clear();analysisIds.clear();grants.clear();}
  async function run(action,params,apply){
    if(busy)return;
    if((getProjectId()||null)!==projectId){setMode(mode);return;}
    const request=++ticket;busy=action;error=notice='';render();
    let finishAnalysis;
    try{
      if(action==='analyze'||action==='prepareMigration'){
        finishAnalysis=await openAnalysis?.();
        if(request!==ticket){finishAnalysis?.('来源选择已离开，未提交分析。');return;}
      }
      const result=await invoke('store.imports.'+action,{...(projectId?{projectId}:{}),...params});
      if(request!==ticket){finishAnalysis?.('分析已结束；原导入页面已离开。');return;}
      if(!result.ok)throw Error(result.error.message);
      apply(result.value);
      finishAnalysis?.(action==='prepareMigration'?'迁移开发交接已准备。请在管理助手核对目标项目后确认；尚未派工。':'分析完成。返回资源商店选择技能和开放角色；尚未安装。');
    }catch(failure){finishAnalysis?.(failure.message);if(request===ticket)error=failure.message;}
    finally{if(request===ticket){busy=false;if((getProjectId()||null)!==projectId)setMode(mode);else render();}}
  }
  const loadLibrary=()=>run('list',{},value=>{library=value;});
  function setMode(next){
    const id=getProjectId()||null;
    if(next===mode&&id===projectId)return;
    reset();mode=next;projectId=id;render();if(mode==='library')void loadLibrary();
  }
  function render(){
    host.replaceChildren();host.hidden=!mode;if(!mode)return;
    const body=el('fieldset');body.className='store-imports';body.disabled=busy;host.append(body);
    body.append(el('legend',mode==='library'?'已导入的本地技能':'从本机导入技能'));
    const message=el('p',error||(busy==='analyze'?'管理助手正在分析，进度见对话窗口。':busy?'正在处理…':notice));message.setAttribute('role',error?'alert':'status');host.append(message);
    if(mode==='library'){
      if(!library){if(!busy)button(body,'list','读取已安装技能',loadLibrary);return;}
      if(!library.length)body.append(el('p','尚未导入本地技能。'));
      const query=search.value.trim().toLowerCase();
      const matches=library.filter(row=>!query||[row.name,row.description,row.id,row.sourceId,row.version,...row.roles.flatMap(role=>[role.name,role.id])].some(value=>String(value).toLowerCase().includes(query)));
      if(library.length&&!matches.length)body.append(el('p','没有匹配的已导入技能。'));
      for(const row of matches){
        const card=group(body,`${row.name} · ${row.version}`);card.append(el('p',`${row.sourceId} · ${row.description}`));
        for(const role of row.roles){
          const line=el('div');line.className='store-meta';card.append(line);
          line.append(el('span',`${role.name} · ${!projectId?'已授权':role.enabled?'本项目已启用':'本项目未启用'}`));
          if(projectId){const action=role.enabled?'disable':'enable';const control=button(line,action,role.enabled?'在本项目停用':'在本项目启用',()=>run(action,{id:row.id,version:row.version,role:role.id},value=>{library=value;notice='项目角色设置已更新。';}));control.dataset.skill=row.id;control.dataset.version=row.version;control.dataset.role=role.id;}
        }
      }
      return;
    }
    if(projectId&&!proposal){
      const migration=group(body,'ParaCloud 作业管理迁移');
      migration.append(el('p','请先切换到明确选定的开发项目，准备开发交接；只有已接受并合入的成果可预览安装。'));
      button(migration,'prepareMigration','为当前项目准备迁移开发',()=>run('prepareMigration',{},()=>{notice='已准备开发交接，等待管理助手中的独立确认。';}));
      button(migration,'reviewedList','查找当前项目已审成果',()=>run('reviewedList',{},value=>{reviewed=value;}));
      if(reviewed&&!reviewed.length)migration.append(el('p','没有已接受并合入的 ParaCloud 技能成果。'));
      for(const {workId,objectId,relPath,name} of reviewed??[]){
        const open=button(migration,'reviewed',`预览已审技能：${name||'ParaCloud 容量'}`,()=>run('reviewed',{workId,objectId,relPath},value=>{proposal=value;grants.clear();enable=false;}));open.dataset.workId=workId;
      }
      button(migration,'capacityConfig','配置当前项目 ParaCloud 连接',()=>run('capacityConfig',{},value=>{capacityConfig=value;}));
      if(capacityConfig!==undefined){
        const fields=group(migration,'现有 OpenSSH 别名与 Slurm 分区');
        const input=(label,value,key)=>{const wrap=el('label',label+' '),node=el('input');node.value=value??'';node.maxLength=64;node.autocomplete='off';node.dataset[key]='';wrap.append(node);fields.append(wrap);return node;};
        const alias=input('SSH 别名',capacityConfig?.sshAlias,'capacityAlias'),partition=input('分区',capacityConfig?.partition,'capacityPartition');
        fields.append(el('p','保存不连接。仅在项目中选择审核安装的 ParaCloud 作业管理技能并发送后，才能使用此连接。不填写密码或密钥。'));
        const allow=check(fields,'capacityAllowWrites','yes','授权该项目通过此连接上传、提交和取消作业',capacityConfig?.allowJobWrites===true,()=>{});
        const save=config=>run('saveCapacityConfig',{config},value=>{capacityConfig=value;notice=value?'已保存 ParaCloud 连接和作业授权。':'已移除 ParaCloud 连接。';});
        button(fields,'saveCapacityConfig','保存连接',()=>save({sshAlias:alias.value.trim(),partition:partition.value.trim(),allowJobWrites:allow.checked}));
        if(capacityConfig)button(fields,'removeCapacityConfig','移除连接',()=>save(null));
      }
    }
    if(!sources&&!proposal){button(body,'sources','发现本地技能来源',()=>run('sources',{},value=>{sources=value;}));return;}
    if(sources){
    const sourceBox=group(body,'1. 选择要扫描的来源');
    if(!sources.length)sourceBox.append(el('p','没有发现本地技能来源。'));
    for(const source of sources)check(sourceBox,'importSource',source.id,`${source.name} · ${sourcesStatus[source.status]||source.status}`,sourceIds.has(source.id),on=>{
      if(on)sourceIds.add(source.id);else sourceIds.delete(source.id);
      scan=proposal=null;analysisIds.clear();grants.clear();enable=false;error=notice='';render();host.querySelectorAll('[data-import-source]')[sources.indexOf(source)]?.focus();
    });
    button(sourceBox,'scan','扫描所选来源',()=>run('scan',{sourceIds:[...sourceIds]},value=>{scan=value;proposal=null;analysisIds.clear();grants.clear();enable=false;})).disabled=!sourceIds.size;
    }
    if(!scan&&!proposal)return;
    if(!proposal){
      const preview=group(body,'2. 选择要分析的技能');
      const hint=el('p','默认不选。只发送勾选技能的 SKILL.md 正文；配套资源只统计数量和类型，不发送内容。');
      preview.append(hint);
      const selection=el('p');selection.setAttribute('role','status');
      for(const row of scan.candidates){
        const line=el('div');preview.append(line);
        const label=`${row.name} · ${row.sourceId} · ${compatibility[row.compatibility]||row.compatibility}${row.bytes?` · ${row.bytes} 字节`:''}${row.reason?' · '+row.reason:''}`;
        const input=check(line,'importAnalysisCandidate',row.id,label,analysisIds.has(row.id),on=>{if(on)analysisIds.add(row.id);else analysisIds.delete(row.id);sync();});
        input.disabled=row.compatibility==='blocked';
        if(row.resources?.length)line.append(el('p',`配套资源 ${row.resources.reduce((n,r)=>n+r.count,0)} 项（未读取内容）`));
      }
      preview.append(selection);
      const send=button(preview,'analyze','发送所选技能给模型分析',()=>run('analyze',{scanId:scan.scanId,candidateIds:[...analysisIds]},value=>{proposal=value;}));
      function sync(){send.disabled=!analysisIds.size;selection.textContent=scan.candidates.length?`已选 ${analysisIds.size} 项`:'所选来源中没有发现技能。';}
      sync();return;
    }
    const choices=group(body,'3. 选择技能，并逐项授权角色');
    button(choices,'reselect','重新选择要分析的技能',()=>{proposal=null;grants.clear();enable=false;error=notice='';render();host.querySelector('[data-import-analysis-candidate]:not(:disabled)')?.focus();});
    choices.append(el('p',`宿主验证通过 ${proposal.candidates.filter(row=>row.skillId&&row.compatibility==='compatible').length} 项；其余 ${proposal.candidates.filter(row=>!row.skillId||row.compatibility!=='compatible').length} 项尚不可安装。`));
    choices.append(el('p','Pi 适配范围：原角色会话中的文本指导、阅读与摘要；配套程序与扩展尚未验证，不会自动安装或执行。'));
    const update=()=>{install.disabled=!grants.size||[...grants.values()].some(set=>!set.size);};
    for(const row of proposal.candidates){
      const card=group(choices,row.name);card.append(el('p',[row.sourceId,row.description,compatibility[row.compatibility]||row.compatibility,row.reason,typeof row.analysis==='string'?row.analysis:'',row.version].filter(Boolean).join(' · ')));
      if(row.resources?.length)card.append(el('p','配套资源（仅结构检查，未读取）：'+row.resources.map(({kind,count})=>`${({file:'文件',directory:'目录',link:'链接',special:'特殊条目'})[kind]||kind} ${count} 项`).join('、')));
      if(!row.skillId||!row.version||!row.digest||row.compatibility==='blocked')continue;
      if(typeof row.preview==='string'){const detail=el('details');detail.append(el('summary','查看将安装的完整文本'),el('pre',row.preview));card.append(detail);}
      const roleBox=el('div');roleBox.className='store-meta';
      check(card,'importCandidate',row.id,'安装此技能',grants.has(row.id),on=>{
        if(on)grants.set(row.id,new Set());else grants.delete(row.id);
        for(const input of roleBox.querySelectorAll('input'))input.checked=false;
        roleBox.hidden=!on;update();
      });
      for(const [id,name] of Object.entries(roles))check(roleBox,'importRole',id,name,grants.get(row.id)?.has(id)===true,on=>{const set=grants.get(row.id);if(on)set.add(id);else set.delete(id);update();});
      roleBox.hidden=!grants.has(row.id);card.append(roleBox);
    }
    if(projectId)check(body,'importEnable','', '同时为当前项目启用所授权的角色',enable,on=>{enable=on;});
    const install=button(body,'install','安装所选技能',()=>run('install',{proposalId:proposal.proposalId,grants:[...grants].map(([candidateId,set])=>({candidateId,roles:[...set]})),enable},()=>{sources=scan=proposal=null;grants.clear();sourceIds.clear();analysisIds.clear();enable=false;notice='安装完成，可在「已安装」管理项目启用状态。';}));
    update();
  }
  search.addEventListener('input',()=>{if(mode==='library')render();});
  return {setMode};
}
