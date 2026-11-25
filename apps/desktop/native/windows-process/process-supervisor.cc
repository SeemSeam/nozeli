// Native custody only. Owns original inherited kernel objects, never PID-based
// Job reconstruction. No runtime config, shell, ambient profile or model calls.
#include <windows.h>
#include <sddl.h>
#include <string>
#include <vector>
#include "supervisor-protocol.h"
#include "supervisor-output.h"
#include "supervisor-input.h"
#include "process-members.h"
#include "host-launch-set.h"
#include "../windows/custody-transfer.h"
using namespace nozeli_supervisor;
struct Handle { HANDLE value=nullptr; explicit Handle(HANDLE h=nullptr):value(h){} ~Handle(){if(value&&value!=INVALID_HANDLE_VALUE)CloseHandle(value);} };
HANDLE Decode(const wchar_t* text){wchar_t* end=nullptr;const auto n=_wcstoui64(text,&end,10);return n&&end&&!*end?reinterpret_cast<HANDLE>(n):nullptr;}
bool SameUser(HANDLE peer) {
  Handle a,b;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&a.value)||!OpenProcessToken(peer,TOKEN_QUERY,&b.value))return false;
  DWORD sa=0,sb=0;GetTokenInformation(a.value,TokenUser,nullptr,0,&sa);GetTokenInformation(b.value,TokenUser,nullptr,0,&sb);
  if(!sa||!sb||sa>65536||sb>65536)return false;
  std::vector<BYTE> ba(sa),bb(sb);
  return GetTokenInformation(a.value,TokenUser,ba.data(),sa,&sa)&&GetTokenInformation(b.value,TokenUser,bb.data(),sb,&sb)&&
    EqualSid(reinterpret_cast<TOKEN_USER*>(ba.data())->User.Sid,reinterpret_cast<TOKEN_USER*>(bb.data())->User.Sid);
}
int wmain(int count,wchar_t** args) {
  if(count!=13)return 90;
  Handle job(Decode(args[1])),leader(Decode(args[2])),host(Decode(args[3])),ready(Decode(args[4])),port(Decode(args[11])),facts(Decode(args[12]));
  std::vector<wchar_t> ownPath(32768);const auto ownSize=GetModuleFileNameW(nullptr,ownPath.data(),static_cast<DWORD>(ownPath.size()));
  if(!ownSize||ownSize>=ownPath.size())return 91;
  Handle ownImage(CreateFileW(ownPath.data(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
  if(ownImage.value==INVALID_HANDLE_VALUE)return 91;
  const std::wstring name=args[5];
  const std::wstring prefix=L"\\\\.\\pipe\\nozeli-supervisor-";
  if(!job.value||!leader.value||!host.value||!ready.value||!port.value||!facts.value||name.rfind(prefix,0)!=0||name.size()!=prefix.size()+64)return 91;
  for(auto h:{job.value,leader.value,host.value,ready.value,port.value,facts.value})if(!SetHandleInformation(h,HANDLE_FLAG_INHERIT,0))return 92;
  Handle launchSet(Decode(args[10]));
  if(launchSet.value&&!SetHandleInformation(launchSet.value,HANDLE_FLAG_INHERIT,0))return 92;
  auto* factsView=static_cast<nozeli_members::MemberFacts*>(MapViewOfFile(facts.value,FILE_MAP_WRITE,0,0,sizeof(nozeli_members::MemberFacts)));
  if(!factsView)return 92;
  Handle mapping(Decode(args[6]));
  OutputCustody output;
  if(!output.Initialize(Decode(args[7]),Decode(args[8])))return 92;
  InputCustody input;if(!input.Initialize(Decode(args[9]))||input.enabled!=output.enabled)return 92;
  std::unique_ptr<nozeli_custody::Manifest> custody;
  std::vector<std::unique_ptr<Handle>> custodyHandles;
  BYTE custodyHash[32]{};
  if(mapping.value){
    if(!SetHandleInformation(mapping.value,HANDLE_FLAG_INHERIT,0))return 92;
    const void* view=MapViewOfFile(mapping.value,FILE_MAP_READ,0,0,sizeof(nozeli_custody::Manifest));
    if(!view)return 92;
    custody=std::make_unique<nozeli_custody::Manifest>();memcpy(custody.get(),view,sizeof(*custody));UnmapViewOfFile(view);
    if(custody->count>nozeli_custody::limit)return 92;
    try{
      for(uint32_t i=0;i<custody->count;i++){
        const auto h=reinterpret_cast<HANDLE>(custody->frames[i].handle);
        if(!SetHandleInformation(h,HANDLE_FLAG_INHERIT,0))return 92;
        custodyHandles.push_back(std::make_unique<Handle>(h));
      }
      nozeli_custody::Verify(*custody);nozeli_custody::Digest(*custody,custodyHash);
    }catch(...){return 92;}
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};BOOL member=FALSE;
  if(!QueryInformationJobObject(job.value,JobObjectExtendedLimitInformation,&limits,sizeof(limits),nullptr)||
     limits.BasicLimitInformation.LimitFlags!=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE||
     !IsProcessInJob(leader.value,job.value,&member)||!member||GetProcessId(host.value)==GetCurrentProcessId())return 93;
  Handle token;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token.value))return 94;
  DWORD size=0;GetTokenInformation(token.value,TokenUser,nullptr,0,&size);if(!size||size>65536)return 94;
  std::vector<BYTE> bytes(size);if(!GetTokenInformation(token.value,TokenUser,bytes.data(),size,&size))return 94;
  LPWSTR sid=nullptr;if(!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid,&sid))return 94;
  const std::wstring sddl=L"D:P(A;;GA;;;"+std::wstring(sid)+L")";LocalFree(sid);
  PSECURITY_DESCRIPTOR descriptor=nullptr;
  if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),SDDL_REVISION_1,&descriptor,nullptr))return 94;
  SECURITY_ATTRIBUTES security{sizeof(security),descriptor,FALSE};
  Handle pipe(CreateNamedPipeW(name.c_str(),PIPE_ACCESS_DUPLEX|FILE_FLAG_OVERLAPPED|FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_MESSAGE|PIPE_READMODE_MESSAGE|PIPE_WAIT|PIPE_REJECT_REMOTE_CLIENTS,1,4096,4096,0,&security));LocalFree(descriptor);
  if(pipe.value==INVALID_HANDLE_VALUE)return 95;
  bool hostDead=false;
  // Keep process HANDLEs in the original helper, including members which exit
  // before any cold observer connects. Job accounting alone is insufficient.
  struct Members {
    std::vector<nozeli_members::Member> values;
    SRWLOCK lock{};
    ULONGLONG announced=0;
    DWORD error=0;
  } members;
  // This helper solely drains the Job completion port from before the ready
  // acknowledgement (so before any child resumes) for its whole lifetime.
  nozeli_members::Notifications notifications{&members.lock,&members.values,&members.announced,&members.error,port.value,job.value,nullptr,GetProcessId(leader.value)};
  struct CollectorGuard {
    nozeli_members::Notifications* state;
    ~CollectorGuard(){nozeli_members::StopCollector(*state);}
  } collector{&notifications};
  {
    // Adopt the stopped owner's transferred announced count and sticky refusal
    // before this helper's collector starts, so every kernel NEW_PROCESS is
    // counted exactly once across the ownership handoff.
    std::vector<nozeli_members::MemberFact> seed;ULONGLONG seedAnnounced=0;DWORD seedError=0;
    if(!nozeli_members::ReadFacts(factsView,seed,seedAnnounced,seedError))return 92;
    members.announced=seedAnnounced;members.error=seedError;
  }
  if(!nozeli_members::StartCollector(notifications))return 99;
  const auto captureMembers=[&](){
    AcquireSRWLockExclusive(&members.lock);
    if(!members.error){
      try{nozeli_members::Observe(job.value,GetProcessId(leader.value),members.values);}
      catch(const nozeli_members::Failure& error){members.error=error.windows;}
      catch(...){members.error=ERROR_NOT_ENOUGH_MEMORY;}
    }
    nozeli_members::PublishFacts(factsView,members.values,members.announced,members.error);
    ReleaseSRWLockExclusive(&members.lock);
  };
  const auto checkHost=[&](){
    captureMembers();
    output.Pump(job.value);
    input.Pump(job.value);
    const DWORD state=WaitForSingleObject(host.value,0);
    if(state==WAIT_OBJECT_0){if(hostDead)return true;if(!TerminateJobObject(job.value,0xe0000002))return false;input.Close(true);hostDead=true;return true;}
    if(WaitForSingleObject(leader.value,0)==WAIT_OBJECT_0)input.Close(true);
    return state==WAIT_TIMEOUT;
  };
  if(!checkHost()||!SetEvent(ready.value))return 96;
  CloseHandle(ready.value);ready.value=nullptr;
  unsigned inspections=0;bool custodyFenced=false;
  for(;;){
    Handle event(CreateEventW(nullptr,TRUE,FALSE,nullptr));if(!event.value)return 97;
    OVERLAPPED connection{};connection.hEvent=event.value;
    BOOL connected=ConnectNamedPipe(pipe.value,&connection);
    const DWORD error=connected?ERROR_SUCCESS:GetLastError();
    if(!connected&&error==ERROR_IO_PENDING){
      for(;;){
        if(!checkHost()){CancelIoEx(pipe.value,&connection);DWORD ignored;GetOverlappedResult(pipe.value,&connection,&ignored,TRUE);return 98;}
        const DWORD wait=WaitForSingleObject(event.value,10);
        if(wait==WAIT_OBJECT_0){DWORD ignored;connected=GetOverlappedResult(pipe.value,&connection,&ignored,FALSE);break;}
        if(wait!=WAIT_TIMEOUT)return 98;
      }
    }else if(error==ERROR_PIPE_CONNECTED)connected=TRUE;
    if(!connected)return 98;
    // Peer PID comes from the kernel pipe endpoint, never request data.
    ULONG pid=0;Handle peer;
    if(GetNamedPipeClientProcessId(pipe.value,&pid))peer.value=OpenProcess(PROCESS_DUP_HANDLE|PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,pid);
    Request request;Reply reply;std::vector<BYTE> payload;
    if(custody){reply.custodyCount=custody->count;reply.custodyRoles=nozeli_custody::Roles(*custody);memcpy(reply.custodySha256,custodyHash,sizeof(custodyHash));memcpy(reply.sourceSha256,custody->sourceSha256,32);
      const auto home=nozeli_custody::OwnerHomeIdentity(*custody);memcpy(reply.ownerHomeIdentity,home.c_str(),home.size());}
    bool close=false;
    const auto pump=[&](){captureMembers();output.Pump(job.value);input.Pump(job.value);};
    if(peer.value&&SameUser(peer.value)&&checkHost()&&Exchange(pipe.value,&request,sizeof(request),false,3000,host.value,job.value,pump)&&
       request.magicValue==magic&&request.versionValue==version&&request.reserved==0){
      reply.hostExited=hostDead?1:0;
      try{if(custody)nozeli_custody::Verify(*custody);}catch(...){custodyFenced=true;}
      const bool custodyValid=!custodyFenced;if(!custodyValid)reply.error=ERROR_INVALID_DATA;
      // Drift retains every pin. Even an empty Job cannot authorize cleanup.
      if(!custodyValid){}
      else if(request.operation!=Operation::readOutput&&request.operation!=Operation::readInput&&request.operation!=Operation::writeInput&&request.operation!=Operation::pollInput&&(request.channel||request.length||request.offset))reply.error=ERROR_INVALID_PARAMETER;
      else if(request.operation==Operation::verify){}
      else if(request.operation==Operation::claimColdAnchor){
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        bool busy;
        {
          AcquireSRWLockShared(&members.lock);
          busy=!hostDead||!custody||(nozeli_custody::Roles(*custody)&31)!=31||!launchSet.value||members.error||
            !output.enabled||!output.Complete()||output.error||!output.channels[0].eof||!output.channels[1].eof||
            !input.enabled||input.error||input.pending||!input.closed||input.completed!=input.bytes.size()||
            WaitForSingleObject(leader.value,0)!=WAIT_OBJECT_0||
            !QueryInformationJobObject(job.value,JobObjectBasicAccountingInformation,&accounting,sizeof(accounting),nullptr)||
            accounting.ActiveProcesses!=0||accounting.TotalProcesses!=members.values.size()+1;
          ReleaseSRWLockShared(&members.lock);
        }
        if(busy)
          reply.error=ERROR_BUSY;
        else{
          auto* history=static_cast<nozeli_launch_set::Manifest*>(MapViewOfFile(launchSet.value,FILE_MAP_READ|FILE_MAP_WRITE,0,0,sizeof(nozeli_launch_set::Manifest)));
          if(!history)reply.error=GetLastError();
          else{
            bool complete=nozeli_launch_set::Valid(*history,host.value,custody->sourceSha256)&&history->count>0;
            for(uint32_t i=0;complete&&i<history->count;i++)complete=history->entries[i].prepared==1;
            if(!complete)reply.error=ERROR_INVALID_DATA;
            else if(InterlockedCompareExchange(&history->coldAnchorAttempted,1,0)!=0)reply.error=ERROR_ALREADY_EXISTS;
            else{
              // Allocate before duplicating. Arbitration is deliberately never
              // rolled back: a lost reply retains the old helper's evidence.
              try{
                payload.resize(sizeof(nozeli_custody::Frame));
                for(uint32_t i=0;i<custody->count;i++)if(custody->frames[i].kind==nozeli_custody::Kind::anchor){
                  auto frame=custody->frames[i];HANDLE transferred=nullptr;
                  if(!DuplicateHandle(GetCurrentProcess(),reinterpret_cast<HANDLE>(frame.handle),peer.value,&transferred,
                      FILE_READ_ATTRIBUTES|READ_CONTROL|SYNCHRONIZE,FALSE,0)){reply.error=GetLastError();payload.clear();}
                  else{frame.handle=reinterpret_cast<uint64_t>(transferred);memcpy(payload.data(),&frame,sizeof(frame));reply.dataSize=static_cast<uint32_t>(payload.size());}
                  break;
                }
              }catch(...){reply.error=ERROR_NOT_ENOUGH_MEMORY;payload.clear();}
            }
            UnmapViewOfFile(history);
          }
        }
      }
      else if(request.operation==Operation::readOutput||request.operation==Operation::readInput){
        const bool readingInput=request.operation==Operation::readInput;
        if(!output.enabled||(readingInput?request.channel!=0:request.channel<1||request.channel>2)||request.length<1||request.length>outputChunk)reply.error=ERROR_INVALID_PARAMETER;
        else{
          const auto& bytes=readingInput?input.bytes:output.channels[request.channel-1].bytes;
          if(request.offset>bytes.size())reply.error=ERROR_INVALID_PARAMETER;
          else{
            const auto length=std::min<size_t>(request.length,bytes.size()-static_cast<size_t>(request.offset));
            try{payload.assign(bytes.begin()+static_cast<size_t>(request.offset),bytes.begin()+static_cast<size_t>(request.offset)+length);reply.dataSize=static_cast<uint32_t>(length);}
            catch(...){reply.error=ERROR_NOT_ENOUGH_MEMORY;}
          }
        }
      }
      else if(request.operation==Operation::writeInput||request.operation==Operation::pollInput||request.operation==Operation::closeInput||request.operation==Operation::abortInput){
        // Original host identity is established from the kernel peer, not from
        // persisted declarations or PID supplied in a request. Cold observers
        // can read history, but can never add or terminate an input operation.
        using Compare=BOOL(WINAPI*)(HANDLE,HANDLE);
        const auto compare=reinterpret_cast<Compare>(GetProcAddress(GetModuleHandleW(L"kernelbase.dll"),"CompareObjectHandles"));
        if(hostDead||!compare||!compare(peer.value,host.value)||WaitForSingleObject(host.value,0)!=WAIT_TIMEOUT)reply.error=ERROR_ACCESS_DENIED;
        else if(!input.enabled)reply.error=ERROR_INVALID_HANDLE;
        else if(request.channel)reply.error=ERROR_INVALID_PARAMETER;
        else if(request.operation==Operation::writeInput){
          if(!request.length||request.length>outputChunk)reply.error=ERROR_INVALID_PARAMETER;
          else{
            std::vector<BYTE> incoming(request.length);
            if(!Exchange(pipe.value,incoming.data(),request.length,false,3000,host.value,job.value,pump))reply.error=ERROR_INVALID_DATA;
            else reply.error=input.Admit(request.offset,incoming,job.value);
          }
        }else if(request.operation==Operation::pollInput){
          if(request.length||request.offset>input.bytes.size())reply.error=ERROR_INVALID_PARAMETER;
          else {input.Pump(job.value);if(input.error)reply.error=input.error;}
        }else if(request.operation==Operation::closeInput){
          if(input.pending||input.completed!=input.bytes.size())reply.error=ERROR_BUSY;
          else input.Close(false);
        }else input.Close(true);
      }
      else if(request.operation==Operation::inspect){
        if(++inspections>64){reply.error=ERROR_NOT_ENOUGH_QUOTA;}
        else{
        captureMembers();
        AcquireSRWLockShared(&members.lock);
        std::vector<HANDLE> values(3+members.values.size()+(launchSet.value?1:0),nullptr);
        const HANDLE originals[]={job.value,leader.value,host.value};
        size_t i=0;
        try{
          payload.resize(members.values.size()*sizeof(uint64_t));
          for(;i<values.size();i++){
            const bool isSet=launchSet.value&&i==values.size()-1;
            const auto original=i<3?originals[i]:isSet?launchSet.value:members.values[i-3].handle;
            const DWORD access=isSet?FILE_MAP_READ:i==0?JOB_OBJECT_QUERY:SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION;
            if(!DuplicateHandle(GetCurrentProcess(),original,peer.value,&values[i],access,FALSE,0)){reply.error=GetLastError();break;}
          }
        }catch(...){reply.error=ERROR_NOT_ENOUGH_MEMORY;}
        if(i!=values.size()){
          for(size_t n=0;n<i;n++){HANDLE local=nullptr;if(DuplicateHandle(peer.value,values[n],GetCurrentProcess(),&local,0,FALSE,DUPLICATE_CLOSE_SOURCE))CloseHandle(local);}
          payload.clear();
        }else{
          reply.job=reinterpret_cast<uint64_t>(values[0]);reply.leader=reinterpret_cast<uint64_t>(values[1]);reply.host=reinterpret_cast<uint64_t>(values[2]);
          reply.memberCount=static_cast<uint32_t>(members.values.size());reply.dataSize=static_cast<uint32_t>(payload.size());
          if(launchSet.value)reply.launchSet=reinterpret_cast<uint64_t>(values.back());
          for(size_t n=3;n<3+members.values.size();n++){const auto handle=reinterpret_cast<uint64_t>(values[n]);memcpy(payload.data()+(n-3)*sizeof(handle),&handle,sizeof(handle));}
        }
        ReleaseSRWLockShared(&members.lock);
        }
      }else if(request.operation==Operation::close){
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        close=WaitForSingleObject(leader.value,0)==WAIT_OBJECT_0&&
          QueryInformationJobObject(job.value,JobObjectBasicAccountingInformation,&accounting,sizeof(accounting),nullptr)&&accounting.ActiveProcesses==0&&output.Complete();
        if(close)input.Close(true);
        if(!close)reply.error=ERROR_BUSY;
      }else reply.error=ERROR_INVALID_FUNCTION;
      // A lost reply never authorizes a retry or resource release in the client.
      output.Describe(reply);input.Describe(reply);
      {
        // Scoped: released before any Exchange below, whose pump takes the
        // exclusive lock; holding it here would deadlock captureMembers.
        AcquireSRWLockShared(&members.lock);
        reply.membersError=members.error;
        ReleaseSRWLockShared(&members.lock);
      }
      if(Exchange(pipe.value,&reply,sizeof(reply),true,3000,host.value,job.value,pump)&&
         (!reply.dataSize||Exchange(pipe.value,payload.data(),reply.dataSize,true,3000,host.value,job.value,pump))){
        uint32_t ack=0;Exchange(pipe.value,&ack,sizeof(ack),false,3000,host.value,job.value,pump);
      }
    }
    DisconnectNamedPipe(pipe.value);
    if(close)return 0;
  }
}
