// Observe the original Pi process's final journal or its flushed prefix after
// abrupt exit. Unacknowledged tail bytes never mint adoption/release authority.
import path from 'node:path';
import {managedStorageLocation} from './managed-storage-scope.mjs';
import {reconcileColdRequests} from './cold-request-reconciliation.mjs';
import {inspectColdToolCustody} from './cold-tool-custody.mjs';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {createJsonlReader} from '../../agents/managed/jsonl-reader.mjs';
import {inspectExperimentalColdHostOutput} from './experimental-cold-output.mjs';
import {inspectExperimentalColdHostInput} from './experimental-cold-input.mjs';
import {inspectExperimentalColdHostSources,readExperimentalColdRegistrations} from './experimental-host-sources.mjs';
import {experimentalPrivateDirectoryComponents} from './experimental-directories.mjs';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';
import {openExperimentalPrivateTree} from './experimental-private-tree.mjs';
import {inspectColdSettingsReads} from './cold-settings-reads.mjs';
import {inspectColdRoleReads} from './cold-role-reads.mjs';
import {inspectColdMetadataReads} from './cold-metadata-reads.mjs';
const fail=(code,message,cause)=>Object.assign(Error(message,{cause}),{code,automaticReplay:false});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const freeze=value=>{for(const child of Object.values(value))if(child&&typeof child==='object')freeze(child);return Object.freeze(value);};
async function frames(bytes){
  const rows=[],stream=Readable.from([bytes]);let error;
  const reader=createJsonlReader(stream,{onFrame:frame=>rows.push(frame),onError:cause=>{error=cause;stream.destroy();}});
  await new Promise(resolve=>{stream.once('end',resolve);stream.once('close',resolve);});
  if(error||!reader.completed)throw fail('HOST_JOURNAL_PROTOCOL_INVALID','Original output/journal must contain complete valid JSONL frames',error);
  return rows;
}

export async function inspectExperimentalColdHostJournal(binding){
  const output=await inspectExperimentalColdHostOutput(binding),{storage,projectId,target,supervisor}=binding;
  const source=output.source,localFile=path.join(await storage.localDirectory(projectId),'ui.sqlite');
  const {owner}=await readExperimentalColdRegistrations(binding);
  if(owner.revision!==source.ownerRevision)throw fail('HOST_SOURCE_BINDING_CHANGED','Owner revision changed before journal inspection');
  const transcript=await frames(output.stdout.bytes),starts=transcript.filter(row=>row.method==='start'&&row.result),stops=transcript.filter(row=>row.method==='stop'&&row.result);
  if(starts.length!==1||stops.length>1||(stops.length===1&&transcript.at(-1)!==stops[0]))
    throw fail('HOST_JOURNAL_STOP_UNCONFIRMED','One original start and at most one terminal stop acknowledgement required');
  const start=starts[0],stop=stops[0],abrupt=!stop,launch=start.ownerLaunch,record=owner.value;
  // Residents use the registered project. Workers use the desktop's exact
  // per-work execution directory, never an arbitrary path from a reply.
  const expectedCwd=['frontdesk','orchestrator'].includes(target)?source.source.catalog.registration.value.root:
    path.join(await storage.localDirectory(projectId),'execution','execution',target);
  if(!launch||launch.schema!==1||(stop&&!same(launch,stop.ownerLaunch))||launch.ownerId!==record.ownerId||launch.generation!==record.generation||
     launch.launchId!==record.launchId||launch.home!==record.home||launch.cwd!==expectedCwd||
     typeof start.id!=='string'||(stop&&(typeof stop.id!=='string'||start.id===stop.id||transcript.indexOf(start)>=transcript.indexOf(stop))))
    throw fail('HOST_JOURNAL_BINDING_CHANGED','Original response identity differs from the persisted launch/project');
  const responseIds=new Set();
  for(const row of transcript)if(!row.event&&typeof row.id==='string'){
    if(responseIds.has(row.id))throw fail('HOST_JOURNAL_PROTOCOL_INVALID','Duplicate original response identity');responseIds.add(row.id);
  }
  const input=await inspectExperimentalColdHostInput(binding),requests=await frames(input.bytes);
  if(!same(source,input.source))throw fail('HOST_SOURCE_BINDING_CHANGED','Sources changed between input and output inspection');
  const startRequests=requests.filter(row=>row.method==='start'),stopRequests=requests.filter(row=>row.method==='stop'),requestIds=new Set();
  if(startRequests.length!==1||startRequests[0].id!==start.id||
     (!abrupt&&(stopRequests.length!==1||requests.at(-1)!==stopRequests[0]||stopRequests[0].id!==stop.id||requests.indexOf(startRequests[0])>=requests.indexOf(stopRequests[0]))))
    throw fail('HOST_JOURNAL_REQUEST_UNCONFIRMED','Original start and stop acknowledgements must match unique original-host requests');
  for(const row of requests)if(row.method){
    if(typeof row.id!=='string'||requestIds.has(row.id))throw fail('HOST_JOURNAL_REQUEST_UNCONFIRMED','Original host request IDs must be unique');
    requestIds.add(row.id);
  }
  const parameters=startRequests[0].params;
  if(parameters?.cwd!==launch.cwd||parameters?.home!==launch.home||parameters?.agentDir!==launch.agentDir)
    throw fail('HOST_JOURNAL_REQUEST_UNCONFIRMED','Original start request differs from acknowledged launch paths');
  const sessionId=start.result.sessionId,sessionFile=start.result.sessionFile,ack=stop?.result;
  const snapshots=abrupt?transcript.filter(row=>!row.event&&row.result&&['start','prompt','flush'].includes(row.method)).map(row=>({id:row.id,method:row.method,launch:row.ownerLaunch,snapshot:row.method==='flush'?row.result:row.result.journalSnapshot})):[];
  if(snapshots.length>256)throw fail('HOST_JOURNAL_LIMIT','Original snapshots exceed the bounded cold inspection budget');
  const final=abrupt?snapshots.at(-1)?.snapshot:ack.finalJournal;
  if(typeof sessionId!=='string'||!sessionId||typeof sessionFile!=='string'||!path.isAbsolute(sessionFile)||
     (!abrupt&&(ack.confirmationComplete!==true||ack.sessionId!==sessionId))||final?.sessionFile!==sessionFile||
     final.persistence?.mechanism!=='windows-private-file-handle'||final.persistence.file!=='flushed'||final.persistence.directory!=='flushed'||
     !/^[a-f0-9]{64}$/.test(final.sha256File??'')||typeof final.persistence.identity!=='string')
    throw fail('HOST_JOURNAL_STOP_UNCONFIRMED','Matching original session snapshot and native file/directory barriers required');
  const location=managedStorageLocation(storage,launch.home,{code:'HOST_JOURNAL_BINDING_CHANGED'}),root=location.root;
  const homeComponents=experimentalPrivateDirectoryComponents(root,launch.home);
  const agentComponents=experimentalPrivateDirectoryComponents(root,launch.agentDir);
  if(agentComponents.length<=homeComponents.length||!homeComponents.every((name,i)=>agentComponents[i]===name))
    throw fail('HOST_JOURNAL_BINDING_CHANGED','Original agent directory is outside its owner home');
  const directoryName=`--${path.resolve(launch.cwd).replace(/^[/\\]/,'').replace(/[/\\:]/g,'-')}--`;
  if(path.dirname(sessionFile)!==path.join(launch.agentDir,'sessions',directoryName)||path.extname(sessionFile)!=='.jsonl')
    throw fail('HOST_JOURNAL_BINDING_CHANGED','Original journal path differs from the native SDK session directory');
  const pins=[];
  const pin=file=>{const location=managedStorageLocation(storage,file,{code:'HOST_JOURNAL_BINDING_CHANGED'});if(location.root!==root)throw fail('HOST_JOURNAL_BINDING_CHANGED','Journal and owner home belong to different native roots');const parent=openExperimentalPersistenceParent(location.root,location.relative);pins.push(parent);const lease=parent.openPrivateTreeFile(path.basename(file));pins.push(lease);return {parent,lease};};
  const read=async(lease,limit)=>{
    const size=lease.stat().size;if(size<1n||size>BigInt(limit))throw fail('HOST_JOURNAL_LIMIT','Retained file exceeds its bounded inspection size');
    const chunks=[];for(let offset=0;offset<Number(size);){const bytes=lease.readAt(offset,Math.min(262144,Number(size)-offset));
      if(!bytes.length)throw fail('HOST_JOURNAL_CHANGED','Retained journal/metadata truncated');chunks.push(bytes);offset+=bytes.length;await setImmediate();}
    lease.verify();return Buffer.concat(chunks,Number(size));
  };
  try{
    const home=openExperimentalPersistenceParent(root,[...homeComponents,'__owner_custody__'].join('/'));pins.push(home);
    const custody=supervisor.snapshot();
    if(!custody.ownerHomeDirectoryCustodyVerified||custody.ownerHomeIdentity!==home.identity())
      throw fail('HOST_JOURNAL_HOME_UNVERIFIED','Original helper must retain this exact owner home directory');
    const metadata=pin(path.join(launch.home,'nozeli-session-tools.json')),journal=pin(sessionFile),stat=journal.lease.stat();
    if(stat.identity!==final.persistence.identity)throw fail('HOST_JOURNAL_CHANGED','Original final journal File ID differs');
    const metadataBytes=await read(metadata.lease,1048576);
    let saved;try{saved=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(metadataBytes));}
    catch(cause){if(cause.code)throw cause;throw fail('HOST_JOURNAL_CHANGED','Owner session metadata is invalid',cause);}
    if(saved.schema!==1||saved.threadId!==sessionId||saved.sessionFile!==sessionFile||!/^[a-f0-9]{64}$/.test(saved.toolsDigest??''))
      throw fail('HOST_JOURNAL_BINDING_CHANGED','Owner metadata no longer binds the original session');
    const bytes=await read(journal.lease,64*1024*1024),digest=sha(bytes);
    let confirmed=bytes,verifiedSnapshots=[];
    if(abrupt){
      let previous=0,inspected=0;const requestsById=new Map(requests.filter(row=>row.method).map(row=>[row.id,row]));
      for(const row of snapshots){
        const snapshot=row.snapshot,request=requestsById.get(row.id);
        if(!request||request.method!==row.method||!same(row.launch,launch)||
           snapshot?.sessionFile!==sessionFile||snapshot.persistence?.identity!==stat.identity||snapshot.persistence?.mechanism!=='windows-private-file-handle'||
           snapshot.persistence.file!=='flushed'||snapshot.persistence.directory!=='flushed'||
           !Number.isSafeInteger(snapshot.byteLength)||snapshot.byteLength<1||snapshot.byteLength<previous||snapshot.byteLength>bytes.length||
           !/^[a-f0-9]{64}$/.test(snapshot.sha256File??''))
          throw fail('HOST_JOURNAL_CHANGED','Original flushed journal prefix identity, order or exact bytes changed');
        if((inspected+=snapshot.byteLength)>256*1024*1024)throw fail('HOST_JOURNAL_LIMIT','Original snapshot verification exceeds its total byte budget');
        if(sha(bytes.subarray(0,snapshot.byteLength))!==snapshot.sha256File)throw fail('HOST_JOURNAL_CHANGED','Original flushed journal prefix bytes changed');
        const prefix=await frames(bytes.subarray(0,snapshot.byteLength)),entries=prefix.slice(1);
        if(snapshot.entryCount!==entries.length||snapshot.persistedEntryCount!==entries.length||snapshot.leafId!==null&&!entries.some(entry=>entry.id===snapshot.leafId))
          throw fail('HOST_JOURNAL_CHANGED','Original flushed prefix count or leaf differs');
        previous=snapshot.byteLength;verifiedSnapshots.push({responseId:row.id,method:row.method,bytes:previous,sha256:snapshot.sha256File});
      }
      confirmed=bytes.subarray(0,final.byteLength);
    }else if(digest!==final.sha256File)throw fail('HOST_JOURNAL_CHANGED','Actual journal bytes differ from the original stop digest');
    const rows=await frames(confirmed),header=rows[0],entries=rows.slice(1),ids=new Map();
    if(header?.type!=='session'||header.version!==3||header.id!==sessionId||header.cwd!==launch.cwd||
       final.entryCount!==entries.length||final.persistedEntryCount!==entries.length)
      throw fail('HOST_JOURNAL_BINDING_CHANGED','Actual journal header or entry count differs from original session evidence');
    for(const entry of entries){
      if(entry.type==='session'||typeof entry.id!=='string'||!entry.id||ids.has(entry.id)||
         entry.parentId!==null&&!ids.has(entry.parentId))throw fail('HOST_JOURNAL_CHANGED','Journal entry identities or parent chain are invalid');
      ids.set(entry.id,entry);
    }
    if((final.leafId!==null&&!ids.has(final.leafId))||(!entries.length&&final.leafId!==null))
      throw fail('HOST_JOURNAL_CHANGED','Original final journal leaf is absent');
    for(const row of transcript)if(row.event==='entry'&&(row.sessionId!==sessionId||(!abrupt||ids.has(row.entry?.id))&&!same(ids.get(row.entry?.id),row.entry)))
      throw fail('HOST_JOURNAL_CHANGED','Original native entry event differs from the retained journal');
    const reconciliation=reconcileColdRequests({requests,transcript:abrupt?transcript.filter(row=>row.event!=='entry'||ids.has(row.entry?.id)):transcript,entries,sessionId,launch});
    const toolCustody=await inspectColdToolCustody({storage,database:localFile,owner,tools:reconciliation.tools,turns:reconciliation.turns,
      frames:transcript.filter(frame=>frame.event==='tool'),inspectBusinessReceipts:binding.inspectBusinessReceipts===true});
    const materials={};
    for(const [kind,key,member] of [['settings','settingsReads','settings-reads'],['model-auth','modelAuthReads','model-auth-reads']]){
      let tree;
      try{
        try{tree=await openExperimentalPrivateTree(root,path.join(launch.agentDir,member),{rootAccess:'readwrite',fileAccess:'read',maxBytes:64*1024*1024});}
        catch(error){if(error.code!=='WIN32_IO_ERROR'||error.win32Code!==2)throw error;}
        const prefix=path.relative(launch.home,path.join(launch.agentDir,member)).split(path.sep).join('/');
        const manifest={entries:(tree?.manifest.entries??[]).map(e=>({...e,relative:prefix+(e.relative?'/'+e.relative:'')}))};
        materials[key]=await inspectColdSettingsReads({launch,requests,transcript,manifest,kind,
          readFile:(relative,options)=>tree.readFile(relative.slice(prefix.length+1),options)});
        await tree?.verify();
      }finally{tree?.close();}
    }
    {
      let tree;
      try{
        try{tree=await openExperimentalPrivateTree(root,path.join(launch.agentDir,'role-reads'),{rootAccess:'readwrite',fileAccess:'read',maxBytes:64*1024*1024});}
        catch(error){if(error.code!=='WIN32_IO_ERROR'||error.win32Code!==2)throw error;}
        const prefix=path.relative(launch.home,path.join(launch.agentDir,'role-reads')).split(path.sep).join('/');
        const manifest={entries:(tree?.manifest.entries??[]).map(e=>({...e,relative:prefix+(e.relative?'/'+e.relative:'')}))};
        materials.roleReads=await inspectColdRoleReads({launch,requests,transcript,manifest,
          readFile:(relative,options)=>tree.readFile(relative.slice(prefix.length+1),options)});
        await tree?.verify();
      }finally{tree?.close();}
    }
    let metadataTree;
    try{
      try{metadataTree=await openExperimentalPrivateTree(root,path.join(launch.home,'metadata-reads'),{rootAccess:'readwrite',fileAccess:'read',maxBytes:64*1024*1024});}
      catch(error){if(error.code!=='WIN32_IO_ERROR'||error.win32Code!==2)throw error;}
      const manifest={entries:(metadataTree?.manifest.entries??[]).map(e=>({...e,relative:'metadata-reads'+(e.relative?'/'+e.relative:'')}))};
      materials.metadataReads=await inspectColdMetadataReads({launch,requests,transcript,manifest,
        current:{identity:metadata.lease.stat().identity,sha256:sha(metadataBytes),parentIdentity:metadata.parent.identity()},
        readFile:(relative,options)=>metadataTree.readFile(relative.slice('metadata-reads/'.length),options)});
      await metadataTree?.verify();
    }finally{metadataTree?.close();}
    journal.lease.sync();journal.parent.syncDirectory();for(const pin of pins)pin.verify();
    if(!same(source,await inspectExperimentalColdHostSources(binding)))throw fail('HOST_SOURCE_BINDING_CHANGED','Sources changed during journal inspection');
    const facts=supervisor.snapshot();
    if(facts.outputError||!facts.stdoutEOF||!facts.stderrEOF||facts.stdoutSha256!==output.stdout.sha256||facts.stderrSha256!==output.stderr.sha256||
       facts.inputError||facts.inputPending||!facts.inputClosed||facts.inputSha256!==input.sha256||facts.inputBytes!==input.byteLength||facts.inputCompletedBytes!==input.byteLength)
      throw fail('HOST_OUTPUT_CHANGED','Original output changed during final journal inspection');
    for(const pin of pins)pin.verify();
    return freeze({schema:1,scope:abrupt?'cold-host-original-flushed-prefix-observation-only':'cold-host-original-stop-and-journal-observation-only',projectId,target,
      ownerRevision:owner.revision,ownerId:record.ownerId,generation:record.generation,launchId:record.launchId,hostLeaseId:record.hostLeaseId,
      reconciliation,toolCustody,...materials,sessionId,sessionFile,stopResponseId:stop?.id??null,entryCount:entries.length,leafId:final.leafId,
      ...(abrupt?{verifiedSnapshots,confirmedJournalBytes:confirmed.length,confirmedJournalSha256:sha(confirmed),
        unconfirmedTailBytes:bytes.length-confirmed.length,unconfirmedTailSha256:sha(bytes.subarray(confirmed.length)),
        unconfirmedEntryEvents:transcript.filter(row=>row.event==='entry'&&!ids.has(row.entry?.id)).length,finalJournalComplete:false}: {finalJournalComplete:true}),
      metadataIdentity:metadata.lease.stat().identity,metadataSha256:sha(metadataBytes),journalIdentity:stat.identity,journalSha256:digest,journalBytes:bytes.length,
      originalStopAcknowledgementObserved:!abrupt,launchIdentityVerified:true,journalDigestVerified:!abrupt,confirmedPrefixDigestVerified:abrupt,nativeEntriesVerified:true,
      stdoutSha256:output.stdout.sha256,stderrSha256:output.stderr.sha256,inputSha256:input.sha256,inputBytes:input.byteLength,source,
      barriers:{file:'flushed',directory:'flushed',namespace:'not-qualified'},
      originalHostStopRequestVerified:!abrupt,stopRequestAdmissionQualified:!abrupt,stopRequestAdmissionScope:abrupt?null:'original-host-native-delivery-and-matching-Pi-dispatch-only',
      hostProjectionQualified:false,coldRecoveryQualified:false,ownerReleaseQualified:false,automaticReplay:false});
  }finally{for(const pin of pins.reverse())pin.close();}
}
