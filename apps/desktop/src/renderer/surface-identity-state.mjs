// Small identity-scoped state shared by the renderer's asynchronous surfaces.
export function createInflightReads() {
  const pending = new Map();
  return {
    clear: () => pending.clear(),
    run(key, read) {
      if (pending.has(key)) return pending.get(key);
      const request = Promise.resolve().then(read).finally(() => {
        if (pending.get(key) === request) pending.delete(key);
      });
      pending.set(key, request);
      return request;
    },
  };
}

export function createDiscussionDrafts() {
  const drafts = new Map();
  const key = (projectId, tagId) => JSON.stringify([projectId, tagId]);
  return {
    get: (projectId, tagId) => drafts.get(key(projectId, tagId)),
    set: (projectId, tagId, value) => drafts.set(key(projectId, tagId), value),
    delete: (projectId, tagId) => drafts.delete(key(projectId, tagId)),
  };
}

export function createProjectFiles({list, current, apply}) {
  let request = 0;
  return async function refresh() {
    const identity = current(), serial = ++request;
    if (!identity.projectId) return;
    const result = await list(identity.projectId);
    const latest = current();
    if (serial !== request || identity.projectId !== latest.projectId || identity.generation !== latest.generation) return;
    if (result.ok) apply(new Set(result.value.entries.filter(entry => entry.kind !== 'dir').map(entry => entry.relPath)));
  };
}

export function restoredComposerDraft({draft, local, durable}) {
  return draft !== undefined ? draft : local ?? durable ?? '';
}

// Native input is usable while status/connect is pending. Persist each captured
// project/target even before Agent activation; readiness only gates sending.
export function bindComposerDrafts({composer,current,remember,persist,onInput,onError}) {
  let pending=Promise.resolve();
  composer.addEventListener('input',()=>{
    const identity=current();
    if(!identity.projectId)return;
    const draft={...identity,text:composer.value};
    remember(draft);
    pending=pending.catch(()=>{}).then(()=>persist(draft)).catch(onError);
    onInput();
  });
  return {settled:()=>pending};
}

export function ownsDiscussionReceipt({projectId, currentProjectId, tag, currentTag, state, token}) {
  return projectId === currentProjectId && tag === currentTag && state?.pendingToken === token;
}

// Automatic hydration has a generation-local finite budget. Descriptors outlive
// body pins; saturation still leaves explicit original reads available by identity.
export function createIdentityHydration({limit=512}={}) {
  const descriptors=new Map(),pending=createInflightReads();let epoch=0;
  return {
    clear(){epoch++;descriptors.clear();pending.clear();},
    entries:()=>[...descriptors.values()],
    ensure(id,{has,read,pin,onError=()=>{}}){
      if(has(id)||descriptors.has(id)||descriptors.size>=limit)return Promise.resolve();
      const generation=epoch;
      descriptors.set(id,{id,text:'',availability:'read-required'});
      return pending.run(id,async()=>{
        try{
          const entry=await read(id);if(generation!==epoch)return;
          const descriptor={id:entry.id,sequence:entry.sequence,requestId:entry.requestId,jobId:entry.jobId,target:entry.target,speaker:entry.speaker,source:entry.source,durable:entry.durable,complete:entry.complete,status:entry.status,failed:entry.failed,streaming:Boolean(entry.streaming),text:'',availability:'read-required'};
          if(entry.read)descriptor.read={version:entry.read.version,maxBytes:entry.read.maxBytes,fields:(entry.read.fields||[]).slice(0,8).map(({field,totalBytes})=>({field,totalBytes}))};
          descriptors.set(id,descriptor);pin(entry);
        }catch(error){if(generation===epoch)onError(error);}
      });
    },
  };
}
