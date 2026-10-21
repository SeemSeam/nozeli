import {useLayoutEffect,useRef} from 'react';
// Markdown node replacement waits for selection / IME to finish.
export function createReadingScheduler(root){
 const doc=root.ownerDocument;let composing=false,pending=null,disposed=false;
 const flush=()=>{const selection=doc.getSelection();if(disposed||composing||(selection&&!selection.isCollapsed))return;const task=pending;pending=null;task?.();};
 const start=()=>{composing=true;},end=()=>{composing=false;flush();};
 doc.addEventListener('selectionchange',flush);doc.addEventListener('compositionstart',start,true);doc.addEventListener('compositionend',end,true);
 return {update(task){pending=task;flush();},dispose(){disposed=true;pending=null;doc.removeEventListener('selectionchange',flush);doc.removeEventListener('compositionstart',start,true);doc.removeEventListener('compositionend',end,true);}};
}
export function useReadingMarkdown(ref,text,context,settled,render){
 const scheduler=useRef(null);
 useLayoutEffect(()=>{scheduler.current=createReadingScheduler(ref.current);return()=>{scheduler.current.dispose();scheduler.current=null;};},[]);
 useLayoutEffect(()=>{scheduler.current.update(()=>render(ref.current,text||'',context));},[text,context,settled,render]);
}
