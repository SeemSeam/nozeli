#pragma once
#include <windows.h>
#include <cstdint>
#include <functional>
namespace nozeli_supervisor {
constexpr uint32_t magic=0x4e5a5331, version=10,outputChunk=65536,outputLimit=64*1024*1024,inputLimit=64*1024*1024;
enum class Operation:uint32_t { inspect=1, close=2, verify=3,readOutput=4,writeInput=5,pollInput=6,closeInput=7,abortInput=8,readInput=9,claimColdAnchor=10 };
struct Request {
  uint32_t magicValue=magic,versionValue=version; Operation operation=Operation::inspect; uint32_t reserved=0;
  uint32_t channel=0,length=0;uint64_t offset=0;
};
struct Reply {
  uint32_t magicValue=magic,versionValue=version,error=0,hostExited=0;
  uint64_t job=0,leader=0,host=0,launchSet=0;
  uint32_t custodyCount=0;
  BYTE custodySha256[32]{};
  uint32_t custodyRoles=0;
  BYTE sourceSha256[32]{};
  char ownerHomeIdentity[64]{};
  uint32_t outputEnabled=0,outputError=0,outputEOF[2]{},dataSize=0;
  uint64_t outputBytes[2]{},outputObservedBytes[2]{};
  BYTE outputSha256[2][32]{};
  uint32_t inputEnabled=0,inputError=0,inputPending=0,inputClosed=0;
  uint64_t inputBytes=0,inputCompletedBytes=0;
  BYTE inputSha256[32]{};
  uint32_t memberCount=0,membersError=0;
};
inline bool Exchange(HANDLE pipe,void* bytes,DWORD size,bool writing,DWORD timeout=3000,HANDLE host=nullptr,HANDLE job=nullptr,const std::function<void()>& tick={}) {
  OVERLAPPED operation{};operation.hEvent=CreateEventW(nullptr,TRUE,FALSE,nullptr);
  if(!operation.hEvent)return false;
  DWORD transferred=0;
  BOOL ok=writing?WriteFile(pipe,bytes,size,&transferred,&operation):ReadFile(pipe,bytes,size,&transferred,&operation);
  if(!ok&&GetLastError()==ERROR_IO_PENDING){
    const auto deadline=GetTickCount64()+timeout;DWORD wait=WAIT_TIMEOUT;
    do {
      if(host&&WaitForSingleObject(host,0)==WAIT_OBJECT_0)TerminateJobObject(job,0xe0000002);
      if(tick)tick();
      wait=WaitForSingleObject(operation.hEvent,10);
    }while(wait==WAIT_TIMEOUT&&GetTickCount64()<deadline);
    if(wait!=WAIT_OBJECT_0){
      CancelIoEx(pipe,&operation);GetOverlappedResult(pipe,&operation,&transferred,TRUE);CloseHandle(operation.hEvent);return false;
    }
    ok=GetOverlappedResult(pipe,&operation,&transferred,FALSE);
  }
  CloseHandle(operation.hEvent);return ok&&transferred==size;
}
}
