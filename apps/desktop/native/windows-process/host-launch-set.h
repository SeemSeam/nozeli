#pragma once
#include <windows.h>
#include <cstdint>
#include <cstring>
namespace nozeli_launch_set {
// Single writer in the original host. Readers may consume entries only after
// waiting on that exact host PROCESS HANDLE. A torn/incomplete publication
// remains an intent and cannot qualify recovery. No erase/retire operation.
constexpr uint32_t magic=0x4e5a4c31,version=2,limit=256;
struct Entry {
  char launchId[37]{};
  uint32_t prepared=0,leaderPid=0,supervisorPid=0;
  uint64_t leaderCreation=0,supervisorCreation=0;
};
struct Manifest {
  uint32_t magicValue=magic,versionValue=version,hostPid=0,count=0;
  uint64_t hostCreation=0;
  char leaseId[37]{},nonce[65]{};
  BYTE sourceSha256[32]{};
  // Helpers may change only this one-way arbitration cell after the original
  // host has exited. A lost transfer cannot be retried through another helper.
  volatile LONG coldAnchorAttempted=0;
  Entry entries[limit]{};
};
inline uint64_t Creation(HANDLE process){
  FILETIME c{},e{},k{},u{};if(!GetProcessTimes(process,&c,&e,&k,&u))return 0;
  return (static_cast<uint64_t>(c.dwHighDateTime)<<32)|c.dwLowDateTime;
}
inline bool Uuid(const char* value){
  if(value[36])return false;
  for(size_t i=0;i<36;i++)if(i==8||i==13||i==18||i==23){if(value[i]!='-')return false;}
    else if(!((value[i]>='0'&&value[i]<='9')||(value[i]>='a'&&value[i]<='f')))return false;
  return true;
}
inline bool Valid(const Manifest& value,HANDLE host,const BYTE* source){
  if(value.magicValue!=magic||value.versionValue!=version||value.count>limit||
     value.hostPid!=GetProcessId(host)||value.hostCreation!=Creation(host)||!Uuid(value.leaseId)||
     value.nonce[64]||memcmp(value.sourceSha256,source,32)||
     (value.coldAnchorAttempted!=0&&value.coldAnchorAttempted!=1))return false;
  for(size_t i=0;i<64;i++)if(!((value.nonce[i]>='0'&&value.nonce[i]<='9')||(value.nonce[i]>='a'&&value.nonce[i]<='f')))return false;
  for(uint32_t i=0;i<value.count;i++){
    const auto& entry=value.entries[i];if(!Uuid(entry.launchId)||entry.prepared>1)return false;
    if(entry.prepared&&(!entry.leaderPid||!entry.leaderCreation||!entry.supervisorPid||!entry.supervisorCreation))return false;
    for(uint32_t j=0;j<i;j++)if(!strcmp(value.entries[j].launchId,entry.launchId))return false;
  }
  return true;
}
}
