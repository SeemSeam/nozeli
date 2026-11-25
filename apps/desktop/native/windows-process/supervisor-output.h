#pragma once
// The original read endpoints move before resume. Only this helper reads them;
// host and cold observers request bounded immutable byte ranges over IPC.
// Custody is volatile across helper loss. Overflow never becomes complete EOF.
#include <windows.h>
#include <bcrypt.h>
#include <vector>
#include <algorithm>
#include "supervisor-protocol.h"
namespace nozeli_supervisor {
struct OutputChannel {
  HANDLE pipe=nullptr,event=nullptr;
  OVERLAPPED operation{};
  BYTE chunk[outputChunk]{};
  std::vector<BYTE> bytes;
  uint64_t observed=0;
  bool pending=false,eof=false,failed=false;
  BYTE sha256[32]{};
  ~OutputChannel(){
    if(pending){CancelIoEx(pipe,&operation);DWORD ignored;GetOverlappedResult(pipe,&operation,&ignored,TRUE);}
    if(pipe)CloseHandle(pipe);if(event)CloseHandle(event);
  }
  bool Initialize(HANDLE value){
    pipe=value;if(!pipe)return true;
    if(!SetHandleInformation(pipe,HANDLE_FLAG_INHERIT,0))return false;
    event=CreateEventW(nullptr,TRUE,FALSE,nullptr);operation.hEvent=event;return event!=nullptr;
  }
};
struct OutputCustody {
  OutputChannel channels[2];
  bool enabled=false;
  DWORD error=0;
  size_t retained=0;
  bool Initialize(HANDLE output,HANDLE diagnostic){
    if((output==nullptr)!=(diagnostic==nullptr))return false;
    enabled=output!=nullptr;
    // Initialize both so all inherited endpoints have RAII ownership on failure.
    const bool first=channels[0].Initialize(output),second=channels[1].Initialize(diagnostic);
    return first&&second;
  }
  void Finish(OutputChannel& channel){
    channel.eof=true;
    if(BCryptHash(BCRYPT_SHA256_ALG_HANDLE,nullptr,0,channel.bytes.data(),static_cast<ULONG>(channel.bytes.size()),channel.sha256,32)<0)
      error=ERROR_INVALID_DATA;
  }
  void Pump(HANDLE job){
    if(!enabled)return;
    for(auto& channel:channels){
      if(channel.eof||channel.failed)continue;
      // Bounded work preserves pipe/host liveness even under a noisy child.
      for(unsigned turn=0;turn<8&&!channel.eof;turn++){
        DWORD size=0;BOOL done;
        if(channel.pending){
          done=GetOverlappedResult(channel.pipe,&channel.operation,&size,FALSE);
          if(!done&&GetLastError()==ERROR_IO_INCOMPLETE)break;
          channel.pending=false;
        }else{
          ResetEvent(channel.event);channel.operation={};channel.operation.hEvent=channel.event;
          done=ReadFile(channel.pipe,channel.chunk,outputChunk,&size,&channel.operation);
          if(!done&&GetLastError()==ERROR_IO_PENDING){channel.pending=true;break;}
        }
        if(!done){
          const DWORD cause=GetLastError();
          if(cause==ERROR_BROKEN_PIPE||cause==ERROR_PIPE_NOT_CONNECTED)Finish(channel);
          else{error=cause;channel.failed=true;}
          break;
        }
        if(!size){Finish(channel);break;}
        channel.observed+=size;
        if(size>outputLimit-retained){error=ERROR_BUFFER_OVERFLOW;}
        else if(!error){
          try{channel.bytes.insert(channel.bytes.end(),channel.chunk,channel.chunk+size);retained+=size;}
          catch(...){error=ERROR_NOT_ENOUGH_MEMORY;}
        }
      }
    }
    if(error)TerminateJobObject(job,0xe0000004);
  }
  void Describe(Reply& reply) const {
    reply.outputEnabled=enabled?1:0;reply.outputError=error;
    for(size_t i=0;i<2;i++){
      reply.outputEOF[i]=channels[i].eof?1:0;reply.outputBytes[i]=channels[i].bytes.size();
      reply.outputObservedBytes[i]=channels[i].observed;memcpy(reply.outputSha256[i],channels[i].sha256,32);
    }
  }
  bool Complete() const {return !enabled||((channels[0].eof||channels[0].failed)&&(channels[1].eof||channels[1].failed));}
};
}
