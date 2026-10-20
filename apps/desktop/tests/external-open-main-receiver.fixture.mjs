window.fixture={epoch:0,wakes:0,flushes:0,flushOK:true};
nozeli.subscribe('external.open',()=>{fixture.wakes++;});
nozeli.subscribe('session.flush',()=>{fixture.flushes++;return {ok:fixture.flushOK};});
fixture.display=read=>{
 // A deliberate text/directory receiver, not a PDF/Office/editor adapter.
 document.querySelector('#surface').textContent=read.file?.draft?.text??read.file?.text??JSON.stringify(read.project);
 fixture.epoch++;
 return {opened:true,surfaceReady:true,surfaceEpoch:fixture.epoch,display:read.project?'directory':read.file?.draft?'draft':'source',...Object.fromEntries(['projectId','relPath','digest','materialDigest','draftDigest'].map(k=>[k,read[k]]))};
};
fixture.ready=true;
