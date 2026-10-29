// Nozeli's macOS bridge. Only descriptor-relative filesystem operations and
// kernel process facts live here. Policy, streaming I/O and ownership stay in JS.
#include <node_api.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/attr.h>
#include <sys/sysctl.h>
#include <sys/proc_info.h>
#include <libproc.h>
#include <dlfcn.h>
#include <unistd.h>
#include <fcntl.h>
#include <dirent.h>
#include <cerrno>
#include <cstring>
#include <cstdio>
#include <string>
#include <vector>
#include <set>
#include <stdexcept>

struct Failure { int number; std::string operation; };
static void check(bool ok, const char* op) { if (!ok) throw Failure{errno ? errno : EIO, op}; }
static void napiCheck(napi_status s) { if (s != napi_ok) throw std::invalid_argument("invalid bridge argument"); }
static napi_value number(napi_env e, int64_t n) { napi_value v; napiCheck(napi_create_int64(e,n,&v)); return v; }
static napi_value big(napi_env e, int64_t n) { napi_value v; napiCheck(napi_create_bigint_int64(e,n,&v)); return v; }
static napi_value string(napi_env e, const std::string& s) { napi_value v; napiCheck(napi_create_string_utf8(e,s.data(),s.size(),&v)); return v; }
static napi_value object(napi_env e) { napi_value v; napiCheck(napi_create_object(e,&v)); return v; }
static napi_value array(napi_env e) { napi_value v; napiCheck(napi_create_array(e,&v)); return v; }
static bool validUtf8(const std::string& s) {
  for(size_t i=0;i<s.size();){unsigned char first=s[i++];if(first<0x80)continue;int more;uint32_t cp,min;
    if(first>=0xc2&&first<=0xdf){more=1;cp=first&31;min=0x80;}else if(first>=0xe0&&first<=0xef){more=2;cp=first&15;min=0x800;}else if(first>=0xf0&&first<=0xf4){more=3;cp=first&7;min=0x10000;}else return false;
    if(i+more>s.size())return false;while(more--){unsigned char c=s[i++];if((c&0xc0)!=0x80)return false;cp=(cp<<6)|(c&63);}if(cp<min||cp>0x10ffff||(cp>=0xd800&&cp<=0xdfff))return false;
  }return true;
}
static void set(napi_env e,napi_value o,const char* k,napi_value v) { napiCheck(napi_set_named_property(e,o,k,v)); }
static int integer(napi_env e,napi_value v) { int32_t n; napiCheck(napi_get_value_int32(e,v,&n)); return n; }
static std::string text(napi_env e,napi_value v,bool leaf=true) {
  size_t n; napiCheck(napi_get_value_string_utf8(e,v,nullptr,0,&n));
  if(n>4096) throw std::invalid_argument("bridge name too long");
  std::vector<char> b(n+1); napiCheck(napi_get_value_string_utf8(e,v,b.data(),b.size(),&n));
  std::string s(b.data(),n);
  if(s.empty()||s.find('\0')!=std::string::npos||(leaf&&(s=="."||s==".."||s.find('/')!=std::string::npos))) throw std::invalid_argument("expected one directory entry name");
  return s;
}
struct FD { int fd; explicit FD(int f):fd(f) {} ~FD(){if(fd>=0)close(fd);} FD(const FD&)=delete; };
static napi_value statValue(napi_env e,const struct stat& s) {
  auto o=object(e);
  set(e,o,"dev",big(e,s.st_dev));set(e,o,"ino",big(e,s.st_ino));set(e,o,"mode",big(e,s.st_mode));set(e,o,"nlink",big(e,s.st_nlink));set(e,o,"size",big(e,s.st_size));
  set(e,o,"mtimeNs",big(e,s.st_mtimespec.tv_sec*1000000000LL+s.st_mtimespec.tv_nsec));set(e,o,"ctimeNs",big(e,s.st_ctimespec.tv_sec*1000000000LL+s.st_ctimespec.tv_nsec));
  return o;
}
static std::string boot() {
  char value[128]={};size_t size=sizeof(value);check(sysctlbyname("kern.bootsessionuuid",value,&size,nullptr,0)==0,"boot session");
  if(size<2||size>sizeof(value)||value[size-1]!='\0') throw Failure{EIO,"incomplete boot session"};
  return std::string(value,size-1);
}
static bool processInfo(int pid,struct proc_bsdinfo& p) {
  if(pid<=0) throw std::invalid_argument("invalid PID");
  errno=0;int n=proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&p,sizeof(p));
  if(n==0&&errno==ESRCH)return false;
  check(n==sizeof(p),"process identity");
  return p.pbi_status!=5; // SZOMB: it cannot own a live process instance.
}
static std::string stamp(const struct proc_bsdinfo& p) {
  return "darwin:"+boot()+":"+std::to_string(p.pbi_start_tvsec)+":"+std::to_string(p.pbi_start_tvusec);
}
static napi_value process(napi_env e,int pid,int mode) {
  struct proc_bsdinfo p={};napi_value nil;napi_get_null(e,&nil);if(!processInfo(pid,p))return nil;
  auto o=object(e);set(e,o,"pid",number(e,p.pbi_pid));set(e,o,"ppid",number(e,p.pbi_ppid));set(e,o,"pgid",number(e,p.pbi_pgid));set(e,o,"uid",number(e,p.pbi_uid));set(e,o,"state",number(e,p.pbi_status));set(e,o,"stamp",string(e,stamp(p)));
  if(mode!=0){
    if(mode!=1&&mode!=2)throw std::invalid_argument("invalid process query mode");
    // CS_RESTRICT targets can return a successful but redacted PROCARGS2 result.
    // Reject them before parsing. Values are XNU csops.h ABI constants.
    using Csops=int(*)(pid_t,unsigned int,void*,size_t);
    auto csops=reinterpret_cast<Csops>(dlsym(RTLD_DEFAULT,"csops"));uint32_t csflags=0;
    if(!csops)throw Failure{ENOTSUP,"code signing process status unavailable"};
    check(csops(pid,0,&csflags,sizeof(csflags))==0,"code signing process status");
    if(csflags&0x00000800)throw Failure{EACCES,"process environment restricted by kernel"};
    int argmax=0;size_t size=sizeof(argmax);int maxmib[]={CTL_KERN,KERN_ARGMAX};
    check(sysctl(maxmib,2,&argmax,&size,nullptr,0)==0,"argument bound");
    if(argmax<sizeof(int)||argmax>16*1024*1024)throw Failure{EOVERFLOW,"argument bound"};
    std::vector<char> bytes(argmax);size=bytes.size();int mib[]={CTL_KERN,KERN_PROCARGS2,pid};
    check(sysctl(mib,3,bytes.data(),&size,nullptr,0)==0,"process arguments");
    if(size<sizeof(int)||size>=bytes.size())throw Failure{EIO,"incomplete arguments"};
    int argc=0;memcpy(&argc,bytes.data(),sizeof(argc));if(argc<1||argc>argmax)throw Failure{EIO,"invalid argument count"};
    char* at=bytes.data()+sizeof(argc);char* end=bytes.data()+size;
    auto next=[&](){char* zero=static_cast<char*>(memchr(at,0,end-at));if(!zero)throw Failure{EIO,"incomplete argument entry"};std::string s(at,zero-at);if(!validUtf8(s))throw Failure{EILSEQ,"non-UTF8 process entry"};at=zero+1;return s;};
    // XNU exec_extract_strings aligns executable_path=<path> to the
    // target pointer width. Skip exactly that padding, never empty argv[0].
    // KERN_PROCARGS2 strips the 16-byte executable_path= prefix.
    const auto executable=next();
    const size_t width=(p.pbi_flags & PROC_FLAG_LP64)?8:4;
    const size_t padding=(width-((16+executable.size()+1)%width))%width;
    if(size_t(end-at)<padding)throw Failure{EIO,"truncated argument padding"};
    for(size_t i=0;i<padding;i++)if(*at++)throw Failure{EIO,"unexpected argument layout"};
    auto argv=array(e),env=array(e);
    for(int i=0;i<argc;i++){if(at>=end)throw Failure{EIO,"truncated argv"};napiCheck(napi_set_element(e,argv,i,string(e,next())));}
    if(mode==2){
      // Runtimes such as Bun erase consumed applev entries in the initial stack.
      // That makes a COMPLETE environment boundary unavailable. Ownership only
      // needs these three exact keys, which XNU never emits as auxiliary keys.
      // Inspect every remaining NUL-delimited slot, including after zeroed slots,
      // reject duplicate ownership keys, and expose no unrelated/auxiliary values.
      std::set<std::string> seen;uint32_t index=0;
      while(at<end){const auto value=next();const auto equal=value.find('=');if(equal==std::string::npos)continue;const auto key=value.substr(0,equal);
        if(key!="NOZELI_AGENT_DIR"&&key!="PI_CODING_AGENT_DIR"&&key!="CODEX_HOME")continue;
        if(!seen.insert(key).second)throw Failure{EACCES,"ambiguous ownership environment"};
        napiCheck(napi_set_element(e,env,index++,string(e,value)));
      }
      set(e,o,"environmentScope",string(e,"ownership-only"));
    }else{
    // XNU places the applev block after argv+env padding. If that area
    // happens to be pointer-aligned, there is no empty string between env and
    // applev. Its mandatory first entry is pfz; never expose auxiliary secrets
    // as environment. Restricted processes were refused above.
    char* apple=nullptr;
    for(char* candidate=at;candidate+7<end;candidate++){
      if((candidate==at||candidate[-1]==0)&&memcmp(candidate,"pfz=0x",6)==0)apple=candidate;
    }
    if(!apple||((apple-bytes.data()-sizeof(int)+16)%width)!=0)throw Failure{EACCES,"unverified environment boundary"};
    char* auxiliary=apple;
    auto appleNext=[&](){char* zero=static_cast<char*>(memchr(auxiliary,0,end-auxiliary));if(!zero)throw Failure{EIO,"truncated auxiliary entry"};std::string s(auxiliary,zero-auxiliary);auxiliary=zero+1;return s;};
    appleNext();auto guard=appleNext();if(guard=="MallocNanoZone=1")guard=appleNext();
    if(guard.rfind("stack_guard=",0)!=0||appleNext().rfind("malloc_entropy=",0)!=0||appleNext().rfind("ptr_munge=",0)!=0)throw Failure{EACCES,"unknown auxiliary layout"};
    uint32_t i=0;while(at<apple&&*at){auto s=next();if(at>apple||s.find('=')==std::string::npos)throw Failure{EIO,"invalid environment entry"};napiCheck(napi_set_element(e,env,i++,string(e,s)));}
    if(apple-at>=width)throw Failure{EIO,"unexpected environment padding"};
    while(at<apple)if(*at++)throw Failure{EIO,"unexpected environment tail"};
    set(e,o,"environmentScope",string(e,"complete"));
    }
    set(e,o,"argv",argv);set(e,o,mode==2?"ownershipEnviron":"environ",env);
    struct proc_bsdinfo after={};if(!processInfo(pid,after))return nil;
    if(after.pbi_start_tvsec!=p.pbi_start_tvsec||after.pbi_start_tvusec!=p.pbi_start_tvusec||after.pbi_uid!=p.pbi_uid||after.pbi_pgid!=p.pbi_pgid||after.pbi_ppid!=p.pbi_ppid)throw Failure{ESTALE,"process changed during query"};
    uint32_t afterFlags=0;check(csops(pid,0,&afterFlags,sizeof(afterFlags))==0,"code signing process status recheck");if(afterFlags!=csflags)throw Failure{ESTALE,"process signing status changed during query"};
  }
  return o;
}
static napi_value dispatch(napi_env e,napi_callback_info info) {
  try {
    size_t argc=8;napi_value a[8];void* data;napiCheck(napi_get_cb_info(e,info,&argc,a,nullptr,&data));
    const std::string op=static_cast<const char*>(data);
    auto arg=[&](size_t i){if(i>=argc)throw std::invalid_argument("missing bridge argument");return a[i];};
    auto fd=[&](size_t i){int n=integer(e,arg(i));if(n<0)throw std::invalid_argument("invalid descriptor");return n;};
    auto name=[&](size_t i){return text(e,arg(i));};
    if(op=="openAt") {int result=openat(fd(0),name(1).c_str(),integer(e,arg(2))|O_NOFOLLOW|O_CLOEXEC,integer(e,arg(3)));check(result>=0,"openat");return number(e,result);}
    if(op=="statAt") {struct stat s;check(fstatat(fd(0),name(1).c_str(),&s,AT_SYMLINK_NOFOLLOW)==0,"fstatat");return statValue(e,s);}
    if(op=="mkdirAt") {check(mkdirat(fd(0),name(1).c_str(),integer(e,arg(2)))==0,"mkdirat");return number(e,0);}
    if(op=="unlinkAt") {check(unlinkat(fd(0),name(1).c_str(),integer(e,arg(2))?AT_REMOVEDIR:0)==0,"unlinkat");return number(e,0);}
    if(op=="renameAt") {check(renameatx_np(fd(0),name(1).c_str(),fd(2),name(3).c_str(),(integer(e,arg(4))==2?RENAME_SWAP:integer(e,arg(4))==1?RENAME_EXCL:0))==0,"renameatx_np");return number(e,0);}
    if(op=="readDir") {
      int copy=openat(fd(0),".",O_RDONLY|O_DIRECTORY|O_CLOEXEC);check(copy>=0,"open directory enumeration");
      DIR* d=fdopendir(copy);if(!d){int saved=errno;close(copy);throw Failure{saved,"fdopendir"};}
      auto result=array(e);uint32_t index=0;errno=0;
      while(auto entry=readdir(d)){if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;napi_set_element(e,result,index++,string(e,entry->d_name));errno=0;}
      int saved=errno;closedir(d);if(saved)throw Failure{saved,"readdir"};return result;
    }
    if(op=="volume") {
      struct statfs s;check(fstatfs(fd(0),&s)==0,"volume identity");
      struct attrlist attrs={};attrs.bitmapcount=ATTR_BIT_MAP_COUNT;attrs.volattr=ATTR_VOL_INFO|ATTR_VOL_CAPABILITIES;
      struct {uint32_t length;vol_capabilities_attr_t caps;} result={};
      check(fgetattrlist(fd(0),&attrs,&result,sizeof(result),0)==0,"volume capabilities");
      if(result.length!=sizeof(result)||!(result.caps.valid[VOL_CAPABILITIES_FORMAT]&VOL_CAP_FMT_CASE_SENSITIVE))throw Failure{ENOTSUP,"unknown filename semantics"};
      auto o=object(e);set(e,o,"type",string(e,s.f_fstypename));set(e,o,"caseSensitive",number(e,!!(result.caps.capabilities[VOL_CAPABILITIES_FORMAT]&VOL_CAP_FMT_CASE_SENSITIVE)));
      set(e,o,"exclusiveRename",number(e,!!(result.caps.valid[VOL_CAPABILITIES_INTERFACES]&result.caps.capabilities[VOL_CAPABILITIES_INTERFACES]&VOL_CAP_INT_RENAME_EXCL)));return o;
    }
    if(op=="bootSession")return string(e,boot());
    if(op=="processInfo")return process(e,integer(e,arg(0)),integer(e,arg(1)));
    if(op=="listProcesses") {
      for(int attempt=0;attempt<4;attempt++){
        errno=0;int needed=proc_listpids(PROC_UID_ONLY,getuid(),nullptr,0);if(needed<=0)throw Failure{errno?errno:EIO,"process scan size"};
        std::vector<pid_t> pids(needed/sizeof(pid_t)+256*(attempt+1));
        errno=0;int size=proc_listpids(PROC_UID_ONLY,getuid(),pids.data(),pids.size()*sizeof(pid_t));if(size<=0)throw Failure{errno?errno:EIO,"process scan"};
        if(size>=pids.size()*sizeof(pid_t))continue;
        if(size%sizeof(pid_t))throw Failure{EIO,"incomplete process scan"};
        auto result=array(e);uint32_t index=0;for(int i=0;i<size/sizeof(pid_t);i++)if(pids[i]>0)napi_set_element(e,result,index++,number(e,pids[i]));return result;
      }
      throw Failure{EOVERFLOW,"unstable process scan"};
    }
    throw std::invalid_argument("unknown bridge operation");
  } catch(const Failure& f) {
    const char* code="EIO";
    switch(f.number){case ESTALE:code="PROCESS_CHANGED";break;case EILSEQ:code="EILSEQ";break;case ENOENT:code="ENOENT";break;case ESRCH:code="ESRCH";break;case EACCES:code="EACCES";break;case EPERM:code="EPERM";break;case EEXIST:code="EEXIST";break;case ENOTDIR:code="ENOTDIR";break;case ELOOP:code="ELOOP";break;case ENOTEMPTY:code="ENOTEMPTY";break;case ENOTSUP:code="ENOTSUP";break;case EBADF:code="EBADF";break;case EINVAL:code="EINVAL";break;case EOVERFLOW:code="EOVERFLOW";break;case EXDEV:code="EXDEV";break;}
    napi_throw_error(e,code,(f.operation+": "+strerror(f.number)).c_str());return nullptr;
  } catch(const std::exception& x) {napi_throw_type_error(e,"ERR_INVALID_ARG_VALUE",x.what());return nullptr;}
}
static napi_value init(napi_env e,napi_value exports) {
  const char* names[]={"openAt","statAt","mkdirAt","unlinkAt","renameAt","readDir","volume","bootSession","processInfo","listProcesses"};
  for(auto name:names){napi_value fn;napi_create_function(e,name,NAPI_AUTO_LENGTH,dispatch,const_cast<char*>(name),&fn);napi_set_named_property(e,exports,name,fn);}return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
