import {createFileIcon} from './file-icons.mjs';

export function appendReviewFileIdentity(entry,relPath,description){
 entry.title=relPath+' · '+description;entry.setAttribute('aria-label',entry.title);
 const path=relPath.replaceAll('\\','/'),split=path.lastIndexOf('/');
 const name=document.createElement('strong');name.textContent=path.slice(split+1);
 const directory=document.createElement('span');directory.className='managed-review-directory';directory.textContent=split<0?'':path.slice(0,split);
 const names=document.createElement('span');names.className='managed-review-file-path';names.append(name,directory);entry.append(createFileIcon(relPath),names);
}

// Keyed rows keep keyboard focus across host observations.
export function mountReviewFiles(parent,{openFile,onError}){
 const rows=new Map();
 function create(file){
  const root=document.createElement('section');root.className='managed-review-file';root.dataset.reviewFileRow=file.relPath;
  const header=document.createElement('div');header.className='managed-review-file-header';
  const entry=document.createElement('button');entry.type='button';entry.dataset.reviewAction='file';entry.dataset.reviewFile=file.relPath;entry.className='managed-review-file-name';
  appendReviewFileIdentity(entry,file.relPath,'在文档工作区查看审核版本与差异');
  const meta=document.createElement('span');meta.className='managed-review-file-meta';meta.dataset.reviewFileStatus='';
  const counts=document.createElement('span');counts.className='managed-review-file-counts';counts.dataset.reviewCounts='';counts.title='输入基线 → Worker 冻结候选；不含人工稿';
  header.append(entry,meta,counts);root.append(header);
  const row={root,entry,meta,counts,file};
  entry.onclick=()=>Promise.resolve(openFile(row.file)).catch(onError);
  return row;
 }
 return {
  update(files){
   const keep=new Set(files.map(file=>file.relPath));
   for(const [path,row]of rows)if(!keep.has(path)){if(row.root.contains(document.activeElement))parent.focus({preventScroll:true});row.root.remove();rows.delete(path);}
   let previous=null;
   for(const file of files){
    let row=rows.get(file.relPath);if(!row){row=create(file);rows.set(file.relPath,row);}row.file=file;
    const expected=previous?previous.nextElementSibling:parent.firstElementChild;
    if(expected!==row.root)parent.insertBefore(row.root,expected);previous=row.root;
    row.meta.textContent=({added:'新增',removed:'删除',deleted:'删除',modified:'修改',unchanged:'引用',renamed:'重命名',copied:'复制','type-changed':'类型变化',unknown:'未知'}[file.status||file.change]||'未知');
    row.meta.title=(file.oldPath?'原路径：'+file.oldPath+' · ':'')+(file.draft?'有已保存人工稿；计数不含人工稿':'Worker 冻结候选');
    row.meta.dataset.humanDraft=String(Boolean(file.draft));
    row.counts.replaceChildren();
    const change=file.status||file.change,binary=file.binary===true||file.unsupportedReason==='binary'||file.candidateOmitted==='binary'||file.baselineOmitted==='binary';
    row.counts.removeAttribute('aria-label');
    if(binary){row.counts.textContent='二进制';row.counts.setAttribute('aria-label','二进制材料，不显示文本增删行数');}
    else if(change==='unchanged'){row.counts.textContent='未修改';}
    else if(change==='unknown'||!change){row.counts.textContent='—';row.counts.setAttribute('aria-label','变更状态未知，增删行数不可用');}
    else if(Number.isInteger(file.added)&&file.added>=0&&Number.isInteger(file.deleted)&&file.deleted>=0){
     const added=document.createElement('span'),separator=document.createElement('span'),deleted=document.createElement('span');added.className='review-added';separator.className='review-count-separator';deleted.className='review-deleted';added.textContent='+'+file.added;separator.textContent=' / ';deleted.textContent='−'+file.deleted;row.counts.append(added,separator,deleted);
    }else{row.counts.textContent='—';row.counts.setAttribute('aria-label','增删行数不可用');}
   }
  },
  destroy(){rows.clear();}
 };
}
