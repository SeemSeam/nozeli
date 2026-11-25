export function mountFrontdeskSkills({composer, form, available, onQuery}) {
  const menu=document.createElement('div');
  menu.id='frontdesk-skill-list';menu.hidden=true;
  menu.setAttribute('role','group');menu.setAttribute('aria-label','前台技能');
  composer.before(menu);
  composer.setAttribute('aria-controls',menu.id);
  composer.setAttribute('title',composer.title+'；输入 / 查看前台技能');
  let rows=[],index=0,composing=false,displayKey;
  const hide=()=>{menu.hidden=true;rows=[];displayKey=undefined;};
  function query(){
    const line=composer.value.split('\n',1)[0];
    if(composer.selectionEnd>line.length)return null;
    return /^\/(?:skills?|skill:[a-z0-9-]*)?$/i.test(line)?line:null;
  }
  function highlight(){
    rows.forEach(({button},i)=>button.classList.toggle('current',i===index));
    rows[index]?.button.scrollIntoView({block:'nearest'});
  }
  function choose(skill){
    const line=query();
    if(line===null||!available()?.includes(skill))return hide();
    if(skill.open){
      composer.setRangeText('',0,line.length+(composer.value.length>line.length?1:0),'start');
      composer.focus({preventScroll:true});
      composer.dispatchEvent(new Event('input',{bubbles:true}));
      hide();skill.open(composer);return;
    }
    composer.setRangeText(skill.command+' ',0,line.length,'end');
    composer.focus({preventScroll:true});
    composer.dispatchEvent(new Event('input',{bubbles:true}));
    hide();
  }
  function update(){
    const line=query(), skills=available();
    if(composer.disabled||composer.readOnly||composing||line===null||!skills)return hide();
    const filter=line.includes(':')?line.slice(7).toLowerCase():'';
    const list=skills.filter(skill=>skill.alias.startsWith(filter)||skill.name.startsWith(filter));
    const key=JSON.stringify([line,list.map(skill=>skill.name)]);
    if(key===displayKey)return;
    displayKey=key;
    menu.replaceChildren();index=0;
    rows=list.map(skill=>{
      const button=document.createElement('button');button.type='button';
      const label=document.createElement('strong');label.textContent=skill.label;
      const key=document.createElement('code');key.textContent=skill.command;
      const description=document.createElement('small');description.textContent=skill.description;
      button.append(label,key,description);
      button.onclick=()=>choose(skill);
      menu.append(button);return {button,skill};
    });
    if(!rows.length)menu.textContent='没有匹配的前台技能';
    menu.hidden=false;highlight();
  }
  const querySkills=()=>{update();if(query()!==null)onQuery?.();};
  composer.addEventListener('input',()=>{if(document.activeElement===composer)querySkills();else hide();});
  composer.addEventListener('focus',querySkills);
  composer.addEventListener('compositionstart',()=>{composing=true;hide();});
  composer.addEventListener('compositionend',()=>{composing=false;querySkills();});
  form.addEventListener('focusout',event=>{if(event.relatedTarget!==composer&&!menu.contains(event.relatedTarget))hide();});
  composer.addEventListener('keydown',event=>{
    if(menu.hidden||composing||event.isComposing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;
    if(event.key==='Escape'){event.preventDefault();hide();return;}
    if(!rows.length)return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();index=(index+(event.key==='ArrowDown'?1:rows.length-1))%rows.length;highlight();
    }else if(event.key==='Enter'&&query()!==null){event.preventDefault();if(!event.repeat)choose(rows[index].skill);}
  });
  form.addEventListener('submit',event=>{
    if(!available())return;
    if(/^\/skill:work-handoff$/i.test(query()??'')){
      event.preventDefault();event.stopImmediatePropagation();
      const skill=available().find(row=>row.alias==='work-handoff'&&row.open);
      if(skill)choose(skill);else {update();onQuery?.();}
      return;
    }
    if(/^\/(?:skills?)?$/i.test(composer.value.trim())){
      event.preventDefault();event.stopImmediatePropagation();composer.focus();update();
    }
  },true);
  return {hide,refresh(){if(!menu.hidden)update();}};
}
