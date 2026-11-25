// Included after the Job implementation. Source HANDLE values are transient
// launch/IPC handoff details and never enter a JS/persistent identity record.
#include "supervisor-protocol.h"
struct SupervisorPin {
  std::unique_ptr<JobPin> observed;
  IoHandle process,host,image,launchSet;
  std::string imageIdentity;
  DWORD pid=0,hostPid=0,leaderPid=0;
  ULONGLONG creation=0,hostCreation=0,leaderCreation=0;
  std::wstring pipe;
  uint32_t custodyCount=0;
  uint32_t custodyRoles=0;
  BYTE custodySha256[32]{};
  BYTE sourceSha256[32]{};
  std::string ownerHomeIdentity;
  bool outputEnabled=false,inputEnabled=false,inputFailed=false,inputActive=false,anchorAttempted=false;
  uint64_t inputOffset=0;
  uint32_t inputActiveBytes=0;
};
constexpr napi_type_tag supervisorTag={0x795b24580e2940deULL,0xb8ad152eb8459f73ULL};
std::wstring SupervisorImage() {
  HMODULE module=nullptr;
  if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
      reinterpret_cast<LPCWSTR>(&SupervisorImage),&module))throw Failure("SUPERVISOR_IMAGE_UNVERIFIED","Cannot locate native module",GetLastError());
  std::vector<wchar_t> buffer(32768);const auto size=GetModuleFileNameW(module,buffer.data(),static_cast<DWORD>(buffer.size()));
  if(!size||size>=buffer.size())throw Failure("SUPERVISOR_IMAGE_UNVERIFIED","Cannot locate supervisor executable",GetLastError());
  const std::wstring file(buffer.data(),size);return file.substr(0,file.find_last_of(L'\\')+1)+L"nozeli_windows_supervisor.exe";
}
ULONGLONG ProcessCreation(HANDLE process) {
  FILETIME creation{},exit{},kernel{},user{};
  if(!GetProcessTimes(process,&creation,&exit,&kernel,&user))throw Failure("SUPERVISOR_IDENTITY_UNVERIFIED","Cannot inspect process incarnation",GetLastError());
  return Time(creation);
}
std::string SupervisorFileIdentity(HANDLE file){
  FILE_ID_INFO identity{};BY_HANDLE_FILE_INFORMATION info{};
  if(!GetFileInformationByHandleEx(file,FileIdInfo,&identity,sizeof(identity))||!GetFileInformationByHandle(file,&info)||
     info.dwFileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY)||info.nNumberOfLinks!=1)
    throw Failure("SUPERVISOR_IMAGE_UNVERIFIED","Supervisor image entity cannot be verified",GetLastError());
  std::string text=std::to_string(identity.VolumeSerialNumber)+":";const char* digits="0123456789abcdef";
  for(auto byte:identity.FileId.Identifier){text+=digits[byte>>4];text+=digits[byte&15];}return text;
}
void VerifySupervisorProcess(SupervisorPin* pin) {
  if(!pin->process.value||pin->process.value==INVALID_HANDLE_VALUE)throw Failure("SUPERVISOR_CLOSED","Supervisor observation closed");
  if(GetProcessId(pin->process.value)!=pin->pid||ProcessCreation(pin->process.value)!=pin->creation||
     WaitForSingleObject(pin->process.value,0)!=WAIT_TIMEOUT)throw Failure("SUPERVISOR_IDENTITY_UNVERIFIED","Original supervisor is not running");
  std::vector<wchar_t> image(32768);DWORD size=static_cast<DWORD>(image.size());
  if(!QueryFullProcessImageNameW(pin->process.value,0,image.data(),&size))
    throw Failure("SUPERVISOR_IMAGE_UNVERIFIED","Supervisor executable does not match the pinned runtime",GetLastError());
  IoHandle actual;actual.value=CreateFileW(image.data(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
  if(actual.value==INVALID_HANDLE_VALUE||SupervisorFileIdentity(actual.value)!=pin->imageIdentity||SupervisorFileIdentity(pin->image.value)!=pin->imageIdentity)
    throw Failure("SUPERVISOR_IMAGE_UNVERIFIED","Supervisor executable entity differs from its retained identity",GetLastError());
}
nozeli_supervisor::Reply SupervisorRequest(SupervisorPin* pin,nozeli_supervisor::Operation operation,uint32_t channel=0,uint64_t offset=0,std::vector<BYTE>* payload=nullptr,const BYTE* input=nullptr,uint32_t inputSize=0) {
  VerifySupervisorProcess(pin);
  IoHandle pipe;pipe.value=CreateFileW(pin->pipe.c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr);
  if(pipe.value==INVALID_HANDLE_VALUE&&GetLastError()==ERROR_PIPE_BUSY&&WaitNamedPipeW(pin->pipe.c_str(),3000))
    pipe.value=CreateFileW(pin->pipe.c_str(),GENERIC_READ|GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OVERLAPPED,nullptr);
  if(pipe.value==INVALID_HANDLE_VALUE)throw Failure("SUPERVISOR_CONNECTION_UNVERIFIED","Cannot connect to original supervisor; no absence verdict",GetLastError());
  ULONG server=0;
  if(!GetNamedPipeServerProcessId(pipe.value,&server)||server!=pin->pid)throw Failure("SUPERVISOR_IDENTITY_UNVERIFIED","Pipe server is not the retained supervisor",GetLastError());
  VerifySupervisorProcess(pin);DWORD mode=PIPE_READMODE_MESSAGE;
  if(!SetNamedPipeHandleState(pipe.value,&mode,nullptr,nullptr))throw Failure("SUPERVISOR_CONNECTION_UNVERIFIED","Cannot select framed supervisor IPC",GetLastError());
  nozeli_supervisor::Request request;request.operation=operation;request.channel=channel;request.offset=offset;
  if(payload&&(operation==nozeli_supervisor::Operation::readOutput||operation==nozeli_supervisor::Operation::readInput))request.length=nozeli_supervisor::outputChunk;
  if(input)request.length=inputSize;
  nozeli_supervisor::Reply reply;
  if(!nozeli_supervisor::Exchange(pipe.value,&request,sizeof(request),true)||
     (input&&!nozeli_supervisor::Exchange(pipe.value,const_cast<BYTE*>(input),inputSize,true))||
     !nozeli_supervisor::Exchange(pipe.value,&reply,sizeof(reply),false))
    throw Failure("SUPERVISOR_RESULT_UNKNOWN","Supervisor IPC outcome unknown; do not replay",GetLastError());
  if(reply.magicValue!=nozeli_supervisor::magic||reply.versionValue!=nozeli_supervisor::version)
    throw Failure("SUPERVISOR_PROTOCOL_UNVERIFIED","Supervisor frame has an unknown schema");
  if(reply.dataSize>nozeli_supervisor::outputChunk||(reply.dataSize&&!payload))
    throw Failure("SUPERVISOR_PROTOCOL_UNVERIFIED","Unbounded or unexpected supervisor payload");
  if(payload){
    payload->resize(reply.dataSize);
    if(reply.dataSize&&!nozeli_supervisor::Exchange(pipe.value,payload->data(),reply.dataSize,false))
      throw Failure("SUPERVISOR_RESULT_UNKNOWN","Supervisor output range outcome unknown; do not replay",GetLastError());
  }
  IoHandle transferredAnchor;
  if(operation==nozeli_supervisor::Operation::claimColdAnchor&&payload&&payload->size()==sizeof(nozeli_custody::Frame)){
    nozeli_custody::Frame frame{};memcpy(&frame,payload->data(),sizeof(frame));
    transferredAnchor.value=reinterpret_cast<HANDLE>(frame.handle);
  }
  uint32_t ack=nozeli_supervisor::magic;nozeli_supervisor::Exchange(pipe.value,&ack,sizeof(ack),true);
  if(reply.error)throw Failure("SUPERVISOR_REQUEST_REFUSED","Supervisor operation refused",reply.error);
  if(operation!=nozeli_supervisor::Operation::inspect&&(!memchr(reply.ownerHomeIdentity,0,sizeof(reply.ownerHomeIdentity))||pin->ownerHomeIdentity!=reply.ownerHomeIdentity))
    throw Failure("CUSTODY_ENTITY_CHANGED","Supervisor owner home differs from its original handoff");
  if(operation!=nozeli_supervisor::Operation::inspect&&(reply.custodyCount!=pin->custodyCount||reply.custodyRoles!=pin->custodyRoles||memcmp(reply.custodySha256,pin->custodySha256,32)||memcmp(reply.sourceSha256,pin->sourceSha256,32)))
    throw Failure("CUSTODY_ENTITY_CHANGED","Supervisor custody differs from its original handoff");
  if(operation!=nozeli_supervisor::Operation::inspect&&reply.outputEnabled!=(pin->outputEnabled?1u:0u))
    throw Failure("SUPERVISOR_OUTPUT_UNVERIFIED","Supervisor output custody differs from its handoff");
  if(operation!=nozeli_supervisor::Operation::inspect&&reply.inputEnabled!=(pin->inputEnabled?1u:0u))
    throw Failure("SUPERVISOR_INPUT_UNVERIFIED","Supervisor input custody differs from its handoff");
  transferredAnchor.value=INVALID_HANDLE_VALUE;
  return reply;
}
void ObserveSupervisor(SupervisorPin* pin,JobPin* owner=nullptr) {
  std::vector<BYTE> payload;
  const auto reply=SupervisorRequest(pin,nozeli_supervisor::Operation::inspect,0,0,&payload);
  // The helper duplicated only query/synchronize rights into this pipe peer.
  // Own all received handles before any throwing validation/allocation.
  IoHandle launchSet;launchSet.value=reinterpret_cast<HANDLE>(reply.launchSet);
  IoHandle job,leader,host;job.value=reinterpret_cast<HANDLE>(reply.job);leader.value=reinterpret_cast<HANDLE>(reply.leader);host.value=reinterpret_cast<HANDLE>(reply.host);
  std::vector<std::unique_ptr<IoHandle>> members;
  if(reply.memberCount>4096||payload.size()!=static_cast<size_t>(reply.memberCount)*sizeof(uint64_t))
    throw Failure("SUPERVISOR_PROTOCOL_UNVERIFIED","Invalid bounded member HANDLE frame");
  members.reserve(reply.memberCount);
  for(size_t i=0;i<reply.memberCount;i++){
    auto handle=std::make_unique<IoHandle>();uint64_t value=0;memcpy(&value,payload.data()+i*sizeof(value),sizeof(value));
    handle->value=reinterpret_cast<HANDLE>(value);members.push_back(std::move(handle));
  }
  if(!memchr(reply.ownerHomeIdentity,0,sizeof(reply.ownerHomeIdentity))||pin->ownerHomeIdentity!=reply.ownerHomeIdentity)
    throw Failure("CUSTODY_ENTITY_CHANGED","Supervisor owner home differs from its original handoff");
  if(reply.membersError)throw Failure("PROCESS_JOB_MEMBERS_UNVERIFIED","Original helper member observation failed; retain custody",reply.membersError);
  if(reply.outputEnabled!=(pin->outputEnabled?1u:0u))throw Failure("SUPERVISOR_OUTPUT_UNVERIFIED","Supervisor output custody differs from its handoff");
  if(reply.inputEnabled!=(pin->inputEnabled?1u:0u))throw Failure("SUPERVISOR_INPUT_UNVERIFIED","Supervisor input custody differs from its handoff");
  if(reply.custodyCount!=pin->custodyCount||reply.custodyRoles!=pin->custodyRoles||memcmp(reply.custodySha256,pin->custodySha256,32)||memcmp(reply.sourceSha256,pin->sourceSha256,32))
    throw Failure("CUSTODY_ENTITY_CHANGED","Supervisor custody differs from its original handoff");
  if(!job.value||!leader.value||!host.value||GetProcessId(leader.value)!=pin->leaderPid||ProcessCreation(leader.value)!=pin->leaderCreation||
     GetProcessId(host.value)!=pin->hostPid||ProcessCreation(host.value)!=pin->hostCreation)
    throw Failure("SUPERVISOR_IDENTITY_UNVERIFIED","Transferred kernel objects differ from the recorded incarnations");
  BOOL member=FALSE;
  if(!IsProcessInJob(leader.value,job.value,&member)||!member)throw Failure("SUPERVISOR_IDENTITY_UNVERIFIED","Transferred leader belongs to another Job",GetLastError());
  auto observed=std::make_unique<JobPin>();observed->job=job.value;job.value=INVALID_HANDLE_VALUE;
  observed->process.hProcess=leader.value;leader.value=INVALID_HANDLE_VALUE;observed->process.dwProcessId=pin->leaderPid;
  observed->creation=pin->leaderCreation;observed->resumed=true;
  if(owner&&owner->factsMapping) {
    // Warm handoff: observe the same single-writer member facts section the
    // helper publishes, so this observation stays aligned with its ledger.
    if(!DuplicateHandle(GetCurrentProcess(),owner->factsMapping,GetCurrentProcess(),&observed->factsMapping,FILE_MAP_READ,FALSE,0))
      throw Failure("SUPERVISOR_CREATE_FAILED","Cannot retain member facts for observation",GetLastError());
    observed->factsView=static_cast<nozeli_members::MemberFacts*>(MapViewOfFile(observed->factsMapping,FILE_MAP_READ,0,0,sizeof(nozeli_members::MemberFacts)));
    if(!observed->factsView){const DWORD error=GetLastError();CloseHandle(observed->factsMapping);observed->factsMapping=nullptr;
      throw Failure("SUPERVISOR_CREATE_FAILED","Cannot map member facts for observation",error);}
  }
  for(auto& handle:members){
    const auto pid=GetProcessId(handle->value);const auto creation=ProcessCreation(handle->value);BOOL member=FALSE;DWORD flags=0;
    if(!pid||pid==pin->leaderPid||!IsProcessInJob(handle->value,observed->job,&member)||!member||
       !GetHandleInformation(handle->value,&flags)||(flags&HANDLE_FLAG_INHERIT)||
       std::any_of(observed->members.begin(),observed->members.end(),[&](const JobPin::Member& held){return held.pid==pid&&held.creation==creation;}))
      throw Failure("PROCESS_JOB_MEMBERS_UNVERIFIED","Transferred member is not an original distinct Job incarnation");
    observed->members.push_back({handle->value,pid,creation});handle->value=INVALID_HANDLE_VALUE;
  }
  InspectJob(observed.get());VerifySupervisorProcess(pin);
  pin->observed=std::move(observed);pin->host.value=host.value;host.value=INVALID_HANDLE_VALUE;
  pin->launchSet.value=launchSet.value;launchSet.value=INVALID_HANDLE_VALUE;
}
SupervisorPin* SupervisorReceiver(napi_env env,napi_callback_info info) {
  napi_value self;size_t count=0;Check(napi_get_cb_info(env,info,&count,nullptr,&self,nullptr));
  napi_valuetype type;Check(napi_typeof(env,self,&type));bool tagged=false;
  if(type==napi_object)Check(napi_check_object_type_tag(env,self,&supervisorTag,&tagged));
  if(!tagged)throw Failure("SUPERVISOR_RECEIVER","Expected an original native supervisor observation");
  SupervisorPin* pin=nullptr;Check(napi_unwrap(env,self,reinterpret_cast<void**>(&pin)));return pin;
}
napi_value SupervisorSnapshot(napi_env env,napi_callback_info info) {
  return Guard(env,[&]{auto* pin=SupervisorReceiver(env,info);VerifySupervisorProcess(pin);
    if(!pin->observed)throw Failure("SUPERVISOR_CLOSED","Supervisor observation closed");
    const auto retained=SupervisorRequest(pin,nozeli_supervisor::Operation::verify);
    if(retained.membersError)throw Failure("PROCESS_JOB_MEMBERS_UNVERIFIED","Original helper member observation failed; retain custody",retained.membersError);
    const auto result=JobSnapshotValue(env,pin->observed.get());
    Number(env,result,"custodyEntityCount",pin->custodyCount);
    Boolean(env,result,"custodyVerified",pin->custodyCount>0);
    Boolean(env,result,"sourceCustodyVerified",(pin->custodyRoles&31)==31);
    Boolean(env,result,"ownerHomeDirectoryCustodyVerified",(pin->custodyRoles&32)!=0);
    Text(env,result,"ownerHomeIdentity",pin->ownerHomeIdentity);
    Number(env,result,"custodyRoles",pin->custodyRoles);
    std::string sourceDigest;const char* hex="0123456789abcdef";
    for(auto byte:pin->sourceSha256){sourceDigest+=hex[byte>>4];sourceDigest+=hex[byte&15];}
    Text(env,result,"sourceSha256",sourceDigest);
    Boolean(env,result,"outputCustodyVerified",pin->outputEnabled);
    Number(env,result,"outputLimitBytes",nozeli_supervisor::outputLimit);
    Number(env,result,"outputError",retained.outputError);
    Boolean(env,result,"inputCustodyVerified",pin->inputEnabled);
    Number(env,result,"inputLimitBytes",nozeli_supervisor::inputLimit);
    Number(env,result,"inputError",retained.inputError);
    Boolean(env,result,"inputPending",retained.inputPending!=0);Boolean(env,result,"inputClosed",retained.inputClosed!=0);
    Number(env,result,"inputBytes",static_cast<DWORD>(retained.inputBytes));Number(env,result,"inputCompletedBytes",static_cast<DWORD>(retained.inputCompletedBytes));
    std::string inputHash;for(auto byte:retained.inputSha256){inputHash+=hex[byte>>4];inputHash+=hex[byte&15];}
    Text(env,result,"inputSha256",inputHash);
    for(size_t i=0;i<2;i++){
      const std::string prefix=i==0?"stdout":"stderr";
      Number(env,result,(prefix+"Bytes").c_str(),static_cast<DWORD>(retained.outputBytes[i]));
      Text(env,result,(prefix+"ObservedBytes").c_str(),std::to_string(retained.outputObservedBytes[i]));
      Boolean(env,result,(prefix+"EOF").c_str(),retained.outputEOF[i]!=0);
      std::string hash;for(auto byte:retained.outputSha256[i]){hash+=hex[byte>>4];hash+=hex[byte&15];}
      Text(env,result,(prefix+"Sha256").c_str(),hash);
    }
    Number(env,result,"supervisorPid",pin->pid);Text(env,result,"supervisorCreationTime100ns",std::to_string(pin->creation));
    Number(env,result,"hostPid",pin->hostPid);Text(env,result,"hostCreationTime100ns",std::to_string(pin->hostCreation));
    Boolean(env,result,"hostExited",WaitForSingleObject(pin->host.value,0)==WAIT_OBJECT_0);
    Check(napi_set_named_property(env,result,"launchSet",ColdLaunchSet(env,pin->launchSet.value,pin->host.value,pin->sourceSha256)));
    const auto facts=InspectJob(pin->observed.get());Text(env,result,"state",facts.empty?"exited":"retained");
    napi_value key;Check(napi_create_string_utf8(env,"resumed",NAPI_AUTO_LENGTH,&key));bool deleted;Check(napi_delete_property(env,result,key,&deleted));
    Text(env,result,"executionState","not-observed");
    Text(env,result,"scope","retained-supervisor-kernel-observation-only");Boolean(env,result,"coldRecoveryQualified",false);return result;});
}
napi_value SupervisorClose(napi_env env,napi_callback_info info) {
  return Guard(env,[&]{auto* pin=SupervisorReceiver(env,info);pin->observed.reset();pin->launchSet.Close();pin->host.Close();pin->process.Close();pin->image.Close();napi_value value;Check(napi_get_undefined(env,&value));return value;});
}
napi_value SupervisorShutdown(napi_env env,napi_callback_info info) {
  return Guard(env,[&]{auto* pin=SupervisorReceiver(env,info);SupervisorRequest(pin,nozeli_supervisor::Operation::close);
    if(WaitForSingleObject(pin->process.value,3000)!=WAIT_OBJECT_0)throw Failure("SUPERVISOR_RESULT_UNKNOWN","Helper shutdown not yet observed");
    napi_value result;Check(napi_create_object(env,&result));Boolean(env,result,"supervisorExited",true);Boolean(env,result,"ownerReleaseQualified",false);return result;});
}
napi_value SupervisorObserveExit(napi_env env,napi_callback_info info) {
  return Guard(env,[&]{auto* pin=SupervisorReceiver(env,info);
    if(!pin->process.value||pin->process.value==INVALID_HANDLE_VALUE)
      throw Failure("SUPERVISOR_CLOSED","Original supervisor process observation closed");
    if(GetProcessId(pin->process.value)!=pin->pid||ProcessCreation(pin->process.value)!=pin->creation)
      throw Failure("SUPERVISOR_IDENTITY_UNVERIFIED","Original supervisor process incarnation changed");
    const auto state=WaitForSingleObject(pin->process.value,0);
    if(state!=WAIT_OBJECT_0&&state!=WAIT_TIMEOUT)
      throw Failure("SUPERVISOR_RESULT_UNKNOWN","Original supervisor exit cannot be observed",GetLastError());
    napi_value result;Check(napi_create_object(env,&result));
    Text(env,result,"scope","retained-supervisor-process-exit-observation-only");
    Number(env,result,"supervisorPid",pin->pid);
    Text(env,result,"supervisorCreationTime100ns",std::to_string(pin->creation));
    Boolean(env,result,"supervisorExited",state==WAIT_OBJECT_0);
    Boolean(env,result,"shutdownAcknowledged",false);
    Boolean(env,result,"ownerReleaseQualified",false);
    Boolean(env,result,"automaticReplay",false);
    return result;
  });
}
// The restricted duplicate retains the original file object's share exclusion.
// It cannot read/write file bytes, mutate policy, retire a row or launch work.
using nozeli_custody::ColdAnchor;
using nozeli_custody::coldAnchorTag;
ColdAnchor* ColdAnchorReceiver(napi_env env,napi_callback_info info){
  napi_value self;size_t count=0;Check(napi_get_cb_info(env,info,&count,nullptr,&self,nullptr));
  return LaunchReceiver<ColdAnchor>(env,self,coldAnchorTag);
}
napi_value ColdAnchorVerify(napi_env env,napi_callback_info info){return Guard(env,[&]{
  auto* held=ColdAnchorReceiver(env,info);
  held->Verify();
  napi_value value;Check(napi_get_undefined(env,&value));return value;
});}
napi_value ColdAnchorClose(napi_env env,napi_callback_info info){return Guard(env,[&]{
  auto* held=ColdAnchorReceiver(env,info);
  if(held->file.value!=INVALID_HANDLE_VALUE){CloseHandle(held->file.value);held->file.value=INVALID_HANDLE_VALUE;}
  napi_value value;Check(napi_get_undefined(env,&value));return value;
});}
napi_value SupervisorClaimColdAnchor(napi_env env,napi_callback_info info){return Guard(env,[&]{
  auto* pin=SupervisorReceiver(env,info);
  if(pin->anchorAttempted)throw Failure("COLD_ANCHOR_ATTEMPTED","Cold anchor claim cannot be retried");
  // Refusal and uncertain IPC both consume this client's flight. The shared
  // original host mapping arbitrates across all independently connected helpers.
  pin->anchorAttempted=true;
  std::vector<BYTE> payload;payload.reserve(sizeof(nozeli_custody::Frame));
  const auto reply=SupervisorRequest(pin,nozeli_supervisor::Operation::claimColdAnchor,0,0,&payload);
  if(payload.size()!=sizeof(nozeli_custody::Frame))throw Failure("COLD_ANCHOR_UNVERIFIED","Exact bounded original anchor frame required");
  auto held=std::make_unique<ColdAnchor>();memcpy(&held->frame,payload.data(),sizeof(held->frame));
  held->file.value=reinterpret_cast<HANDLE>(held->frame.handle);
  DWORD flags=0;
  if(!reply.hostExited||held->frame.kind!=nozeli_custody::Kind::anchor||
     !GetHandleInformation(held->file.value,&flags)||(flags&HANDLE_FLAG_INHERIT))
    throw Failure("COLD_ANCHOR_UNVERIFIED","Non-inheritable original cold anchor required");
  nozeli_custody::Verify(held->frame);VerifySupervisorProcess(pin);
  napi_value result;Check(napi_create_object(env,&result));Check(napi_type_tag_object(env,result,&coldAnchorTag));
  char volume[18];sprintf_s(volume,"%016llx:",static_cast<unsigned long long>(held->frame.initial.id.VolumeSerialNumber));
  std::string identity=volume;
  const char* digits="0123456789abcdef";
  for(auto byte:held->frame.initial.id.FileId.Identifier){identity+=digits[byte>>4];identity+=digits[byte&15];}
  Text(env,result,"identity",identity);
  Boolean(env,result,"inheritable",false);Boolean(env,result,"ownerReleaseQualified",false);
  Boolean(env,result,"coldRecoveryQualified",false);Boolean(env,result,"automaticReplay",false);
  napi_property_descriptor methods[]={{"verify",nullptr,ColdAnchorVerify,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"close",nullptr,ColdAnchorClose,nullptr,nullptr,nullptr,napi_default,nullptr}};
  Check(napi_define_properties(env,result,2,methods));
  Check(napi_wrap(env,result,held.get(),[](napi_env,void* data,void*){delete static_cast<ColdAnchor*>(data);},nullptr,nullptr));held.release();return result;
});}
napi_value SupervisorReadOutput(napi_env env,napi_callback_info info){
  return Guard(env,[&]{auto* pin=SupervisorReceiver(env,info);
    if(!pin->outputEnabled)throw Failure("SUPERVISOR_OUTPUT_UNAVAILABLE","No original output endpoint custody");
    size_t count=3;napi_value args[3];Check(napi_get_cb_info(env,info,&count,args,nullptr,nullptr));
    if(count!=2)throw Failure("SUPERVISOR_OUTPUT_RANGE","Expected output channel and bounded byte offset");
    double values[2]{};
    for(size_t i=0;i<2;i++){napi_valuetype type;Check(napi_typeof(env,args[i],&type));
      if(type!=napi_number)throw Failure("SUPERVISOR_OUTPUT_RANGE","Numeric output channel and offset required");
      Check(napi_get_value_double(env,args[i],&values[i]));
      if(!std::isfinite(values[i])||std::floor(values[i])!=values[i])throw Failure("SUPERVISOR_OUTPUT_RANGE","Integer output channel and offset required");}
    if((values[0]!=1&&values[0]!=2)||values[1]<0||values[1]>nozeli_supervisor::outputLimit)
      throw Failure("SUPERVISOR_OUTPUT_RANGE","Output channel or byte offset outside bound");
    std::vector<BYTE> bytes;const auto channel=static_cast<uint32_t>(values[0]);
    const auto reply=SupervisorRequest(pin,nozeli_supervisor::Operation::readOutput,channel,static_cast<uint64_t>(values[1]),&bytes);
    if(bytes.empty()&&reply.outputError)throw Failure("SUPERVISOR_OUTPUT_UNCONFIRMED","Output custody failed; no complete stream or release proof",reply.outputError);
    napi_value result;Check(napi_create_object(env,&result));
    Text(env,result,"state",!bytes.empty()?"data":reply.outputEOF[channel-1]?"eof":"pending");
    if(!bytes.empty()){napi_value buffer;Check(napi_create_buffer_copy(env,bytes.size(),bytes.data(),nullptr,&buffer));Check(napi_set_named_property(env,result,"bytes",buffer));}
    return result;});
}
napi_value SupervisorReadInput(napi_env env,napi_callback_info info){
  return Guard(env,[&]{auto* pin=SupervisorReceiver(env,info);
    if(!pin->inputEnabled)throw Failure("SUPERVISOR_INPUT_UNAVAILABLE","No original stdin custody");
    size_t count=2;napi_value args[2];Check(napi_get_cb_info(env,info,&count,args,nullptr,nullptr));
    napi_valuetype type=napi_undefined;double offset=-1;
    if(count==1){Check(napi_typeof(env,args[0],&type));if(type==napi_number)Check(napi_get_value_double(env,args[0],&offset));}
    if(type!=napi_number||!std::isfinite(offset)||std::floor(offset)!=offset||offset<0||offset>nozeli_supervisor::inputLimit)
      throw Failure("SUPERVISOR_INPUT_RANGE","Expected a bounded input byte offset");
    std::vector<BYTE> bytes;const auto reply=SupervisorRequest(pin,nozeli_supervisor::Operation::readInput,0,static_cast<uint64_t>(offset),&bytes);
    if(bytes.empty()&&reply.inputError)throw Failure("SUPERVISOR_INPUT_UNCONFIRMED","Original stdin transfer incomplete; no replay",reply.inputError);
    napi_value result;Check(napi_create_object(env,&result));
    Text(env,result,"state",!bytes.empty()?"data":reply.inputClosed?"eof":"pending");
    if(!bytes.empty()){napi_value buffer;Check(napi_create_buffer_copy(env,bytes.size(),bytes.data(),nullptr,&buffer));Check(napi_set_named_property(env,result,"bytes",buffer));}
    return result;
  });
}
napi_value SupervisorInputResult(napi_env env,SupervisorPin* pin,const nozeli_supervisor::Reply& reply){
  if(reply.inputError||reply.inputBytes!=pin->inputOffset+pin->inputActiveBytes||reply.inputCompletedBytes>reply.inputBytes)
    throw Failure("SUPERVISOR_INPUT_UNCONFIRMED","Input admission/completion differs from the original operation",reply.inputError);
  const bool completed=!reply.inputPending&&reply.inputCompletedBytes==reply.inputBytes;
  napi_value result;Check(napi_create_object(env,&result));Text(env,result,"state",completed?"complete":"pending");
  if(completed){Number(env,result,"bytes",pin->inputActiveBytes);pin->inputOffset+=pin->inputActiveBytes;pin->inputActiveBytes=0;pin->inputActive=false;}
  return result;
}
napi_value SupervisorWriteInput(napi_env env,napi_callback_info info){
  return Guard(env,[&]{auto* pin=SupervisorReceiver(env,info);
    if(!pin->inputEnabled)throw Failure("SUPERVISOR_INPUT_UNAVAILABLE","No original stdin custody");
    if(pin->inputFailed||pin->inputActive)throw Failure("SUPERVISOR_INPUT_UNCONFIRMED","Outstanding or UNKNOWN input cannot be resent");
    size_t count=2;napi_value args[2];Check(napi_get_cb_info(env,info,&count,args,nullptr,nullptr));bool buffer=false;
    if(count==1)Check(napi_is_buffer(env,args[0],&buffer));
    if(!buffer)throw Failure("SUPERVISOR_INPUT_RANGE","One bounded Buffer required");
    void* data=nullptr;size_t size=0;Check(napi_get_buffer_info(env,args[0],&data,&size));
    if(!size||size>nozeli_supervisor::outputChunk)throw Failure("SUPERVISOR_INPUT_RANGE","Expected 1..65536 input bytes");
    pin->inputActive=true;pin->inputActiveBytes=static_cast<uint32_t>(size);
    try{return SupervisorInputResult(env,pin,SupervisorRequest(pin,nozeli_supervisor::Operation::writeInput,0,pin->inputOffset,nullptr,static_cast<BYTE*>(data),static_cast<uint32_t>(size)));}
    catch(...){pin->inputFailed=true;throw;}
  });
}
napi_value SupervisorPollInput(napi_env env,napi_callback_info info){
  return Guard(env,[&]{auto* pin=SupervisorReceiver(env,info);
    if(pin->inputFailed||!pin->inputActive)throw Failure("SUPERVISOR_INPUT_UNCONFIRMED","No retained pending input operation");
    try{return SupervisorInputResult(env,pin,SupervisorRequest(pin,nozeli_supervisor::Operation::pollInput,0,pin->inputOffset));}
    catch(...){pin->inputFailed=true;throw;}
  });
}
napi_value SupervisorCloseInput(napi_env env,napi_callback_info info){
  return Guard(env,[&]{auto* pin=SupervisorReceiver(env,info);
    if(pin->inputFailed||pin->inputActive)throw Failure("SUPERVISOR_INPUT_UNCONFIRMED","Input must complete before close");
    SupervisorRequest(pin,nozeli_supervisor::Operation::closeInput);napi_value result;Check(napi_get_undefined(env,&result));return result;
  });
}
napi_value SupervisorAbortInput(napi_env env,napi_callback_info info){
  return Guard(env,[&]{auto* pin=SupervisorReceiver(env,info);SupervisorRequest(pin,nozeli_supervisor::Operation::abortInput);
    pin->inputActive=false;pin->inputFailed=true;napi_value result;Check(napi_get_undefined(env,&result));return result;
  });
}
napi_value SupervisorObject(napi_env env,std::unique_ptr<SupervisorPin> pin) {
  napi_value result,value;Check(napi_create_object(env,&result));Check(napi_type_tag_object(env,result,&supervisorTag));
  Check(napi_create_string_utf16(env,reinterpret_cast<const char16_t*>(pin->pipe.data()),pin->pipe.size(),&value));Check(napi_set_named_property(env,result,"pipe",value));
  Number(env,result,"supervisorPid",pin->pid);Text(env,result,"supervisorCreationTime100ns",std::to_string(pin->creation));
  Number(env,result,"hostPid",pin->hostPid);Text(env,result,"hostCreationTime100ns",std::to_string(pin->hostCreation));
  Number(env,result,"leaderPid",pin->leaderPid);Text(env,result,"leaderCreationTime100ns",std::to_string(pin->leaderCreation));
  Text(env,result,"helperFileIdentity",pin->imageIdentity);
  std::string custodyDigest;const char* hex="0123456789abcdef";
  for(auto byte:pin->custodySha256){custodyDigest+=hex[byte>>4];custodyDigest+=hex[byte&15];}
  Text(env,result,"custodySha256",custodyDigest);Number(env,result,"custodyEntityCount",pin->custodyCount);
  Number(env,result,"custodyRoles",pin->custodyRoles);
  Text(env,result,"ownerHomeIdentity",pin->ownerHomeIdentity);
  std::string sourceDigest;
  for(auto byte:pin->sourceSha256){sourceDigest+=hex[byte>>4];sourceDigest+=hex[byte&15];}
  Text(env,result,"sourceSha256",sourceDigest);
  Boolean(env,result,"outputCustodyVerified",pin->outputEnabled);
  Boolean(env,result,"inputCustodyVerified",pin->inputEnabled);
  napi_property_descriptor methods[]={
    {"snapshot",nullptr,SupervisorSnapshot,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"shutdown",nullptr,SupervisorShutdown,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"observeExit",nullptr,SupervisorObserveExit,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"claimColdAnchor",nullptr,SupervisorClaimColdAnchor,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"close",nullptr,SupervisorClose,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"readOutput",nullptr,SupervisorReadOutput,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"readInput",nullptr,SupervisorReadInput,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"writeInput",nullptr,SupervisorWriteInput,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"pollInput",nullptr,SupervisorPollInput,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"closeInput",nullptr,SupervisorCloseInput,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"abortInput",nullptr,SupervisorAbortInput,nullptr,nullptr,nullptr,napi_default,nullptr}};
  Check(napi_define_properties(env,result,10,methods));
  Check(napi_wrap(env,result,pin.get(),[](napi_env,void* data,void*){delete static_cast<SupervisorPin*>(data);},nullptr,nullptr));pin.release();return result;
}
napi_value StartSupervisor(napi_env env,napi_callback_info info) {
  return Guard(env,[&]{
    size_t count=4;napi_value args[4];Check(napi_get_cb_info(env,info,&count,args,nullptr,nullptr));
    if(count<1||count>3)throw Failure("SUPERVISOR_SPEC_INVALID","Expected original prepared Job and optional native custody bundle");
    nozeli_custody::Bundle* custody=nullptr;
    if(count>=2){
      napi_valuetype type;Check(napi_typeof(env,args[1],&type));bool tagged=false;
      if(type==napi_object)Check(napi_check_object_type_tag(env,args[1],&nozeli_custody::tag,&tagged));
      if(!tagged)throw Failure("CUSTODY_SPEC_INVALID","Original native custody bundle required");
      Check(napi_unwrap(env,args[1],reinterpret_cast<void**>(&custody)));
      custody->Verify();if(custody->consumed)throw Failure("CUSTODY_TRANSFER_REFUSED","Custody handoff cannot be retried");
    }
    LaunchClaim* claim=nullptr;
    if(count==3){
      claim=LaunchReceiver<LaunchClaim>(env,args[2],launchClaimTag);VerifyLaunchSet(*claim->set);
      if(claim->attempted||!custody||(nozeli_custody::Roles(*custody->manifest)&31)!=31||memcmp(claim->set->view->sourceSha256,custody->manifest->sourceSha256,32))
        throw Failure("HOST_LAUNCH_SET_UNVERIFIED","Unused original launch claim and complete matching source custody required");
      claim->attempted=true;
    }
    bool tagged=false;napi_valuetype type;Check(napi_typeof(env,args[0],&type));
    if(type==napi_object)Check(napi_check_object_type_tag(env,args[0],&jobTag,&tagged));if(!tagged)throw Failure("SUPERVISOR_SPEC_INVALID","Expected original native Job");
    JobPin* owner=nullptr;Check(napi_unwrap(env,args[0],reinterpret_cast<void**>(&owner)));const auto facts=InspectJob(owner);
    if(owner->supervisionAttempted||owner->resumed||owner->terminationRequested||facts.wait==WAIT_OBJECT_0)throw Failure("SUPERVISOR_START_REFUSED","Supervision must precede first owner resume and cannot be retried");
    owner->supervisionAttempted=true;
    if(custody)custody->consumed=true;
    const auto image=SupervisorImage();IoHandle executable;executable.value=CreateFileW(image.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
    BY_HANDLE_FILE_INFORMATION fi{};
    if(executable.value==INVALID_HANDLE_VALUE||!GetFileInformationByHandle(executable.value,&fi)||fi.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)||fi.nNumberOfLinks!=1)
      throw Failure("SUPERVISOR_IMAGE_UNVERIFIED","Fixed supervisor executable must be a pinned ordinary single-link file",GetLastError());
    auto pin=std::make_unique<SupervisorPin>();pin->imageIdentity=SupervisorFileIdentity(executable.value);pin->image.value=executable.value;executable.value=INVALID_HANDLE_VALUE;
    pin->hostPid=GetCurrentProcessId();pin->hostCreation=ProcessCreation(GetCurrentProcess());
    pin->leaderPid=owner->process.dwProcessId;pin->leaderCreation=owner->creation;
    // Single-consumer port handoff: stop this owner's collector so only the
    // helper drains the Job completion port from now on. Only the suspended
    // leader exists, so no observable notification can be split meanwhile.
    nozeli_members::StopCollector(owner->notifications);
    struct RestoreCollector {
      JobPin* owner;bool dismissed=false;
      ~RestoreCollector(){
        if(dismissed)return;
        if(owner->factsView){UnmapViewOfFile(owner->factsView);owner->factsView=nullptr;}
        if(owner->factsMapping){CloseHandle(owner->factsMapping);owner->factsMapping=nullptr;}
        nozeli_members::StartCollector(owner->notifications);
      }
    } restore{owner};
    BYTE nonce[32];if(BCryptGenRandom(nullptr,nonce,sizeof(nonce),BCRYPT_USE_SYSTEM_PREFERRED_RNG)!=0)throw Failure("SUPERVISOR_CREATE_FAILED","Cannot allocate supervisor endpoint nonce");
    pin->pipe=L"\\\\.\\pipe\\nozeli-supervisor-";const wchar_t* digits=L"0123456789abcdef";for(auto b:nonce){pin->pipe+=digits[b>>4];pin->pipe+=digits[b&15];}
    IoHandle job,leader,host,ready,outputs[2],input;
    if(!DuplicateHandle(GetCurrentProcess(),owner->job,GetCurrentProcess(),&job.value,JOB_OBJECT_QUERY|JOB_OBJECT_TERMINATE,TRUE,0)||
       !DuplicateHandle(GetCurrentProcess(),owner->process.hProcess,GetCurrentProcess(),&leader.value,PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,TRUE,0)||
       !DuplicateHandle(GetCurrentProcess(),GetCurrentProcess(),GetCurrentProcess(),&host.value,PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,TRUE,0))
      throw Failure("SUPERVISOR_CREATE_FAILED","Cannot retain original kernel objects",GetLastError());
    SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};ready.value=CreateEventW(&security,TRUE,FALSE,nullptr);
    if(!ready.value)throw Failure("SUPERVISOR_CREATE_FAILED","Cannot allocate startup acknowledgement",GetLastError());
    std::vector<HANDLE> inherited={job.value,leader.value,host.value,ready.value};
    if(owner->stdio){
      auto* io=owner->stdio.get();
      if(io->outputTransferred)throw Failure("SUPERVISOR_OUTPUT_UNVERIFIED","Output custody cannot be handed off twice");
      ProcessPipe* pipes[]={&io->output,&io->error};
      for(size_t i=0;i<2;i++){
        if(pipes[i]->pending||pipes[i]->eof||!pipes[i]->buffer.empty()||pipes[i]->parent.value==INVALID_HANDLE_VALUE)
          throw Failure("SUPERVISOR_OUTPUT_UNVERIFIED","Output must be transferred before its first read");
        if(!DuplicateHandle(GetCurrentProcess(),pipes[i]->parent.value,GetCurrentProcess(),&outputs[i].value,0,TRUE,DUPLICATE_SAME_ACCESS))
          throw Failure("SUPERVISOR_OUTPUT_UNVERIFIED","Cannot transfer original output endpoint",GetLastError());
        inherited.push_back(outputs[i].value);
      }
      if(io->inputTransferred||io->input.pending||!io->input.buffer.empty()||io->input.parent.value==INVALID_HANDLE_VALUE)
        throw Failure("SUPERVISOR_INPUT_UNVERIFIED","Input must transfer before its first write or close");
      if(!DuplicateHandle(GetCurrentProcess(),io->input.parent.value,GetCurrentProcess(),&input.value,0,TRUE,DUPLICATE_SAME_ACCESS))
        throw Failure("SUPERVISOR_INPUT_UNVERIFIED","Cannot transfer original input endpoint",GetLastError());
      inherited.push_back(input.value);io->inputTransferred=true;pin->inputEnabled=true;
      io->outputTransferred=true;pin->outputEnabled=true;
    }
    std::vector<std::unique_ptr<IoHandle>> custodyHandles;IoHandle mapping;
    if(custody){
      auto manifest=std::make_unique<nozeli_custody::Manifest>(*custody->manifest);
      nozeli_custody::Digest(*manifest,pin->custodySha256);pin->custodyCount=manifest->count;
      pin->custodyRoles=nozeli_custody::Roles(*manifest);
      memcpy(pin->sourceSha256,manifest->sourceSha256,32);
      pin->ownerHomeIdentity=nozeli_custody::OwnerHomeIdentity(*manifest);
      for(uint32_t i=0;i<manifest->count;i++){
        auto duplicate=std::make_unique<IoHandle>();
        if(!DuplicateHandle(GetCurrentProcess(),reinterpret_cast<HANDLE>(manifest->frames[i].handle),GetCurrentProcess(),&duplicate->value,0,TRUE,DUPLICATE_SAME_ACCESS))
          throw Failure("CUSTODY_TRANSFER_FAILED","Cannot prepare restricted inherited custody",GetLastError());
        manifest->frames[i].handle=reinterpret_cast<uint64_t>(duplicate->value);inherited.push_back(duplicate->value);custodyHandles.push_back(std::move(duplicate));
      }
      IoHandle writable;writable.value=CreateFileMappingW(INVALID_HANDLE_VALUE,nullptr,PAGE_READWRITE,0,sizeof(*manifest),nullptr);
      if(!writable.value)throw Failure("CUSTODY_TRANSFER_FAILED","Cannot allocate bounded custody handoff",GetLastError());
      void* view=MapViewOfFile(writable.value,FILE_MAP_WRITE,0,0,sizeof(*manifest));
      if(!view)throw Failure("CUSTODY_TRANSFER_FAILED","Cannot map custody handoff",GetLastError());
      memcpy(view,manifest.get(),sizeof(*manifest));UnmapViewOfFile(view);
      if(!DuplicateHandle(GetCurrentProcess(),writable.value,GetCurrentProcess(),&mapping.value,FILE_MAP_READ,TRUE,0))
        throw Failure("CUSTODY_TRANSFER_FAILED","Cannot restrict custody manifest to read-only",GetLastError());
      inherited.push_back(mapping.value);
    }
    IoHandle launchMapping;
    if(claim){
      if(!DuplicateHandle(GetCurrentProcess(),claim->set->mapping.value,GetCurrentProcess(),&launchMapping.value,FILE_MAP_READ|FILE_MAP_WRITE,TRUE,0))
        throw Failure("HOST_LAUNCH_SET_CREATE_FAILED","Cannot retain helper-only cold arbitration mapping",GetLastError());
      inherited.push_back(launchMapping.value);
    }
    IoHandle factsPort,factsSection;
    factsSection.value=CreateFileMappingW(INVALID_HANDLE_VALUE,nullptr,PAGE_READWRITE,0,static_cast<DWORD>(sizeof(nozeli_members::MemberFacts)),nullptr);
    if(!factsSection.value)throw Failure("SUPERVISOR_CREATE_FAILED","Cannot allocate member facts section",GetLastError());
    // The stopped owner's consumed NEW_PROCESS count and sticky refusal must
    // reach the helper exactly once: seed the section before the spawn so the
    // helper's collector continues the same monotonic announced counter and
    // refusal state instead of restarting from zero.
    {
      auto* seed=static_cast<nozeli_members::MemberFacts*>(MapViewOfFile(factsSection.value,FILE_MAP_WRITE,0,0,sizeof(nozeli_members::MemberFacts)));
      if(!seed){const DWORD error=GetLastError();throw Failure("SUPERVISOR_CREATE_FAILED","Cannot map member facts seed",error);}
      nozeli_members::PublishFacts(seed,owner->members,owner->memberAnnounced,owner->memberError);
      UnmapViewOfFile(seed);
    }
    owner->factsView=static_cast<nozeli_members::MemberFacts*>(MapViewOfFile(factsSection.value,FILE_MAP_READ,0,0,sizeof(nozeli_members::MemberFacts)));
    if(!owner->factsView){const DWORD error=GetLastError();throw Failure("SUPERVISOR_CREATE_FAILED","Cannot map member facts section",error);}
    owner->factsMapping=factsSection.value;factsSection.value=INVALID_HANDLE_VALUE;
    if(!DuplicateHandle(GetCurrentProcess(),owner->factsMapping,GetCurrentProcess(),&factsSection.value,FILE_MAP_READ|FILE_MAP_WRITE,TRUE,0)||
       !DuplicateHandle(GetCurrentProcess(),owner->notifications.port,GetCurrentProcess(),&factsPort.value,0,TRUE,DUPLICATE_SAME_ACCESS))
      throw Failure("SUPERVISOR_CREATE_FAILED","Cannot transfer member notification custody",GetLastError());
    inherited.push_back(factsPort.value);inherited.push_back(factsSection.value);
    AttributeList attributes;
    if(!UpdateProcThreadAttribute(attributes.value,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited.data(),inherited.size()*sizeof(HANDLE),nullptr,nullptr))
      throw Failure("SUPERVISOR_CREATE_FAILED","Cannot restrict supervisor HANDLE inheritance",GetLastError());
    auto line=QuoteArgument(image);for(size_t i=0;i<4;i++)line+=L" "+std::to_wstring(reinterpret_cast<uint64_t>(inherited[i]));
    line+=L" "+QuoteArgument(pin->pipe)+L" "+std::to_wstring(mapping.value==INVALID_HANDLE_VALUE?0:reinterpret_cast<uint64_t>(mapping.value));
    for(const auto& output:outputs)line+=L" "+std::to_wstring(output.value==INVALID_HANDLE_VALUE?0:reinterpret_cast<uint64_t>(output.value));
    line+=L" "+std::to_wstring(input.value==INVALID_HANDLE_VALUE?0:reinterpret_cast<uint64_t>(input.value));
    line+=L" "+std::to_wstring(launchMapping.value==INVALID_HANDLE_VALUE?0:reinterpret_cast<uint64_t>(launchMapping.value));
    line+=L" "+std::to_wstring(reinterpret_cast<uint64_t>(factsPort.value))+L" "+std::to_wstring(reinterpret_cast<uint64_t>(factsSection.value));
    std::vector<wchar_t> command(line.begin(),line.end());command.push_back(0);
    std::vector<wchar_t> system(32768);DWORD length=GetWindowsDirectoryW(system.data(),static_cast<UINT>(system.size()));
    if(!length||length>=system.size())throw Failure("SUPERVISOR_CREATE_FAILED","Cannot construct explicit supervisor environment",GetLastError());
    std::wstring environment=L"SystemRoot="+std::wstring(system.data(),length);environment.push_back(0);environment.push_back(0);
    STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.lpAttributeList=attributes.value;
    PROCESS_INFORMATION child{};const auto cwd=image.substr(0,image.find_last_of(L'\\'));
    if(!CreateProcessW(image.c_str(),command.data(),nullptr,nullptr,TRUE,EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW,
        environment.data(),cwd.c_str(),&startup.StartupInfo,&child))throw Failure("SUPERVISOR_CREATE_FAILED","Cannot start native supervisor",GetLastError());
    pin->process.value=child.hProcess;CloseHandle(child.hThread);pin->pid=child.dwProcessId;
    try{
      pin->creation=ProcessCreation(child.hProcess);
      if(claim){
        auto& entry=claim->set->view->entries[claim->index];entry.leaderPid=pin->leaderPid;entry.leaderCreation=pin->leaderCreation;
        entry.supervisorPid=pin->pid;entry.supervisorCreation=pin->creation;MemoryBarrier();InterlockedExchange(reinterpret_cast<volatile LONG*>(&entry.prepared),1);
      }
      HANDLE waits[]={ready.value,child.hProcess};if(WaitForMultipleObjects(2,waits,FALSE,3000)!=WAIT_OBJECT_0)throw Failure("SUPERVISOR_START_UNVERIFIED","Supervisor failed to acknowledge inherited custody");
      ObserveSupervisor(pin.get(),owner);
      if(owner->stdio){owner->stdio->input.Abort();owner->stdio->output.Abort();owner->stdio->error.Abort();}
      // Compare the actual kernel Job objects, not only leader/PID strings.
      using Compare=BOOL(WINAPI*)(HANDLE,HANDLE);const auto compare=reinterpret_cast<Compare>(GetProcAddress(GetModuleHandleW(L"kernelbase.dll"),"CompareObjectHandles"));
      if(!compare||!compare(owner->job,pin->observed->job))throw Failure("SUPERVISOR_IDENTITY_UNVERIFIED","Supervisor did not retain the original Job object");
      restore.dismissed=true; // From here the running helper solely drains notifications.
      IoHandle cleanup;
      if(!DuplicateHandle(GetCurrentProcess(),pin->process.value,GetCurrentProcess(),&cleanup.value,PROCESS_TERMINATE|SYNCHRONIZE,FALSE,0))
        throw Failure("SUPERVISOR_CREATE_FAILED","Cannot retain supervisor publication cleanup",GetLastError());
      try{return SupervisorObject(env,std::move(pin));}
      catch(...){TerminateProcess(cleanup.value,0xe0000003);WaitForSingleObject(cleanup.value,3000);throw;}
    }catch(...){if(pin&&pin->process.value!=INVALID_HANDLE_VALUE){TerminateProcess(pin->process.value,0xe0000003);WaitForSingleObject(pin->process.value,3000);}
      if(restore.dismissed){ // The helper above is terminated and awaited.
        if(owner->factsView){UnmapViewOfFile(owner->factsView);owner->factsView=nullptr;}
        if(owner->factsMapping){CloseHandle(owner->factsMapping);owner->factsMapping=nullptr;}
        nozeli_members::StartCollector(owner->notifications);
      }throw;}
  });
}
napi_value ConnectSupervisor(napi_env env,napi_callback_info info) {
  return Guard(env,[&]{
    size_t count=16;napi_value args[16];Check(napi_get_cb_info(env,info,&count,args,nullptr,nullptr));
    if(count!=15)throw Failure("SUPERVISOR_SPEC_INVALID","Expected endpoint, home/input/output/source custody, helper entity and three complete process incarnations");
    auto pin=std::make_unique<SupervisorPin>();pin->pipe=JobString(env,args[0]);const std::wstring prefix=L"\\\\.\\pipe\\nozeli-supervisor-";
    napi_valuetype outputType;Check(napi_typeof(env,args[12],&outputType));
    if(outputType!=napi_boolean)throw Failure("SUPERVISOR_SPEC_INVALID","Expected original output custody mode");
    Check(napi_get_value_bool(env,args[12],&pin->outputEnabled));
    napi_valuetype inputType;Check(napi_typeof(env,args[13],&inputType));
    if(inputType!=napi_boolean)throw Failure("SUPERVISOR_SPEC_INVALID","Expected original stdin custody mode");
    Check(napi_get_value_bool(env,args[13],&pin->inputEnabled));
    napi_valuetype custodyType;Check(napi_typeof(env,args[8],&custodyType));double expectedCount=0;
    if(custodyType==napi_number)Check(napi_get_value_double(env,args[8],&expectedCount));
    if(custodyType!=napi_number||!std::isfinite(expectedCount)||expectedCount<0||expectedCount>nozeli_custody::limit||std::floor(expectedCount)!=expectedCount)
      throw Failure("CUSTODY_SPEC_INVALID","Invalid expected custody count");
    pin->custodyCount=static_cast<uint32_t>(expectedCount);const auto custodyHash=JobString(env,args[9]);
    if(pin->custodyCount>nozeli_custody::limit||custodyHash.size()!=64||custodyHash.find_first_not_of(L"0123456789abcdef")!=std::wstring::npos)
      throw Failure("CUSTODY_SPEC_INVALID","Invalid expected custody digest");
    const std::wstring hex=L"0123456789abcdef";
    for(size_t i=0;i<32;i++)pin->custodySha256[i]=static_cast<BYTE>(hex.find(custodyHash[i*2])*16+hex.find(custodyHash[i*2+1]));
    napi_valuetype rolesType;Check(napi_typeof(env,args[10],&rolesType));double roles=0;
    if(rolesType==napi_number)Check(napi_get_value_double(env,args[10],&roles));
    if(rolesType!=napi_number||(roles!=0&&roles!=3&&roles!=31&&roles!=63)||(pin->custodyCount==0)!=(roles==0))
      throw Failure("CUSTODY_SPEC_INVALID","Expected empty, host-pair or complete source custody roles");
    pin->custodyRoles=static_cast<uint32_t>(roles);
    const auto sourceHash=JobString(env,args[11]);
    if(sourceHash.size()!=64||sourceHash.find_first_not_of(hex)!=std::wstring::npos||((sourceHash==std::wstring(64,L'0'))!=((pin->custodyRoles&31)!=31)))
      throw Failure("CUSTODY_SPEC_INVALID","Source digest must bind complete source custody");
    for(size_t i=0;i<32;i++)pin->sourceSha256[i]=static_cast<BYTE>(hex.find(sourceHash[i*2])*16+hex.find(sourceHash[i*2+1]));
    const auto home=JobString(env,args[14]);
    if(roles==63){
      if(home.size()!=49||home[16]!=L':'||home.substr(0,16).find_first_not_of(hex)!=std::wstring::npos||home.substr(17).find_first_not_of(hex)!=std::wstring::npos)
        throw Failure("CUSTODY_SPEC_INVALID","Exact owner home directory identity required");
    }else if(!home.empty())throw Failure("CUSTODY_SPEC_INVALID","Home identity requires original directory custody");
    pin->ownerHomeIdentity=std::string(home.begin(),home.end());
    if(pin->pipe.rfind(prefix,0)!=0||pin->pipe.size()!=prefix.size()+64||pin->pipe.find_first_not_of(L"0123456789abcdef",prefix.size())!=std::wstring::npos)
      throw Failure("SUPERVISOR_SPEC_INVALID","Invalid fixed supervisor endpoint");
    DWORD* ids[]={&pin->pid,&pin->hostPid,&pin->leaderPid};ULONGLONG* times[]={&pin->creation,&pin->hostCreation,&pin->leaderCreation};
    for(size_t i=0;i<3;i++){
      napi_valuetype type;Check(napi_typeof(env,args[i*2+1],&type));double value=0;if(type==napi_number)Check(napi_get_value_double(env,args[i*2+1],&value));
      if(type!=napi_number||value<1||value>0xffffffff||std::floor(value)!=value)throw Failure("SUPERVISOR_SPEC_INVALID","Invalid process incarnation PID");
      *ids[i]=static_cast<DWORD>(value);const auto text=JobString(env,args[i*2+2]);wchar_t* end=nullptr;
      if(text.empty()||text.size()>20||text.find_first_not_of(L"0123456789")!=std::wstring::npos||text[0]==L'0')throw Failure("SUPERVISOR_SPEC_INVALID","Invalid process creation time");
      *times[i]=_wcstoui64(text.c_str(),&end,10);if(!*times[i]||!end||*end||std::to_wstring(*times[i])!=text)throw Failure("SUPERVISOR_SPEC_INVALID","Invalid process creation time");
    }
    const auto expected=JobString(env,args[7]);const auto image=SupervisorImage();
    pin->image.value=CreateFileW(image.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
    if(pin->image.value==INVALID_HANDLE_VALUE)throw Failure("SUPERVISOR_IMAGE_UNVERIFIED","Cannot pin the fixed supervisor runtime",GetLastError());
    pin->imageIdentity=SupervisorFileIdentity(pin->image.value);
    if(std::wstring(pin->imageIdentity.begin(),pin->imageIdentity.end())!=expected)throw Failure("SUPERVISOR_IMAGE_UNVERIFIED","Supervisor runtime entity differs from the original endpoint");
    pin->process.value=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,pin->pid);
    if(!pin->process.value)throw Failure("SUPERVISOR_IDENTITY_UNVERIFIED","Cannot retain original supervisor process",GetLastError());
    ObserveSupervisor(pin.get());return SupervisorObject(env,std::move(pin));
  });
}
void InitSupervisorBindings(napi_env env,napi_value exports){
  napi_value value;Check(napi_create_function(env,"startProcessSupervisor",NAPI_AUTO_LENGTH,StartSupervisor,nullptr,&value));Check(napi_set_named_property(env,exports,"startProcessSupervisor",value));
  Check(napi_create_function(env,"connectProcessSupervisor",NAPI_AUTO_LENGTH,ConnectSupervisor,nullptr,&value));Check(napi_set_named_property(env,exports,"connectProcessSupervisor",value));
}
