#include "host-launch-set.h"
constexpr napi_type_tag launchSetTag={0x19c457c25df94733ULL,0xa36611ad87834125ULL};
constexpr napi_type_tag launchClaimTag={0x4ec6521441be4758ULL,0xba3828427b74e9edULL};
struct LaunchSet {
  IoHandle mapping;
  nozeli_launch_set::Manifest* view=nullptr;
  bool closed=false;
  ~LaunchSet(){if(view)UnmapViewOfFile(view);}
};
struct LaunchClaim { std::shared_ptr<LaunchSet> set;uint32_t index=0;bool attempted=false; };
template<typename T> T* LaunchReceiver(napi_env env,napi_value value,const napi_type_tag& tag){
  napi_valuetype type;Check(napi_typeof(env,value,&type));bool tagged=false;
  if(type==napi_object)Check(napi_check_object_type_tag(env,value,&tag,&tagged));
  if(!tagged)throw Failure("HOST_LAUNCH_SET_INVALID","Original native launch-set object required");
  T* held=nullptr;Check(napi_unwrap(env,value,reinterpret_cast<void**>(&held)));return held;
}
std::string LaunchString(napi_env env,napi_value value){
  auto wide=JobString(env,value);if(wide.size()!=36)throw Failure("HOST_LAUNCH_SET_INVALID","Expected lowercase launch UUID");
  std::string text(wide.begin(),wide.end());if(!nozeli_launch_set::Uuid(text.c_str()))throw Failure("HOST_LAUNCH_SET_INVALID","Invalid launch UUID");return text;
}
void VerifyLaunchSet(const LaunchSet& value){
  if(value.closed||!value.view||value.view->hostPid!=GetCurrentProcessId()||value.view->hostCreation!=nozeli_launch_set::Creation(GetCurrentProcess()))
    throw Failure("HOST_LAUNCH_SET_CLOSED","Original live host launch set required");
}
napi_value ReserveLaunch(napi_env env,napi_callback_info info){return Guard(env,[&]{
  size_t count=1;napi_value args[1],self;Check(napi_get_cb_info(env,info,&count,args,&self,nullptr));
  if(count!=1)throw Failure("HOST_LAUNCH_SET_INVALID","Exact launch UUID required");
  auto set=*LaunchReceiver<std::shared_ptr<LaunchSet>>(env,self,launchSetTag);VerifyLaunchSet(*set);
  const auto id=LaunchString(env,args[0]);auto* manifest=set->view;
  if(manifest->count>=nozeli_launch_set::limit)throw Failure("HOST_LAUNCH_SET_LIMIT","Host launch history is full; no process may be allocated");
  for(uint32_t i=0;i<manifest->count;i++)if(id==manifest->entries[i].launchId)throw Failure("HOST_LAUNCH_SET_DUPLICATE","Launch cannot be reserved twice");
  const uint32_t index=manifest->count;
  // Publish count first: death in the subsequent write is malformed/incomplete,
  // never a history that silently omits an admitted native Job.
  InterlockedExchange(reinterpret_cast<volatile LONG*>(&manifest->count),index+1);
  memcpy(manifest->entries[index].launchId,id.c_str(),37);MemoryBarrier();
  auto claim=std::make_unique<LaunchClaim>();claim->set=set;claim->index=index;
  napi_value result;Check(napi_create_object(env,&result));Check(napi_type_tag_object(env,result,&launchClaimTag));
  Check(napi_wrap(env,result,claim.get(),[](napi_env,void* data,void*){delete static_cast<LaunchClaim*>(data);},nullptr,nullptr));claim.release();return result;
});}
napi_value CloseLaunchSet(napi_env env,napi_callback_info info){return Guard(env,[&]{
  size_t count=0;napi_value self;Check(napi_get_cb_info(env,info,&count,nullptr,&self,nullptr));
  auto set=*LaunchReceiver<std::shared_ptr<LaunchSet>>(env,self,launchSetTag);set->closed=true;
  napi_value result;Check(napi_get_undefined(env,&result));return result;
});}
napi_value CreateLaunchSet(napi_env env,napi_callback_info info){return Guard(env,[&]{
  size_t count=2;napi_value args[2];Check(napi_get_cb_info(env,info,&count,args,nullptr,nullptr));
  if(count!=2)throw Failure("HOST_LAUNCH_SET_INVALID","Lease UUID and source digest required");
  auto id=LaunchString(env,args[0]);auto digest=JobString(env,args[1]);
  if(digest.size()!=64||digest.find_first_not_of(L"0123456789abcdef")!=std::wstring::npos)throw Failure("HOST_LAUNCH_SET_INVALID","Invalid source digest");
  auto set=std::make_shared<LaunchSet>();set->mapping.value=CreateFileMappingW(INVALID_HANDLE_VALUE,nullptr,PAGE_READWRITE,0,sizeof(nozeli_launch_set::Manifest),nullptr);
  if(!set->mapping.value)throw Failure("HOST_LAUNCH_SET_CREATE_FAILED","Cannot allocate native launch history",GetLastError());
  set->view=static_cast<nozeli_launch_set::Manifest*>(MapViewOfFile(set->mapping.value,FILE_MAP_WRITE|FILE_MAP_READ,0,0,sizeof(nozeli_launch_set::Manifest)));
  if(!set->view)throw Failure("HOST_LAUNCH_SET_CREATE_FAILED","Cannot map native launch history",GetLastError());
  new(set->view) nozeli_launch_set::Manifest();auto* manifest=set->view;
  manifest->hostPid=GetCurrentProcessId();manifest->hostCreation=nozeli_launch_set::Creation(GetCurrentProcess());memcpy(manifest->leaseId,id.c_str(),37);
  const std::wstring hex=L"0123456789abcdef";for(size_t i=0;i<32;i++)manifest->sourceSha256[i]=static_cast<BYTE>(hex.find(digest[i*2])*16+hex.find(digest[i*2+1]));
  BYTE nonce[32];if(BCryptGenRandom(nullptr,nonce,sizeof(nonce),BCRYPT_USE_SYSTEM_PREFERRED_RNG))throw Failure("HOST_LAUNCH_SET_CREATE_FAILED","Cannot allocate launch history identity");
  for(size_t i=0;i<32;i++){manifest->nonce[i*2]=static_cast<char>(hex[nonce[i]>>4]);manifest->nonce[i*2+1]=static_cast<char>(hex[nonce[i]&15]);}
  napi_value result;Check(napi_create_object(env,&result));Check(napi_type_tag_object(env,result,&launchSetTag));Text(env,result,"id",manifest->nonce);Number(env,result,"limit",nozeli_launch_set::limit);
  napi_property_descriptor methods[]={{"reserve",nullptr,ReserveLaunch,nullptr,nullptr,nullptr,napi_default,nullptr},{"close",nullptr,CloseLaunchSet,nullptr,nullptr,nullptr,napi_default,nullptr}};
  Check(napi_define_properties(env,result,2,methods));auto held=std::make_unique<std::shared_ptr<LaunchSet>>(set);
  Check(napi_wrap(env,result,held.get(),[](napi_env,void* data,void*){delete static_cast<std::shared_ptr<LaunchSet>*>(data);},nullptr,nullptr));held.release();return result;
});}
napi_value ColdLaunchSet(napi_env env,HANDLE mapping,HANDLE host,const BYTE* source){
  napi_value result;if(!mapping||mapping==INVALID_HANDLE_VALUE){Check(napi_get_null(env,&result));return result;}
  if(WaitForSingleObject(host,0)!=WAIT_OBJECT_0){Check(napi_get_null(env,&result));return result;}
  const auto* view=static_cast<const nozeli_launch_set::Manifest*>(MapViewOfFile(mapping,FILE_MAP_READ,0,0,sizeof(nozeli_launch_set::Manifest)));
  if(!view)throw Failure("HOST_LAUNCH_SET_UNVERIFIED","Cannot read retained launch history",GetLastError());
  auto copy=std::make_unique<nozeli_launch_set::Manifest>(*view);UnmapViewOfFile(view);
  if(!nozeli_launch_set::Valid(*copy,host,source))throw Failure("HOST_LAUNCH_SET_UNVERIFIED","Original host launch history is incomplete or differs from source");
  Check(napi_create_object(env,&result));Number(env,result,"schema",1);Text(env,result,"id",copy->nonce);Text(env,result,"leaseId",copy->leaseId);Boolean(env,result,"hostExited",true);
  napi_value entries;Check(napi_create_array_with_length(env,copy->count,&entries));
  for(uint32_t i=0;i<copy->count;i++){
    const auto& entry=copy->entries[i];napi_value value;Check(napi_create_object(env,&value));
    Text(env,value,"launchId",entry.launchId);Boolean(env,value,"prepared",entry.prepared==1);Number(env,value,"leaderPid",entry.leaderPid);Text(env,value,"leaderCreationTime100ns",std::to_string(entry.leaderCreation));
    Number(env,value,"supervisorPid",entry.supervisorPid);Text(env,value,"supervisorCreationTime100ns",std::to_string(entry.supervisorCreation));Check(napi_set_element(env,entries,i,value));
  }
  Check(napi_set_named_property(env,result,"entries",entries));return result;
}
