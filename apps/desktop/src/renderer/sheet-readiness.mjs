// Fortune exposes its ref before its passive initialization has materialized
// the active sheet. Timer ordering alone cannot establish that it is ready.
export function materializedWorkbook(editor,expected){
  const sheets=editor.getAllSheets();
  if(sheets.length!==expected.length||!expected.every(sheet=>sheets.some(current=>current.id===sheet.id)))return false;
  const active=editor.getSheet();
  return Array.isArray(active?.data)&&active.data.length>0;
}
export function initializeWorkbook({current,expected,schedule=callback=>requestAnimationFrame(callback),onReady}){
  let calculating=false,finished=false;
  const inspect=()=>{
    if(finished)return;
    const editor=current();
    if(!editor||!materializedWorkbook(editor,expected)){schedule(inspect);return;}
    if(!calculating){calculating=true;editor.calculateFormula();schedule(()=>schedule(inspect));return;}
    finished=true;onReady(structuredClone(editor.getAllSheets()));
  };
  schedule(inspect);
  return ()=>{finished=true;};
}
