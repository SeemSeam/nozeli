#pragma once
// Private, in-process ABI shared by the two Node-API modules. JS sees only a
// type-tagged object. Numeric HANDLEs exist solely in bounded native handoff.
#include "anchored-security.h"
#include <bcrypt.h>
namespace nozeli_custody {
using namespace nozeli_windows;
constexpr uint32_t magic=0x4e5a4331,version=4,limit=256,securityLimit=4096;
constexpr napi_type_tag tag={0x19dd6e22a79346dcULL,0x81240e730302c757ULL};
enum class Kind:uint32_t { directory=1,anchor=2,database=3,catalog=4,projectDatabase=5,projectManifest=6,ownerHome=7 };
inline bool Directory(Kind kind){return kind==Kind::directory||kind==Kind::ownerHome;}
inline bool Database(Kind kind){return kind==Kind::database||kind==Kind::catalog||kind==Kind::projectDatabase;}
struct Frame {
  uint64_t handle=0;
  Kind kind=Kind::directory;
  uint32_t securitySize=0;
  Snapshot initial{};
  BYTE security[securityLimit]{};
};
struct Manifest { uint32_t magicValue=magic,versionValue=version,count=0,reserved=0;BYTE sourceSha256[32]{};Frame frames[limit]{}; };
inline std::string OwnerHomeIdentity(const Manifest& manifest){
  for(uint32_t i=0;i<manifest.count;i++)if(manifest.frames[i].kind==Kind::ownerHome){
    const auto& id=manifest.frames[i].initial.id;char text[64]{};
    int length=sprintf_s(text,"%016llx:",static_cast<unsigned long long>(id.VolumeSerialNumber));
    for(auto byte:id.FileId.Identifier)length+=sprintf_s(text+length,sizeof(text)-length,"%02x",byte);
    return text;
  }return {};
}
inline void Verify(const Frame& frame) {
  if(frame.securitySize>securityLimit||frame.kind<Kind::directory||frame.kind>Kind::ownerHome||
     (frame.kind!=Kind::directory&&!frame.securitySize))
    throw Failure("CUSTODY_SPEC_INVALID","Unknown custody entity or policy");
  const auto handle=reinterpret_cast<HANDLE>(frame.handle);
  const bool directory=Directory(frame.kind);
  const auto now=Inspect(handle,directory);
  if(Database(frame.kind)){
    if(now.id.VolumeSerialNumber!=frame.initial.id.VolumeSerialNumber||
       memcmp(now.id.FileId.Identifier,frame.initial.id.FileId.Identifier,16)||
       now.basic.FileAttributes!=frame.initial.basic.FileAttributes||now.standard.NumberOfLinks!=1)
      throw Failure("CUSTODY_ENTITY_CHANGED","Database custody entity changed");
  }else if(!Same(frame.initial,now,directory)||(!directory&&now.standard.NumberOfLinks!=1))
    throw Failure("CUSTODY_ENTITY_CHANGED","Custody entity changed");
  if(frame.securitySize){
    // Never let malformed shared-memory bytes reach ACL traversal APIs.
    SECURITY_DESCRIPTOR_RELATIVE relative{};
    if(frame.securitySize<sizeof(relative))throw Failure("CUSTODY_SPEC_INVALID","Truncated custody policy");
    memcpy(&relative,frame.security,sizeof(relative));
    const DWORD length=frame.securitySize;
    const auto boundedSid=[&](DWORD offset){
      if(offset<sizeof(relative)||offset>length-8)return false;
      const auto count=frame.security[offset+1];return count<=SID_MAX_SUB_AUTHORITIES&&offset+8+count*4<=length;
    };
    const auto boundedAcl=[&](DWORD offset){
      if(!offset)return true;
      if(offset<sizeof(relative)||offset>length-sizeof(ACL))return false;
      ACL acl{};memcpy(&acl,frame.security+offset,sizeof(acl));
      if(acl.AclSize<sizeof(ACL)||acl.AclSize>length-offset)return false;
      DWORD position=sizeof(ACL);
      for(WORD i=0;i<acl.AceCount;i++){
        if(position>acl.AclSize-sizeof(ACE_HEADER))return false;
        ACE_HEADER ace{};memcpy(&ace,frame.security+offset+position,sizeof(ace));
        if(ace.AceSize<sizeof(ACE_HEADER)||ace.AceSize>acl.AclSize-position)return false;position+=ace.AceSize;
      }
      return true;
    };
    if(!boundedSid(relative.Owner)||!boundedSid(relative.Group)||!boundedAcl(relative.Dacl)||!boundedAcl(relative.Sacl))
      throw Failure("CUSTODY_SPEC_INVALID","Custody policy extends outside its bounded frame");
    if(!(relative.Control&SE_SELF_RELATIVE)||!IsValidSecurityDescriptor(const_cast<BYTE*>(frame.security))||
       GetSecurityDescriptorLength(const_cast<BYTE*>(frame.security))!=length)
      throw Failure("CUSTODY_SPEC_INVALID","Invalid custody policy");
    if(!SecuritySnapshot::Equal(const_cast<BYTE*>(frame.security),SecuritySnapshot::Read(handle).Descriptor()))
      throw Failure("CUSTODY_SECURITY_CHANGED","Custody access policy changed");
  }
}
inline void Verify(const Manifest& manifest) {
  if(manifest.magicValue!=magic||manifest.versionValue!=version||manifest.reserved||manifest.count<2||manifest.count>limit)
    throw Failure("CUSTODY_SPEC_INVALID","Invalid bounded custody manifest");
  unsigned roles[6]{};
  for(uint32_t i=0;i<manifest.count;i++){
    Verify(manifest.frames[i]);const auto role=static_cast<unsigned>(manifest.frames[i].kind);
    if(role>=2)roles[role-2]++;
  }
  if(roles[0]!=1||roles[1]!=1||roles[5]>1||(roles[5]&&roles[2]!=1)||!((roles[2]==0&&roles[3]==0&&roles[4]==0)||(roles[2]==1&&roles[3]==1&&roles[4]==1)))
    throw Failure("CUSTODY_SPEC_INVALID","Exact host pair and optional complete source custody required");
  bool sourceDigest=false;for(auto byte:manifest.sourceSha256)sourceDigest|=byte!=0;
  if(sourceDigest!=(roles[2]==1))throw Failure("CUSTODY_SPEC_INVALID","Source digest must bind complete source custody");
}
inline uint32_t Roles(const Manifest& manifest){
  uint32_t roles=0;for(uint32_t i=0;i<manifest.count;i++){
    const auto role=static_cast<unsigned>(manifest.frames[i].kind);if(role>=2&&role<=7)roles|=1u<<(role-2);
  }return roles;
}
inline void Digest(const Manifest& manifest,BYTE (&digest)[32]) {
  // Handle values are transient and excluded from the persisted fingerprint.
  auto copy=std::make_unique<Manifest>(manifest);
  for(uint32_t i=0;i<copy->count;i++)copy->frames[i].handle=0;
  const auto size=offsetof(Manifest,frames)+copy->count*sizeof(Frame);
  if(BCryptHash(BCRYPT_SHA256_ALG_HANDLE,nullptr,0,reinterpret_cast<BYTE*>(copy.get()),static_cast<ULONG>(size),digest,sizeof(digest))<0)
    throw Failure("CUSTODY_HASH_FAILED","Cannot fingerprint custody entities");
}
struct Bundle {
  uint32_t versionValue=version;
  bool consumed=false;
  std::unique_ptr<Manifest> manifest=std::make_unique<Manifest>();
  std::vector<std::unique_ptr<Handle>> handles;
  void Verify() const {
    if(!manifest)throw Failure("CUSTODY_CLOSED","Custody bundle closed");
    nozeli_custody::Verify(*manifest);
  }
};
// Shared in-process ABI for the restricted original file-object pin. The tag
// never changes a serialized summary into authority and exposes no HANDLE.
constexpr napi_type_tag coldAnchorTag={0x17095d22cf234ab1ULL,0x9b01eac27c3815b4ULL};
struct ColdAnchor {
  Handle file{INVALID_HANDLE_VALUE};
  Frame frame{};
  void Verify() const {
    if(file.value==INVALID_HANDLE_VALUE)throw Failure("COLD_ANCHOR_CLOSED","Original cold anchor pin closed");
    if(frame.kind!=Kind::anchor||frame.handle!=reinterpret_cast<uint64_t>(file.value))
      throw Failure("COLD_ANCHOR_UNVERIFIED","Exact original cold anchor frame required");
    nozeli_custody::Verify(frame);
  }
};
}
