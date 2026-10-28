// Serialize host CAS writes; edits arriving during a save remain dirty and are
// saved against the returned revision. A conflict never advances the token or
// replaces the user's text, and cannot be implicitly retried as an overwrite.
export function createReviewDraft({text,revision,save,onState=()=>{}}){
 let value=text,saved=text,version=revision,inflight=null,error=null;
 const snapshot=()=>({text:value,revision:version,dirty:value!==saved,pending:Boolean(inflight),error});
 const emit=()=>onState(snapshot());
 async function flush(){
  if(inflight){await inflight;return flush();}
  if(error)throw error;
  if(value===saved)return snapshot();
  const sent=value,expected=version;
  inflight=Promise.resolve().then(()=>save({text:sent,revision:expected}));emit();
  try{const result=await inflight;version=result.revision;saved=sent;}
  catch(cause){error=cause;throw cause;}
  finally{inflight=null;emit();}
  return flush();
 }
 return {snapshot,setText(text){value=text;emit();},flush,retry(){error=null;emit();return flush();}};
}
