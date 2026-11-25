// Included inside process-identity.cc's anonymous namespace.
struct QuitNode {
  HANDLE handle = nullptr;
  DWORD pid = 0, parent = 0;
  ULONGLONG birth = 0;
  bool browser = false;
  ~QuitNode() { if (handle) CloseHandle(handle); }
};
struct QuitCapture {
  std::vector<std::unique_ptr<QuitNode>> nodes;
  bool closed = false;
  DWORD unknown = 0;
  void Close() { nodes.clear(); closed = true; }
};
constexpr napi_type_tag quitTag = {0x920b182ac7df4301ULL,0xa0304c4f7125aa29ULL};
std::vector<BYTE> QuitSid(HANDLE process) {
  HANDLE raw = nullptr;
  if (!OpenProcessToken(process,TOKEN_QUERY,&raw)) throw Failure("PROCESS_ANCESTRY_UNKNOWN","Cannot verify process account",GetLastError());
  struct Token { HANDLE value; ~Token(){CloseHandle(value);} } token{raw};
  DWORD size=0; GetTokenInformation(raw,TokenUser,nullptr,0,&size);
  if (!size) throw Failure("PROCESS_ANCESTRY_UNKNOWN","Cannot size process account",GetLastError());
  std::vector<BYTE> bytes(size);
  if (!GetTokenInformation(raw,TokenUser,bytes.data(),size,&size)) throw Failure("PROCESS_ANCESTRY_UNKNOWN","Cannot verify process account",GetLastError());
  const auto sid=reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid;
  std::vector<BYTE> result(GetLengthSid(sid));
  if (!CopySid(static_cast<DWORD>(result.size()),result.data(),sid)) throw Failure("PROCESS_ANCESTRY_UNKNOWN","Cannot retain process account",GetLastError());
  return result;
}
DWORD QuitPinnedParent(HANDLE process) {
  // Toolhelp rows can outlive a PID incarnation. Query the opened HANDLE's
  // actual parent before retaining it; a stale row is never kill authority.
  struct Basic { LONG status; void* peb; ULONG_PTR affinity; LONG priority; ULONG_PTR pid; ULONG_PTR parent; } basic{};
  using Query = LONG (NTAPI*)(HANDLE, ULONG, void*, ULONG, ULONG*);
  const auto query = reinterpret_cast<Query>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess"));
  if (!query || query(process, 0, &basic, sizeof(basic), nullptr) < 0 ||
      basic.pid != GetProcessId(process) || !basic.parent || basic.parent > 0xffffffff)
    throw Failure("PROCESS_ANCESTRY_UNKNOWN", "Cannot verify pinned process ancestry");
  return static_cast<DWORD>(basic.parent);
}
std::unique_ptr<QuitNode> QuitOpen(DWORD pid,DWORD parent,const std::vector<BYTE>& account,bool terminate) {
  auto node=std::make_unique<QuitNode>(); node->pid=pid;node->parent=parent;
  node->handle=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE|(terminate?PROCESS_TERMINATE:0),FALSE,pid);
  if (!node->handle) throw Failure("PROCESS_ANCESTRY_UNKNOWN","Cannot pin descendant",GetLastError());
  FILETIME birth{},exit{},kernel{},user{};
  if (!GetProcessTimes(node->handle,&birth,&exit,&kernel,&user)||WaitForSingleObject(node->handle,0)!=WAIT_TIMEOUT)
    throw Failure("PROCESS_ANCESTRY_UNKNOWN","Descendant is no longer live",GetLastError());
  if (parent && QuitPinnedParent(node->handle) != parent)
    throw Failure("PROCESS_ANCESTRY_UNKNOWN", "Snapshot parent differs from the original process HANDLE");
  node->birth=Time(birth);
  auto sid=QuitSid(node->handle);
  if (!EqualSid(sid.data(),const_cast<BYTE*>(account.data()))) throw Failure("PROCESS_ANCESTRY_UNKNOWN","Descendant account differs");
  return node;
}
std::wstring QuitImage(HANDLE handle) {
  std::vector<wchar_t> bytes(32768);DWORD size=static_cast<DWORD>(bytes.size());
  if (!QueryFullProcessImageNameW(handle,0,bytes.data(),&size)) throw Failure("PROCESS_ANCESTRY_UNKNOWN","Cannot identify process image",GetLastError());
  return std::wstring(bytes.data(),size);
}
QuitCapture* QuitReceiver(napi_env env,napi_callback_info info) {
  napi_value self;size_t count=0;Check(napi_get_cb_info(env,info,&count,nullptr,&self,nullptr));
  bool tagged=false;Check(napi_check_object_type_tag(env,self,&quitTag,&tagged));
  if (!tagged) throw Failure("PROCESS_HANDLE_RECEIVER","Original descendant capture required");
  QuitCapture* capture=nullptr;Check(napi_unwrap(env,self,reinterpret_cast<void**>(&capture)));return capture;
}
napi_value QuitClose(napi_env env,napi_callback_info info) { return Guard(env,[&]{QuitReceiver(env,info)->Close();napi_value value;Check(napi_get_undefined(env,&value));return value;}); }
napi_value QuitTerminate(napi_env env,napi_callback_info info) { return Guard(env,[&]{
  auto* capture=QuitReceiver(env,info);
  if(capture->closed)throw Failure("PROCESS_HANDLE_CLOSED","Descendant capture closed");
  DWORD requested=0,exited=0,unknown=capture->unknown,skipped=0;
  auto account=QuitSid(GetCurrentProcess());
  for(auto it=capture->nodes.rbegin();it!=capture->nodes.rend();++it){
    auto& node=**it;if(node.pid==GetCurrentProcessId())continue;
    if(node.browser){skipped++;continue;}
    if(WaitForSingleObject(node.handle,0)==WAIT_OBJECT_0){exited++;continue;}
    try { auto sid=QuitSid(node.handle);if(!EqualSid(sid.data(),account.data())){unknown++;continue;}
      FILETIME birth{},exit{},kernel{},user{};
      if(!GetProcessTimes(node.handle,&birth,&exit,&kernel,&user)||Time(birth)!=node.birth){unknown++;continue;}
      if(TerminateProcess(node.handle,1))requested++;else unknown++;
    }catch(const Failure&){unknown++;}
  }
  napi_value result;Check(napi_create_object(env,&result));Number(env,result,"terminationRequested",requested);Number(env,result,"alreadyExited",exited);Number(env,result,"unknown",unknown);Number(env,result,"browserSkipped",skipped);
  Boolean(env,result,"treeExitVerified",false);Text(env,result,"scope","captured-descendant-handles-only");return result;
}); }
napi_value CaptureQuitDescendants(napi_env env,napi_callback_info info) { return Guard(env,[&]{
  size_t count=2;napi_value args[2];Check(napi_get_cb_info(env,info,&count,args,nullptr,nullptr));
  uint32_t root=GetCurrentProcessId();bool preserve=false;
  if(count>0) { double value=0;Check(napi_get_value_double(env,args[0],&value));if(!std::isfinite(value)||value!=GetCurrentProcessId())throw Failure("PROCESS_ROOT_INVALID","Force-quit capture requires current process root");root=static_cast<DWORD>(value); }
  if(count>1)Check(napi_get_value_bool(env,args[1],&preserve));
  auto capture=std::make_unique<QuitCapture>();auto account=QuitSid(GetCurrentProcess());
  capture->nodes.push_back(QuitOpen(root,0,account,false));
  const auto image=preserve?QuitImage(capture->nodes[0]->handle):std::wstring();
  HANDLE raw=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);
  if(raw==INVALID_HANDLE_VALUE)throw Failure("PROCESS_ANCESTRY_UNKNOWN","Cannot enumerate descendants",GetLastError());
  struct SnapshotHandle {HANDLE handle;~SnapshotHandle(){CloseHandle(handle);}} snapshot{raw};
  std::vector<PROCESSENTRY32W> rows;PROCESSENTRY32W row{};row.dwSize=sizeof(row);
  if(!Process32FirstW(raw,&row))throw Failure("PROCESS_ANCESTRY_UNKNOWN","Cannot read descendant enumeration",GetLastError());
  do{rows.push_back(row);}while(Process32NextW(raw,&row));
  if(GetLastError()!=ERROR_NO_MORE_FILES)throw Failure("PROCESS_ANCESTRY_UNKNOWN","Descendant enumeration incomplete",GetLastError());
  for(size_t index=0;index<capture->nodes.size();index++){
    auto* parent=capture->nodes[index].get();
    for(const auto& entry:rows){
      if(entry.th32ParentProcessID!=parent->pid||entry.th32ProcessID==root)continue;
      if(std::any_of(capture->nodes.begin(),capture->nodes.end(),[&](const auto& n){return n->pid==entry.th32ProcessID;}))continue;
      try{
        auto child=QuitOpen(entry.th32ProcessID,parent->pid,account,true);
        // A retained live parent HANDLE and monotonic birth establish the
        // snapshot ancestry; a reused parent PID cannot satisfy both.
        if(child->birth<parent->birth||WaitForSingleObject(parent->handle,0)!=WAIT_TIMEOUT){capture->unknown++;continue;}
        if(preserve){try{child->browser=_wcsicmp(QuitImage(child->handle).c_str(),image.c_str())==0;}catch(const Failure&){child->browser=true;}}
        capture->nodes.push_back(std::move(child));
      }catch(const Failure&){capture->unknown++; /* Unknown nodes are never signaled or claimed owned. */}
    }
  }
  napi_value result;Check(napi_create_object(env,&result));Check(napi_type_tag_object(env,result,&quitTag));
  napi_property_descriptor methods[]={
    {"terminate",nullptr,QuitTerminate,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"close",nullptr,QuitClose,nullptr,nullptr,nullptr,napi_default,nullptr}};
  Check(napi_define_properties(env,result,2,methods));Number(env,result,"capturedCount",static_cast<DWORD>(capture->nodes.size()-1));Boolean(env,result,"treeExitVerified",false);
  Number(env,result,"captureUnknown",capture->unknown);
  Check(napi_wrap(env,result,capture.get(),[](napi_env,void* data,void*){delete static_cast<QuitCapture*>(data);},nullptr,nullptr));capture.release();return result;
}); }
void InitForceQuitBindings(napi_env env,napi_value exports) {
  napi_value capture;Check(napi_create_function(env,"captureForceQuitDescendants",NAPI_AUTO_LENGTH,CaptureQuitDescendants,nullptr,&capture));
  Check(napi_set_named_property(env,exports,"captureForceQuitDescendants",capture));
}
