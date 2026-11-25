import './local-resource-store.css';
import {mountStoreImports} from './store-imports.mjs';

import {setActionButton} from './ui-actions.mjs';
import {setIconButton,uiIcon} from './ui-icons.mjs';

const pages={discover:'资源发现',library:'已安装',create:'自开发'};
const categories={engine:'驱动',skill:'技能',template:'角色模板'};
const pageIcons={discover:'search',library:'check',create:'square-pen'};
const categoryIcons={engine:'plug-zap',skill:'book-open',template:'copy'};

export function mountLocalResourceStore(launcher,{invoke,getProjectId=()=>null,openAnalysis}) {
  const app = launcher.closest('.app');
  const rail = launcher.closest('.rail');
  const actions = launcher.parentElement;
  const store = document.createElement('section');
  store.id = 'local-resource-store';
  store.hidden = true;
  store.setAttribute('aria-label', '资源商店');
  store.innerHTML = `<header class="store-header">
      <span class="store-brand">资源商店</span>
      <button type="button" class="store-close"></button>
    </header><aside class="store-sidebar">
      <nav class="store-nav" aria-label="资源商店导航">
        <button type="button" data-page="discover">发现</button>
        <button type="button" data-page="library">已安装</button>
        <div class="store-create"><button type="button" data-page="create">自开发</button></div>
      </nav>
    </aside><main class="store-view" tabindex="-1" aria-label="商店内容">
      <div class="store-content">
        <h1></h1>
        <div class="store-catalog">
          <div class="store-categories" role="group" aria-label="资源分区">
            ${Object.entries(categories).map(([id,label])=>`<button type="button" data-category="${id}" aria-pressed="false">${label}</button>`).join('')}
          </div>
          <label class="store-search"><input type="search" aria-label="搜索技能" placeholder="搜索技能或角色" autocomplete="off"></label>
        </div>
        <section class="store-import-panel" aria-label="导入技能" hidden></section>
        <div class="store-results"></div>
      </div>
    </main>`;
  app.append(store);
  const view = store.querySelector('.store-view');
  const search=store.querySelector('input[type=search]'),results=store.querySelector('.store-results');
  const imports=mountStoreImports(store.querySelector('.store-import-panel'),{invoke,getProjectId,search,openAnalysis});
  const heading=view.querySelector('h1'),catalog=view.querySelector('.store-catalog');
  store.querySelector('.store-brand').append(uiIcon('storefront'));
  const close=store.querySelector('.store-close');
  setActionButton(close,'close-view',{label:'关闭资源商店'});
  for(const control of store.querySelectorAll('[data-page],[data-category]')){
    const {page,category}=control.dataset,text=control.textContent;
    const label=category==='engine'?'引擎 / 驱动':text;
    setIconButton(control,pageIcons[page]??categoryIcons[category],{label,text});
  }
  search.before(uiIcon('search'));
  let page = 'discover', category = 'skill', blocked = [];
  let rows=null, busy=false, error='', generation=0;
  const selectedRoles=new Map();
  async function call(op,p){const result=await invoke('store.'+op,p);if(!result.ok)throw Error(result.error.message);return result.value;}
  async function refresh(action='list',params={}){
    const ticket=++generation;
    busy=true;error='';render();
    try{const result=await call('skills.'+action,params);if(ticket===generation)rows=result;}
    catch(failure){if(ticket===generation)error=failure.message;}
    finally{if(ticket===generation){busy=false;render();if(document.activeElement===document.body)view.focus({preventScroll:true});}}
  }
  function renderSkills(content){
    content.replaceChildren();
    const setStatus=(text,kind='')=>{
      const status=document.createElement('p');status.className='store-status';status.textContent=text;
      if(kind)status.setAttribute('role',kind);content.append(status);
    };
    if(page==='create'){setStatus('自开发尚未开放');return;}
    if(category!=='skill'){
      const name=category==='engine'?'引擎或驱动':'角色模板';
      setStatus(page==='library'?`暂无已安装的${name}`:`暂无可安装的${name}`,'status');return;
    }
    if(busy||error)setStatus(error||'正在更新…',error?'alert':'status');
    if(error){const retry=document.createElement('button');retry.type='button';retry.dataset.action='refresh';retry.textContent='重试';content.append(retry);}
    if(!rows||error)return;
    const query=search.value.trim().toLowerCase(),installedOnly=page!=='discover';
    const matches=rows.map(skill=>({skill,options:skill.roles.filter(role=>!installedOnly||role.installed)})).filter(({skill,options})=>options.length&&(!query||[skill.name,skill.description,skill.id,...options.flatMap(role=>[role.name,role.id])].some(text=>text.toLowerCase().includes(query))));
    if(!matches.length){setStatus(query?'没有匹配的技能':installedOnly?'还没有已安装的技能':'暂无可安装的技能','status');return;}
    for(const {skill,options} of matches){
      const card=document.createElement('article');card.className='store-card';
      const icon=document.createElement('span');icon.className='store-skill-icon';icon.append(uiIcon('book-open'));
      const copy=document.createElement('div');copy.className='store-copy';
      const title=document.createElement('h2');title.textContent=skill.name;
      const description=document.createElement('p');description.textContent=skill.description;
      const meta=document.createElement('div');meta.className='store-meta';
      copy.append(title,description,meta);
      const controls=document.createElement('div');controls.className='store-skill-controls';card.append(icon,copy,controls);
      const status=document.createElement('span');
      function selectRole(role){
        controls.replaceChildren();
        status.textContent=role.installed?'已安装':'未安装';
        function button(action,text,primary=false){
          const btn=document.createElement('button');btn.type='button';btn.textContent=text;btn.dataset.action=action;btn.dataset.skill=skill.id;btn.dataset.role=role.id;btn.disabled=busy;
          const icon={install:'download',uninstall:'trash'}[action];
          setIconButton(btn,icon,{label:`${text}：${skill.name}`,text});
          if(primary)btn.classList.add('store-primary');controls.append(btn);
        }
        if(!role.installed)button('install','安装',true);
        if(page==='library'&&role.installed)button('uninstall','卸载');
      }
      const role=options.find(option=>option.id===selectedRoles.get(skill.id))??options[0];
      if(options.length===1){
        const badge=document.createElement('span');badge.className='store-role';badge.textContent=role.name;meta.append(badge);
      }else{
        const select=document.createElement('select');select.setAttribute('aria-label',skill.name+'的目标角色');select.disabled=busy;
        for(const {id,name} of options)select.add(new Option(name,id));
        select.value=role.id;
        select.addEventListener('change',()=>{selectedRoles.set(skill.id,select.value);selectRole(options.find(option=>option.id===select.value));});meta.append(select);
      }
      meta.append(status);selectRole(role);content.append(card);
    }
  }

  function render() {
    heading.textContent=pages[page];
    catalog.hidden=page==='create';
    search.parentElement.hidden=category!=='skill';
    for(const tab of catalog.querySelectorAll('[data-category]'))tab.setAttribute('aria-pressed',String(tab.dataset.category===category));
    for (const tab of store.querySelectorAll('[data-page]')) {
      if (tab.dataset.page === page) tab.setAttribute('aria-current','page');
      else tab.removeAttribute('aria-current');
    }
    renderSkills(results);
    imports.setMode(!store.hidden&&category==='skill'&&page!=='create'?page:'');
  }

  function toggle(open) {
    store.hidden = !open;
    launcher.setAttribute('aria-expanded',String(open));
    if (open) {
      // Leave the underlying workspace mounted, with its dimensions and editing state intact.
      const children=[...app.children].flatMap(node=>node.classList.contains('local-window-layer')?[...node.children]:[node]);
      blocked = [...children,...rail.children,...actions.children]
        .filter(node => ![store,rail,actions,launcher].includes(node) && node.id!=='admin-agent' && !node.inert);
      for (const node of blocked) node.inert = true;
      close.focus({preventScroll:true});
      void refresh();
    } else {
      ++generation;rows=null;busy=false;error='';
      imports.setMode('');
      search.value='';
      for (const node of blocked) node.inert = false;
      blocked = [];
      launcher.focus({preventScroll:true});
    }
  }

  window.addEventListener('nozeli-project-change',()=>{if(!store.hidden)toggle(false);});
  setActionButton(launcher,'open-store');
  launcher.addEventListener('click',() => toggle(store.hidden));
  search.addEventListener('input',()=>renderSkills(results));
  store.addEventListener('click',event => {
    const control = event.target.closest('button');
    if (!control) return;
    const {page:destination,category:section,action} = control.dataset;
    if (action === 'close-view') return toggle(false);
    if (action === 'refresh') return void refresh();
    if (['install','uninstall'].includes(action))return void refresh(action,{skillId:control.dataset.skill,role:control.dataset.role});
    if(section){category=section;search.value='';render();return;}
    if (destination) {
      page = destination;
      render();
      view.scrollTop = 0;
    }
  });
  window.addEventListener('keydown',event => {
    if(store.hidden||event.key!=='Escape'||event.defaultPrevented||event.repeat||event.isComposing||event.keyCode===229)return;
    // Native modal dialogs and open selects keep their own Escape handling.
    if(document.querySelector('dialog:modal')||document.activeElement?.matches('select:open'))return;
    if(document.activeElement?.closest('#admin-agent:not([hidden])'))return;
    event.preventDefault();
    event.stopImmediatePropagation();
    toggle(false);
  },true);
  render();
  launcher.hidden = false;
}
