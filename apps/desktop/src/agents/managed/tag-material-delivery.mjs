import {createHash} from 'node:crypto';

const block=(title,value)=>typeof value==='string'&&value.trim()?`${title}\n${value}`:'';
const unique=values=>[...new Set(values.filter(value=>typeof value==='string'&&value.trim()))];
const region=anchor=>{
 if(!Array.isArray(anchor?.rects))return '';
 return anchor.rects.map((rect,index)=>`区域${index+1}：${rect.map(value=>typeof value==='number'?Number(value.toFixed(6)):value).join('，')}`).join('\n');
};

// Human prose is delivery content. Frozen bytes and internal identities remain
// in host metadata, never a JSON protocol the person or model must reconstruct.
export function readableTagMaterial(packet,{brief=false}={}){
 const info=packet.information,anchor=packet.origin?.anchor||{},current=packet.resolution;
 const changed=packet.currentSource?.digest!==packet.origin?.materialDigest;
 const location=info?.location?.label||packet.displayLocation?.label||(anchor.page?`第${anchor.page}页`:'位置尚未核实');
 const quote=anchor.quote||info?.location?.context?.quote||'';
 const lines=[`来源：${packet.relPath} · ${location}`];
 if(brief)return lines.concat('沿用前次已提供的选区与备注，原文件、版本和定位均未变化。').join('\n');
 lines.push(`版本：${!packet.currentSource?'当前原文件已不存在，以下引用保留发送时原版。':changed?'当前文件已变化，以下引用仍属于原版，不可套用新位置。':'原选区与当前保存版本一致。'}`,block('选中的原文：',quote));
 if(packet.note?.trim()&&packet.note!==quote)lines.push(block('一并交给你的备注：',packet.note));
 if(!brief){
  const context=info?.location?.context;
  lines.push(block('前文：',context?.before),block('后文：',context?.after));
  lines.push(block('区域位置（归一化坐标）：',region(anchor)));
  if(changed&&current?.anchor){lines.push(`当前定位：${current.locationStatus==='exact'?'已定位到当前文件':'尚需重新确认'}；${current.contentStatus==='unchanged'?'选区文字未变':'选区内容可能已变'}`);if(current.anchor.quote!==quote)lines.push(block('当前版本的对应文字：',current.anchor.quote));}
  if(info?.drawing||packet.drawing)lines.push('用户笔迹仅用于标注，不代表文档原始内容；图片附件以实际提供的截图为准。');
  if(info?.assets?.length)lines.push('随附资源：\n'+info.assets.map((asset,index)=>`${index+1}. ${asset.role||asset.kind||'选区资源'}${asset.mime?'（'+asset.mime+'）':''}${asset.captureMode?' · '+asset.captureMode:''}`).join('\n'));
 }
 if(packet.draftStatus==='changed'||packet.draftStatus==='unavailable')lines.push('当前演示文稿草稿已变化或不可读取，不能把旧截图当作当前可编辑对象。');
 const cautions=unique([...(packet.execution?.reasons||[]),...(info?.limitations||[])]);
 if(cautions.length)lines.push('需要注意：\n'+cautions.map(value=>'· '+value).join('\n'));
 lines.push('以上是供理解和核对的材料，不是自动修改授权。修改前仍须读取目标当前版本并检查冲突。');
 return lines.filter(Boolean).join('\n\n');
}

export function tagMaterialSnapshot(packets){
 const full=packets.map(packet=>readableTagMaterial(packet)).join('\n\n---\n\n');
 const brief=packets.map(packet=>readableTagMaterial(packet,{brief:true})).join('\n\n---\n\n');
 const version=createHash('sha256').update(full).digest('hex');
 const reusable=packets.every(p=>p.currentSource?.digest===p.origin?.materialDigest&&p.resolution?.locationStatus==='exact'&&p.resolution?.contentStatus==='unchanged'&&!['changed','unavailable'].includes(p.draftStatus));
 // Include host identities in the cache key: equal quotes in different tags
 // must never silently become the same discussion or source binding.
 const binding=createHash('sha256').update(JSON.stringify(packets.map(p=>[p.tagId,p.fileId,p.origin?.materialDigest,p.resolution,p.currentSource,p.currentDraft,p.draftStatus]))).digest('hex');
 return {full,brief,version,binding,reusable};
}

export class TagMaterialDelivery {
 constructor(){this.sessions=new WeakMap();this.generations=new WeakMap();}
 invalidate(session){if(session){this.sessions.delete(session);this.generations.set(session,(this.generations.get(session)||0)+1);}}
 prepare(session,job){
  const epoch=this.generations.get(session)||0;
  const material=job.context?.tagMaterial;
  if(job.target!=='frontdesk'||!material||material.reusable!==true||typeof material.version!=='string'||typeof material.brief!=='string'||!job.context?.userInput)return {text:job.text,commit(){},mode:'full'};
  const key=material.binding+':'+material.version;
  const state=this.sessions.get(session),same=state?.threadId===session.threadId&&state?.generation===(session.contextGeneration??0)&&state?.bindings.has(key);
  const ref=`frontdesk-source:${material.version}`;
  const text=same
   ? `${job.context.userInput.text}\n\n继续这处材料的讨论（来源未变化）：\n${material.brief}\n\n完整背景保留在只读材料原件中。如之前的上下文已压缩、遗漏或不足以判断，请先调用 nozeli_handoff，reason 填写“@read ${ref}”；有后续页时继续读取，不凭“见上文”猜测。`
   : job.text;
  return {text,mode:same?'selection-followup':'full',commit:()=>{
   if((this.generations.get(session)||0)!==epoch)return;
   const current=this.sessions.get(session);
   const next=current?.threadId===session.threadId&&current?.generation===(session.contextGeneration??0)?current:{threadId:session.threadId,generation:session.contextGeneration??0,bindings:new Set()};
   next.bindings.add(key);this.sessions.set(session,next);
  }};
 }
}
