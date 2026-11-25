#pragma once
#include "anchored-common.h"

namespace nozeli_windows {
// No process-wide privilege changes or arbitrary SID/policy inputs. Native file
// creation receives this descriptor before the entry can contain private bytes.
struct PrivateSecurity {
  std::vector<BYTE> user, acl;
  SECURITY_DESCRIPTOR descriptor{};
  explicit PrivateSecurity(bool directory) {
    HANDLE impersonation = INVALID_HANDLE_VALUE;
    if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &impersonation)) {
      CloseHandle(impersonation);
      throw Failure("FS_SECURITY_UNSUPPORTED", "Private creation under impersonation is unqualified");
    }
    if (GetLastError() != ERROR_NO_TOKEN)
      throw Failure("FS_SECURITY_UNSUPPORTED", "Cannot establish thread security context", GetLastError());
    HANDLE tokenValue = INVALID_HANDLE_VALUE;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tokenValue))
      throw Failure("FS_SECURITY_UNSUPPORTED", "Cannot inspect process token", GetLastError());
    Handle token(tokenValue);
    DWORD size = 0;
    GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
    if (!size || size > 65536)
      throw Failure("FS_SECURITY_UNSUPPORTED", "Cannot size process user SID", GetLastError());
    user.resize(size);
    if (!GetTokenInformation(token.value, TokenUser, user.data(), size, &size))
      throw Failure("FS_SECURITY_UNSUPPORTED", "Cannot read process user SID", GetLastError());
    const auto sid = reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
    if (!IsValidSid(sid)) throw Failure("FS_SECURITY_UNSUPPORTED", "Invalid process user SID");
    acl.resize(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(sid));
    auto dacl = reinterpret_cast<PACL>(acl.data());
    const DWORD inheritance = directory ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0;
    if (!InitializeAcl(dacl, static_cast<DWORD>(acl.size()), ACL_REVISION) ||
        !AddAccessAllowedAceEx(dacl, ACL_REVISION, inheritance, FILE_ALL_ACCESS, sid) ||
        !InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorOwner(&descriptor, sid, FALSE) ||
        !SetSecurityDescriptorDacl(&descriptor, TRUE, dacl, FALSE) ||
        !SetSecurityDescriptorControl(&descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED))
      throw Failure("FS_SECURITY_UNSUPPORTED", "Cannot construct private security descriptor", GetLastError());
  }
  PrivateSecurity(const PrivateSecurity&) = delete;
  PrivateSecurity& operator=(const PrivateSecurity&) = delete;
};

struct SecuritySnapshot {
  std::vector<BYTE> bytes;
  static SecuritySnapshot Read(HANDLE file) {
    constexpr auto information = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
    DWORD size = 0;
    GetKernelObjectSecurity(file, information, nullptr, 0, &size);
    if (!size || size > 65536)
      throw Failure("FS_SECURITY_UNSUPPORTED", "Cannot size file security descriptor", GetLastError());
    SecuritySnapshot result;
    result.bytes.resize(size);
    if (!GetKernelObjectSecurity(file, information, result.bytes.data(), size, &size) ||
        !IsValidSecurityDescriptor(result.bytes.data()))
      throw Failure("FS_SECURITY_UNSUPPORTED", "Cannot read file security descriptor", GetLastError());
    return result;
  }
  PSECURITY_DESCRIPTOR Descriptor() const { return const_cast<BYTE*>(bytes.data()); }
  static bool Equal(PSECURITY_DESCRIPTOR a, PSECURITY_DESCRIPTOR b, bool group = true) {
    PSID ao = nullptr, bo = nullptr, ag = nullptr, bg = nullptr;
    BOOL ignored, ap, bp, ad, bd;
    PACL aa = nullptr, ba = nullptr;
    SECURITY_DESCRIPTOR_CONTROL ac = 0, bc = 0; DWORD revision;
    if (!GetSecurityDescriptorOwner(a, &ao, &ignored) || !GetSecurityDescriptorOwner(b, &bo, &ignored) ||
        !ao || !bo || !EqualSid(ao, bo) ||
        !GetSecurityDescriptorControl(a, &ac, &revision) || !GetSecurityDescriptorControl(b, &bc, &revision) ||
        (ac & SE_DACL_PROTECTED) != (bc & SE_DACL_PROTECTED) ||
        !GetSecurityDescriptorDacl(a, &ap, &aa, &ad) || !GetSecurityDescriptorDacl(b, &bp, &ba, &bd) ||
        ap != bp || !ap || !aa || !ba || !IsValidAcl(aa) || !IsValidAcl(ba)) return false;
    if (group && (!GetSecurityDescriptorGroup(a, &ag, &ignored) || !GetSecurityDescriptorGroup(b, &bg, &ignored) ||
        !ag || !bg || !EqualSid(ag, bg))) return false;
    ACL_SIZE_INFORMATION ai{}, bi{};
    if (!GetAclInformation(aa, &ai, sizeof(ai), AclSizeInformation) ||
        !GetAclInformation(ba, &bi, sizeof(bi), AclSizeInformation) || ai.AceCount != bi.AceCount) return false;
    // Compare each ACE, ignoring unused ACL capacity and bookkeeping padding.
    for (DWORD i = 0; i < ai.AceCount; i++) {
      void *ae, *be;
      if (!GetAce(aa, i, &ae) || !GetAce(ba, i, &be)) return false;
      const auto size = static_cast<ACE_HEADER*>(ae)->AceSize;
      if (size != static_cast<ACE_HEADER*>(be)->AceSize || memcmp(ae, be, size) != 0) return false;
    }
    return true;
  }
  bool Matches(HANDLE file) const {
    return Equal(Descriptor(), Read(file).Descriptor());
  }
  void RequirePrivate(bool directory) const {
    PrivateSecurity expected(directory);
    if (!Equal(Descriptor(), &expected.descriptor, false))
      throw Failure("FS_SECURITY_CHANGED", "Private owner or protected user-only DACL not established");
  }
  // SQLite creates journal files through its own Windows VFS. Such files may
  // inherit the sole user ACE from a private parent instead of being protected.
  // Accept only that exact access grant, never a general effective-access guess.
  void RequireInheritedUserFile() const {
    PrivateSecurity expected(false);
    auto descriptor = Descriptor();
    PSID owner = nullptr, user = nullptr; BOOL ignored, present, defaulted;
    PACL acl = nullptr; ACL_SIZE_INFORMATION information{}; void* entry = nullptr;
    if (!GetSecurityDescriptorOwner(descriptor, &owner, &ignored) || !owner ||
        !GetSecurityDescriptorOwner(&expected.descriptor, &user, &ignored) || !EqualSid(owner, user) ||
        !GetSecurityDescriptorDacl(descriptor, &present, &acl, &defaulted) || !present || !acl ||
        !IsValidAcl(acl) || !GetAclInformation(acl, &information, sizeof(information), AclSizeInformation) ||
        information.AceCount != 1 || !GetAce(acl, 0, &entry))
      throw Failure("FS_SECURITY_CHANGED", "SQLite file must grant access only to the current user");
    const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(entry);
    if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
        (ace->Header.AceFlags & ~INHERITED_ACE) || ace->Mask != FILE_ALL_ACCESS ||
        ace->Header.AceSize < sizeof(ACCESS_ALLOWED_ACE) ||
        !IsValidSid(&ace->SidStart) || !EqualSid(&ace->SidStart, user))
      throw Failure("FS_SECURITY_CHANGED", "SQLite file has an unqualified access policy");
  }
};
} // namespace nozeli_windows
