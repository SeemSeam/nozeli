import { StateEffect, StateField } from '@codemirror/state';
import { gutter, GutterMarker, ViewPlugin } from '@codemirror/view';
import { lineAuthorship, groupTitle } from '../domain/authorship-groups.mjs';

export function authorshipButton(group, onOpen) {
  let current=group;
  const button=document.createElement('button');button.type='button';
  const tracks=document.createElement('span'),label=document.createElement('span');
  tracks.className='authorship-tracks';label.className='authorship-label';button.append(tracks,label);
  button.setGroup=(next,continuation=false)=>{
    current=next;
    const actors=[...new Map(next.items.map(item=>[item.actor.id,item.actor])).values()];
    const className='authorship-mark authorship-'+actors[0].kind+(actors.length>1?' authorship-mixed':'')
      +(next.pending?' authorship-pending':'')+(next.kind==='deletion'?' authorship-deletion':'');
    if(button.className!==className)button.className=className;
    const trackKey=actors.map(actor=>actor.kind).join(',');
    if(tracks.dataset.kinds!==trackKey){tracks.replaceChildren(...actors.map(actor=>{
      const track=document.createElement('i');track.className='authorship-'+actor.kind;return track;
    }));tracks.dataset.kinds=trackKey;}
    const text=(next.kind==='deletion'?'−':actors.length>1?'混':actors[0].mark)+(continuation?'↥':'');
    if(label.textContent!==text)label.textContent=text;
    const title=groupTitle(next)+(continuation?' · 续段':'');
    if(button.title!==title){button.title=title;button.setAttribute('aria-label',title+'；查看各批修改时间和差异');}
    button.dataset.groupId=next.id;button.dataset.eventId=next.items[0].eventId;
    button.dataset.from=next.from;button.dataset.to=next.to;button.dataset.batchCount=next.items.filter(item=>!item.pending).length;
    button.dataset.continuation=String(continuation);
  };
  button.setGroup(group);
  button.addEventListener('mousedown',event=>{event.preventDefault();event.stopPropagation();});
  button.addEventListener('click',event=>{event.stopPropagation();button.focus({preventScroll:true});onOpen(current);});
  return button;
}

// Reuse nodes on scroll/resize: focus and pending click targets must survive.
export function authorshipLayer(className,onOpen) {
  const node=document.createElement('div');node.className=className;node.setAttribute('aria-label','正文修改者');
  const buttons=new Map();
  return {node,draw(fragments){
    const seen=new Set();
    for(const fragment of fragments){
      if(fragment.height<1)continue;
      const key=fragment.group.id+':'+(fragment.key??0);seen.add(key);
      let button=buttons.get(key);
      if(!button){button=authorshipButton(fragment.group,onOpen);buttons.set(key,button);node.append(button);}
      button.setGroup(fragment.group,fragment.continuation);
      button.style.top=fragment.top+'px';button.style.height=fragment.height+'px';
      if(fragment.left!=null)button.style.left=fragment.left+'px';
      if(fragment.page!=null)button.dataset.page=String(fragment.page);
    }
    for(const [key,button]of buttons)if(!seen.has(key)){button.remove();buttons.delete(key);}
  }};
}

// Actual visible logical lines -> separate visible fragments, including folds.
export function authorshipFragments(groups,lines,top=0,bottom=Infinity) {
  const fragments=[];
  for(const group of groups){
    let fragment=null,priorLine=-1;
    for(const line of lines){
      if(line.line<group.line||line.line>group.endLine||line.bottom<=top||line.top>=bottom)continue;
      if(!fragment||line.line!==priorLine+1||group.kind==='deletion'){
        fragment={group,key:line.line,top:Math.max(top,line.top),height:0,
          continuation:line.line>group.line||line.top<top};fragments.push(fragment);
      }
      fragment.height=Math.min(bottom,line.bottom,group.kind==='deletion'?fragment.top+18:Infinity)-fragment.top;priorLine=line.line;
    }
  }
  return fragments;
}

export function authorshipGutter(onOpen) {
  const set=StateEffect.define();
  const field=StateField.define({
    create:()=>({visible:false,groups:[]}),
    update(value,transaction){
      for(const effect of transaction.effects)if(effect.is(set))return {visible:effect.value.visible,
        groups:effect.value.visible?lineAuthorship(transaction.newDoc.toString(),effect.value.authorship):[]};
      return value;
    },
  });
  class Spacer extends GutterMarker {
    constructor(active){super();this.active=active;}
    eq(other){return this.active===other.active;}
    toDOM(){const node=document.createElement('span');node.className='authorship-spacer';node.hidden=!this.active;return node;}
  }
  const projection=ViewPlugin.fromClass(class {
    constructor(view){
      this.view=view;this.layer=authorshipLayer('authorship-gutter cm-authorship-layer',onOpen);view.dom.append(this.layer.node);
      this.scroll=()=>this.measure();view.scrollDOM.addEventListener('scroll',this.scroll,{passive:true});this.measure();
    }
    update(update){if(update.docChanged||update.viewportChanged||update.geometryChanged||update.transactions.some(t=>t.effects.some(e=>e.is(set))))this.measure();}
    measure(){this.view.requestMeasure({key:this,read:view=>{
      const state=view.state.field(field),lane=view.dom.querySelector('.cm-gutters .authorship-gutter');
      if(!state.visible||!lane)return {fragments:[]};
      const bounds=view.dom.getBoundingClientRect(),scroll=view.scrollDOM.getBoundingClientRect(),gutterBounds=lane.getBoundingClientRect();
      const offset=view.documentTop-scroll.top;
      const lines=view.viewportLineBlocks.map(block=>({line:view.state.doc.lineAt(block.from).number,top:block.top+offset,bottom:block.bottom+offset}));
      return {left:gutterBounds.left-bounds.left,top:scroll.top-bounds.top,height:view.scrollDOM.clientHeight,
        fragments:authorshipFragments(state.groups,lines,0,view.scrollDOM.clientHeight)};
    },write:value=>{
      if(value.height!=null){this.layer.node.style.left=value.left+'px';this.layer.node.style.top=value.top+'px';this.layer.node.style.height=value.height+'px';}
      this.layer.draw(value.fragments);
    }});}
    destroy(){this.view.scrollDOM.removeEventListener('scroll',this.scroll);this.layer.node.remove();}
  });
  const spacer=view=>new Spacer(view.state.field(field).visible&&view.state.field(field).groups.length>0);
  return {set,extension:[field,gutter({class:'authorship-gutter',initialSpacer:spacer,updateSpacer:(_previous,update)=>spacer(update.view)}),projection]};
}
