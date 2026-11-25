#pragma once
#include <windows.h>
#include <algorithm>
#include <vector>
#include <stdexcept>
namespace nozeli_members {
struct Member { HANDLE handle; DWORD pid; ULONGLONG creation; };
struct Failure:std::runtime_error {
  DWORD windows;
  explicit Failure(const char* message,DWORD error=ERROR_INVALID_DATA):std::runtime_error(message),windows(error){}
};
inline ULONGLONG Creation(FILETIME value){ULARGE_INTEGER number{};number.LowPart=value.dwLowDateTime;number.HighPart=value.dwHighDateTime;return number.QuadPart;}
// Kernel Job completion-port notifications. The system does NOT guarantee the
// delivery of every message, and a NEW_PROCESS notification carries only a
// process ID: by the time it is dequeued the incarnation may already be gone.
// Both cases must keep failing closed through the accounting equality below.
constexpr ULONG_PTR stopToken=0x6E7A53544F50ULL; // stable control token posted on the port; never a kernel message
constexpr ULONG_PTR jobKey=0x6E7A4A4F42ULL;      // stable non-pointer CompletionKey used for this association
constexpr size_t budget=4096;
inline HANDLE AssociatePort(HANDLE job) {
  HANDLE port=CreateIoCompletionPort(INVALID_HANDLE_VALUE,nullptr,0,0);
  if(!port)throw Failure("Cannot allocate Job completion port",GetLastError());
  JOBOBJECT_ASSOCIATE_COMPLETION_PORT association{};
  association.CompletionKey=reinterpret_cast<PVOID>(jobKey);
  association.CompletionPort=port;
  if(!SetInformationJobObject(job,JobObjectAssociateCompletionPortInformation,&association,sizeof(association))) {
    const DWORD error=GetLastError();CloseHandle(port);
    throw Failure("Cannot associate Job completion port",error);
  }
  return port;
}
inline void Pin(HANDLE job,DWORD pid,std::vector<Member>& members,DWORD& error) {
  // A NEW_PROCESS notification is positive knowledge that this exact
  // incarnation joined the Job. If its identity cannot be pinned now the
  // incarnation is unprovable; retain the refusal, never trust the PID alone.
  if(members.size()>=budget){error=ERROR_INSUFFICIENT_BUFFER;return;}
  HANDLE handle=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,pid);
  if(!handle){const DWORD failure=GetLastError();error=failure?failure:ERROR_INVALID_HANDLE;return;}
  BOOL member=FALSE;FILETIME creation{},exit{},kernel{},user{};
  if(!IsProcessInJob(handle,job,&member)||!member||!GetProcessTimes(handle,&creation,&exit,&kernel,&user)) {
    const DWORD failure=GetLastError();CloseHandle(handle);error=failure?failure:ERROR_INVALID_DATA;return;
  }
  const auto stamp=Creation(creation);
  for(const auto& held:members)if(held.pid==pid&&held.creation==stamp){CloseHandle(handle);return;}
  try{members.push_back({handle,pid,stamp});}
  catch(...){CloseHandle(handle);error=ERROR_NOT_ENOUGH_MEMORY;}
}
inline void Apply(ULONG_PTR message,DWORD pid,HANDLE job,DWORD leaderPid,std::vector<Member>& members,DWORD& error,ULONGLONG& announced) {
  if(message==JOB_OBJECT_MSG_NEW_PROCESS) {
    announced++;
    if(!error&&pid!=leaderPid)Pin(job,pid,members,error);
  } else if(message==JOB_OBJECT_MSG_EXIT_PROCESS) {
    // EXIT_PROCESS carries no exit authority; retained original HANDLE waits
    // remain the only exit proof. An exit for an unknown non-leader PID is
    // evidence its NEW_PROCESS was never observed: refuse everything after.
    if(pid!=leaderPid&&!error&&!std::any_of(members.begin(),members.end(),[&](const Member& held){return held.pid==pid;}))
      error=ERROR_INVALID_DATA;
  }
}
// One collector owns the ledger target and its lock. The thread blocks on the
// associated port so notifications are pinned while the incarnation is fresh.
struct Notifications {
  SRWLOCK* lock=nullptr;
  std::vector<Member>* members=nullptr;
  ULONGLONG* announced=nullptr;
  DWORD* error=nullptr;
  HANDLE port=nullptr,job=nullptr,thread=nullptr;
  DWORD leaderPid=0;
};
inline DWORD WINAPI Collect(void* raw) {
  auto* state=static_cast<Notifications*>(raw);
  for(;;) {
    // Kernel Job notifications carry the message code in the transferred byte
    // count, the PID as the overlapped value, and this association's stable
    // non-pointer CompletionKey as the key. Stop tokens only ever match key.
    DWORD bytes=0;ULONG_PTR key=0;OVERLAPPED* overlapped=nullptr;
    if(!GetQueuedCompletionStatus(state->port,&bytes,&key,&overlapped,INFINITE))return 0;
    if(key==stopToken)return 0;
    if(key!=jobKey)continue;
    const auto pid=static_cast<DWORD>(reinterpret_cast<ULONG_PTR>(overlapped)&0xffffffffULL);
    AcquireSRWLockExclusive(state->lock);
    Apply(static_cast<ULONG_PTR>(bytes),pid,state->job,state->leaderPid,*state->members,*state->error,*state->announced);
    ReleaseSRWLockExclusive(state->lock);
  }
}
inline bool StartCollector(Notifications& state) {
  if(state.thread||!state.port)return true;
  state.thread=CreateThread(nullptr,0,Collect,&state,0,nullptr);
  return state.thread!=nullptr;
}
inline void StopCollector(Notifications& state) {
  if(!state.thread)return;
  PostQueuedCompletionStatus(state.port,0,stopToken,nullptr);
  WaitForSingleObject(state.thread,INFINITE);
  CloseHandle(state.thread);state.thread=nullptr;
}
// Bounded member facts the supervising helper publishes for the original Job
// owner: single writer, fixed capacity, seqlock readers. Exit flags come from
// the helper's retained original HANDLE waits, never from EXIT_PROCESS.
struct MemberFact{ULONGLONG creation;DWORD pid;DWORD exited;};
struct MemberFacts {
  volatile ULONG64 sequence;
  ULONGLONG announced;
  DWORD error;
  DWORD count;
  MemberFact entries[budget];
};
inline void PublishFacts(MemberFacts* facts,const std::vector<Member>& members,ULONGLONG announced,DWORD error) {
  const auto sequence=facts->sequence;
  facts->sequence=sequence+1;MemoryBarrier();
  facts->announced=announced;facts->error=error;
  const size_t count=std::min(members.size(),budget);
  for(size_t index=0;index<count;index++) {
    const auto& member=members[index];
    const auto state=WaitForSingleObject(member.handle,0);
    facts->entries[index]={member.creation,member.pid,state==WAIT_OBJECT_0?1u:0u};
  }
  facts->count=static_cast<DWORD>(count);
  MemoryBarrier();facts->sequence=sequence+2;
}
inline bool ReadFacts(const MemberFacts* facts,std::vector<MemberFact>& copy,ULONGLONG& announced,DWORD& error) {
  for(unsigned attempt=0;attempt<64;attempt++) {
    const auto before=facts->sequence;
    if(!(before&1)) {
      MemoryBarrier();
      announced=facts->announced;error=facts->error;
      const auto count=facts->count;
      if(count>budget)return false;
      copy.assign(facts->entries,facts->entries+count);
      MemoryBarrier();
      if(facts->sequence==before)return true;
    }
    SwitchToThread();
  }
  return false;
}
inline void Observe(HANDLE job,DWORD leaderPid,std::vector<Member>& members) {
  // Accounting can reach zero while an observed member's process HANDLE is
  // not yet signaled. Pin current members before termination, keep those exact
  // HANDLEs through exit, and require them as well as zero Job accounting.
  for (size_t attempt = 0; attempt < 5; attempt++) {
    std::vector<BYTE> bytes(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + 32 * sizeof(ULONG_PTR));
    for (;;) {
      if (QueryInformationJobObject(job, JobObjectBasicProcessIdList, bytes.data(),
          static_cast<DWORD>(bytes.size()), nullptr)) break;
      if (GetLastError() != ERROR_MORE_DATA || bytes.size() >= 256 * 1024)
        throw Failure("Cannot enumerate retained Job members", GetLastError());
      bytes.resize(bytes.size() * 2);
    }
    const auto* list = reinterpret_cast<const JOBOBJECT_BASIC_PROCESS_ID_LIST*>(bytes.data());
    bool retry = false;
    for (DWORD index = 0; index < list->NumberOfProcessIdsInList; index++) {
      const auto widePid = list->ProcessIdList[index];
      if (!widePid || widePid > 0xffffffff)
        throw Failure("Invalid Job process ID");
      const auto pid = static_cast<DWORD>(widePid);
      if (pid == leaderPid) continue;
      HANDLE handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
      if (!handle) {
        if (GetLastError() == ERROR_INVALID_PARAMETER) { retry = true; break; }
        throw Failure("Cannot pin a Job member", GetLastError());
      }
      BOOL member = FALSE;
      FILETIME creation{}, exit{}, kernel{}, user{};
      const bool queried = IsProcessInJob(handle, job, &member) &&
        GetProcessTimes(handle, &creation, &exit, &kernel, &user);
      if (!queried || !member) { CloseHandle(handle); retry = true; break; }
      const auto stamp = Creation(creation);
      const bool retained = std::any_of(members.begin(), members.end(), [&](const Member& held) {
        return held.pid == pid && held.creation == stamp;
      });
      if (retained) CloseHandle(handle);
      else {
        if (members.size() >= 4096) { CloseHandle(handle); throw Failure("Observed member budget exceeded; retain Job"); }
        try { members.push_back({handle, pid, stamp}); }
        catch (...) { CloseHandle(handle); throw; }
      }
    }
    if (!retry) return;
  }
  throw Failure("Job membership changed during bounded identity capture; retain Job");
}
}
