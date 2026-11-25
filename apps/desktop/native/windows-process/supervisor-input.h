#pragma once
// The original helper is the only stdin writer. Admission precedes native I/O;
// immutable retained bytes and confirmed byte counts survive original host loss.
// A lost IPC reply is UNKNOWN, never permission to resend a frame.
#include <windows.h>
#include <bcrypt.h>
#include <vector>
#include "supervisor-protocol.h"
namespace nozeli_supervisor {
struct InputCustody {
  HANDLE pipe=nullptr,event=nullptr;
  OVERLAPPED operation{};
  std::vector<BYTE> bytes;
  size_t completed=0;
  bool enabled=false,pending=false,closed=false;
  DWORD error=0;
  BYTE sha256[32]{};
  ~InputCustody(){Close(true);if(event)CloseHandle(event);}
  bool Initialize(HANDLE value){
    pipe=value;enabled=pipe!=nullptr;if(!enabled)return true;
    if(!SetHandleInformation(pipe,HANDLE_FLAG_INHERIT,0))return false;
    event=CreateEventW(nullptr,TRUE,FALSE,nullptr);return event!=nullptr;
  }
  void Pump(HANDLE job){
    if(!enabled||closed)return;
    // At most one bounded chunk is admitted until its completion is confirmed.
    for(unsigned turn=0;turn<8&&!error;turn++){
      DWORD size=0;BOOL done;
      if(pending){
        done=GetOverlappedResult(pipe,&operation,&size,FALSE);
        if(!done&&GetLastError()==ERROR_IO_INCOMPLETE)break;
        pending=false;
      }else{
        if(completed==bytes.size())break;
        ResetEvent(event);operation={};operation.hEvent=event;
        done=WriteFile(pipe,bytes.data()+completed,static_cast<DWORD>(bytes.size()-completed),&size,&operation);
        if(!done&&GetLastError()==ERROR_IO_PENDING){pending=true;break;}
      }
      if(!done){error=GetLastError();break;}
      if(!size||size>bytes.size()-completed){error=ERROR_WRITE_FAULT;break;}
      completed+=size;
    }
    if(error&&job)TerminateJobObject(job,0xe0000005);
  }
  DWORD Admit(uint64_t offset,const std::vector<BYTE>& chunk,HANDLE job){
    if(!enabled||closed)return ERROR_INVALID_HANDLE;
    if(error)return error;
    if(pending||completed!=bytes.size())return ERROR_BUSY;
    if(offset!=bytes.size()||chunk.empty()||chunk.size()>outputChunk)return ERROR_INVALID_PARAMETER;
    if(chunk.size()>inputLimit-bytes.size()){
      error=ERROR_BUFFER_OVERFLOW;TerminateJobObject(job,0xe0000005);return error;
    }
    try{bytes.insert(bytes.end(),chunk.begin(),chunk.end());}
    catch(...){error=ERROR_NOT_ENOUGH_MEMORY;TerminateJobObject(job,0xe0000005);return error;}
    Pump(job);return error;
  }
  void Close(bool abort){
    if(!enabled||closed)return;
    if(pending){
      // Even a cancellation that reports transferred bytes cannot prove which
      // protocol prefix the child dispatched. Keep the lifetime failure sticky.
      if(!abort)return;
      CancelIoEx(pipe,&operation);DWORD size=0;
      if(GetOverlappedResult(pipe,&operation,&size,TRUE)&&size<=bytes.size()-completed)completed+=size;
      pending=false;error=error?error:ERROR_OPERATION_ABORTED;
    }
    if(completed!=bytes.size())error=error?error:ERROR_OPERATION_ABORTED;
    CloseHandle(pipe);pipe=nullptr;closed=true;
    if(BCryptHash(BCRYPT_SHA256_ALG_HANDLE,nullptr,0,bytes.data(),static_cast<ULONG>(bytes.size()),sha256,32)<0)
      error=error?error:ERROR_INVALID_DATA;
  }
  void Describe(Reply& reply)const{
    reply.inputEnabled=enabled?1:0;reply.inputError=error;reply.inputPending=pending||completed!=bytes.size();
    reply.inputClosed=closed?1:0;reply.inputBytes=bytes.size();reply.inputCompletedBytes=completed;memcpy(reply.inputSha256,sha256,32);
  }
};
}
