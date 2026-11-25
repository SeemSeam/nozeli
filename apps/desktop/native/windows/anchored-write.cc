// Experimental W1 staging, no-replace publication and optional TxF replacement.
// Production CAS integration and namespace durability remain unqualified.
#include "anchored-common.h"
#include "anchored-security.h"
#include "custody-transfer.h"
#include <cstddef>
#include <ktmw32.h>

using namespace nozeli_windows;
namespace {
std::string DirectoryIdentityText(const Snapshot& snapshot);
struct DirectoryChain {
  std::shared_ptr<DirectoryChain> ancestor;
  std::unique_ptr<SecuritySnapshot> privateSecurity;
  std::unique_ptr<SecuritySnapshot> ancestorSecurity;
  size_t privateDepth = 0;
  bool privateTreeRoot = false;
  bool publicTreeRoot = false;
  bool privateTreePublished = false;
  bool privateDelete = false;
  std::wstring privateTreeName;
  std::vector<std::unique_ptr<Handle>> handles;
  std::vector<Snapshot> initial;
  // Public source leases observe actual ACLs without changing them. Only the
  // read-only source constructor fills this vector, one per retained HANDLE.
  std::vector<SecuritySnapshot> observedSecurity;
  bool directorySync = false;
  void Add(std::unique_ptr<Handle> h) {
    auto snapshot = Inspect(h->value, true);
    handles.push_back(std::move(h));
    initial.push_back(snapshot);
  }
  bool Stable() const {
    if (ancestor && !ancestor->Stable()) return false;
    if (ancestorSecurity && (!ancestor || !ancestorSecurity->Matches(ancestor->Parent()))) return false;
    if (privateSecurity && !privateSecurity->Matches(Parent())) return false;
    for (size_t i = 0; i < handles.size(); i++)
      if (!Same(initial[i], Inspect(handles[i]->value, true), true)) return false;
    for (size_t i = 0; i < observedSecurity.size(); i++)
      if (!observedSecurity[i].Matches(handles[i]->value)) return false;
    return true;
  }
  HANDLE Parent() const { return handles.back()->value; }
  void Sync() const {
    if (!directorySync)
      throw Failure("FS_DIRECTORY_SYNC_UNSUPPORTED", "Parent was not opened with directory flush access");
    if (!Stable()) throw Failure("FS_STAGE_CHANGED", "Pinned directory changed before flush");
    if (!FlushFileBuffers(Parent()))
      throw Failure("FS_DIRECTORY_SYNC_FAILED", "Pinned directory flush failed", GetLastError());
    if (!Stable()) throw Failure("FS_STAGE_CHANGED", "Pinned directory changed during flush");
  }
};
struct Parent {
  std::shared_ptr<DirectoryChain> chain;
};
struct Stage {
  std::shared_ptr<DirectoryChain> chain;
  std::unique_ptr<Handle> file;
  Snapshot initial{};
  std::wstring name;
  bool published = false;
  bool dirty = true;
  std::unique_ptr<SecuritySnapshot> security;
  ~Stage() {
    // Never reopen/unlink a path during cleanup. If deletion fails, leave the
    // orphan for explicit recovery; a finalizer must not delete a contender.
    if (file && !published) {
      FILE_DISPOSITION_INFO disposition{TRUE};
      SetFileInformationByHandle(file->value, FileDispositionInfo, &disposition, sizeof(disposition));
    }
  }
  void RequireOpen() const {
    if (!file) throw Failure("FS_HANDLE_CLOSED", "Write stage closed");
  }
  void RequireStaged() const {
    RequireOpen();
    if (published) throw Failure("FS_STAGE_PUBLISHED", "Published stage cannot be written or republished");
  }
  bool Stable() const {
    RequireOpen();
    const auto now = Inspect(file->value, false);
    return (!security || security->Matches(file->value)) && chain->Stable() && initial.id.VolumeSerialNumber == now.id.VolumeSerialNumber &&
      memcmp(initial.id.FileId.Identifier, now.id.FileId.Identifier, 16) == 0 &&
      now.standard.NumberOfLinks == 1;
  }
  void Close() {
    if (!file) return;
    DWORD error = 0;
    if (!published) {
      FILE_DISPOSITION_INFO disposition{TRUE};
      if (!SetFileInformationByHandle(file->value, FileDispositionInfo, &disposition, sizeof(disposition)))
        error = GetLastError();
    }
    file.reset();
    chain.reset();
    if (error) throw Failure("WIN32_IO_ERROR", "Cannot discard owned write stage; orphan retained", error);
  }
};
const napi_type_tag parentTag = {0x09d0814ea252420bULL, 0x8130d5107780c5e2ULL};
const napi_type_tag sourceDirectoryTag = {0xc52f131c74a24307ULL, 0xa5b9ca68a3ec52d1ULL};
const napi_type_tag stageTag = {0x3d82a7e69a704441ULL, 0x913d1476ead7ea4cULL};
template <typename T> T* Receiver(napi_env env, napi_callback_info info, const napi_type_tag* tag,
    size_t* count = nullptr, napi_value* args = nullptr) {
  size_t zero = 0;
  napi_value receiver;
  Check(napi_get_cb_info(env, info, count ? count : &zero, args, &receiver, nullptr));
  bool tagged = false;
  Check(napi_check_object_type_tag(env, receiver, tag, &tagged));
  if (!tagged) throw Failure("FS_HANDLE_REJECTED", "Invalid write handle receiver");
  T* value;
  Check(napi_unwrap(env, receiver, reinterpret_cast<void**>(&value)));
  return value;
}
// A distinct native type prevents borrowing any private write/directory
// mutator onto a public source lease. Mode 4 is assigned only to read methods.
Parent* ReadDirectoryReceiver(napi_env env, napi_callback_info info, size_t* count = nullptr, napi_value* args = nullptr) {
  void* mode = nullptr; Check(napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &mode));
  return Receiver<Parent>(env, info, mode == reinterpret_cast<void*>(4) ? &sourceDirectoryTag : &parentTag, count, args);
}
std::wstring Name(napi_env env, napi_value value) {
  try {
    const auto name = String(env, value);
    // Exactly one component, never a path, stream or ambiguous dot/space ending.
    const auto parts = Components(name, L'/');
    if (parts.size() != 1) throw Failure("FS_NAME_REJECTED", "Expected a single filename");
    return parts[0];
  } catch (const Failure& error) {
    if (strcmp(error.code, "FS_PATH_REJECTED") == 0)
      throw Failure("FS_NAME_REJECTED", "Expected a single safe filename");
    throw;
  }
}
napi_value ParentClose(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    ReadDirectoryReceiver(env, info)->chain.reset();
    return Undefined(env);
  });
}
napi_value ParentSync(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto parent = Receiver<Parent>(env, info, &parentTag);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Write parent closed");
    parent->chain->Sync();
    return Undefined(env);
  });
}
napi_value StageClose(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    Receiver<Stage>(env, info, &stageTag)->Close();
    return Undefined(env);
  });
}
napi_value StageWrite(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1;
    napi_value arg;
    auto stage = Receiver<Stage>(env, info, &stageTag, &count, &arg);
    stage->RequireStaged();
    bool typed = false;
    if (count == 1) Check(napi_is_typedarray(env, arg, &typed));
    if (!typed) throw Failure("FS_WRITE_LIMIT", "Expected a Uint8Array of at most 1048576 bytes");
    void* bytes;
    size_t size, offsetInBuffer;
    napi_typedarray_type type;
    napi_value backing;
    Check(napi_get_typedarray_info(env, arg, &type, &size, &bytes, &backing, &offsetInBuffer));
    bool arrayBuffer = false;
    Check(napi_is_arraybuffer(env, backing, &arrayBuffer));
    if (type != napi_uint8_array || !arrayBuffer || size > 1024 * 1024)
      throw Failure("FS_WRITE_LIMIT", "Expected a non-shared Uint8Array of at most 1048576 bytes");
    if (!stage->Stable()) throw Failure("FS_STAGE_CHANGED", "Write stage identity or link count changed");
    stage->dirty = true;
    DWORD offset = 0;
    while (offset < size) {
      DWORD written = 0;
      if (!WriteFile(stage->file->value, static_cast<char*>(bytes) + offset,
          static_cast<DWORD>(size) - offset, &written, nullptr))
        throw Failure("WIN32_IO_ERROR", "Owned stage write failed", GetLastError());
      if (written == 0) throw Failure("WIN32_IO_ERROR", "Owned stage write made no progress");
      offset += written;
    }
    napi_value result;
    Check(napi_create_uint32(env, offset, &result));
    return result;
  });
}
napi_value StageSync(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto stage = Receiver<Stage>(env, info, &stageTag);
    stage->RequireStaged();
    if (!stage->Stable()) throw Failure("FS_STAGE_CHANGED", "Write stage identity or link count changed");
    if (!FlushFileBuffers(stage->file->value))
      throw Failure("WIN32_IO_ERROR", "Owned stage flush failed", GetLastError());
    stage->dirty = false;
    return Undefined(env);
  });
}
napi_value StageVerify(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto stage = Receiver<Stage>(env, info, &stageTag);
    napi_value result;
    Check(napi_get_boolean(env, stage->Stable(), &result));
    return result;
  });
}
napi_value StageIdentity(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto stage = Receiver<Stage>(env, info, &stageTag);
    if (!stage->Stable()) throw Failure("FS_STAGE_CHANGED", "Write stage changed");
    const auto identity = DirectoryIdentityText(stage->initial); napi_value value;
    Check(napi_create_string_utf8(env, identity.c_str(), identity.size(), &value)); return value;
  });
}
using NtSet = NTSTATUS (NTAPI*)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
struct RenameInformation {
  BOOLEAN replace;
  HANDLE root;
  ULONG length;
  WCHAR name[1];
};
napi_value StagePublishNew(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1;
    napi_value arg;
    auto stage = Receiver<Stage>(env, info, &stageTag, &count, &arg);
    stage->RequireStaged();
    if (count != 1) throw Failure("FS_NAME_REJECTED", "Expected a target filename");
    const auto name = Name(env, arg);
    if (CompareStringOrdinal(name.c_str(), static_cast<int>(name.size()), stage->name.c_str(),
        static_cast<int>(stage->name.size()), TRUE) == CSTR_EQUAL)
      throw Failure("FS_NAME_REJECTED", "Target must differ from staging name");
    if (stage->dirty) throw Failure("FS_STAGE_NOT_SYNCED", "Flush staged bytes before publication");
    if (!stage->Stable()) throw Failure("FS_STAGE_CHANGED", "Write stage identity or link count changed");
    auto ntdll = GetModuleHandleW(L"ntdll.dll");
    auto set = reinterpret_cast<NtSet>(GetProcAddress(ntdll, "NtSetInformationFile"));
    auto error = reinterpret_cast<NtError>(GetProcAddress(ntdll, "RtlNtStatusToDosError"));
    if (!set || !error) throw Failure("NATIVE_API_UNAVAILABLE", "Required NT rename API unavailable");
    const auto bytes = (std::max)(sizeof(RenameInformation), offsetof(RenameInformation, name) + name.size() * sizeof(wchar_t));
    std::vector<ULONG_PTR> storage((bytes + sizeof(ULONG_PTR) - 1) / sizeof(ULONG_PTR), 0);
    auto rename = reinterpret_cast<RenameInformation*>(storage.data());
    rename->replace = FALSE;
    rename->root = stage->chain->Parent();
    rename->length = static_cast<ULONG>(name.size() * sizeof(wchar_t));
    memcpy(rename->name, name.data(), rename->length);
    IO_STATUS_BLOCK io{};
    const auto status = set(stage->file->value, &io, rename, static_cast<ULONG>(bytes),
      static_cast<FILE_INFORMATION_CLASS>(10) /* FileRenameInformation */);
    if (status < 0) {
      const auto windows = error(status);
      throw Failure(windows == ERROR_ALREADY_EXISTS || windows == ERROR_FILE_EXISTS ?
        "FS_TARGET_EXISTS" : "WIN32_IO_ERROR", "No-replace publication refused", windows);
    }
    // From this point cleanup must never mark this handle for deletion, even
    // when the post-publication check fails. The caller needs recovery facts.
    stage->published = true;
    try {
      if (!stage->Stable()) throw Failure("FS_STAGE_CHANGED", "Stage changed during publication; published file retained");
      napi_value result, value;
      Check(napi_create_object(env, &result));
      Check(napi_get_boolean(env, true, &value));
      Check(napi_set_named_property(env, result, "published", value));
      Check(napi_create_string_utf8(env, "namespace-not-qualified", NAPI_AUTO_LENGTH, &value));
      Check(napi_set_named_property(env, result, "durability", value));
      return result;
    } catch (Failure& error) {
      error.committed = true;
      throw;
    } catch (const std::exception&) {
      Failure error("NATIVE_BINDING_ERROR", "Post-publication failure; published file retained");
      error.committed = true;
      throw error;
    }
  });
}
napi_value CreateExclusive(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1;
    napi_value arg;
    auto parent = Receiver<Parent>(env, info, &parentTag, &count, &arg);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Write parent closed");
    if (count != 1) throw Failure("FS_NAME_REJECTED", "Expected a staging filename");
    const auto name = Name(env, arg);
    void* creationMode = nullptr;
    Check(napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &creationMode));
    std::unique_ptr<PrivateSecurity> descriptor;
    if (creationMode == reinterpret_cast<void*>(1)) descriptor = std::make_unique<PrivateSecurity>(false);
    if (!parent->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Write parent changed");
    auto stage = std::make_unique<Stage>();
    stage->chain = parent->chain;
    stage->name = name;
    stage->file = OpenChild(parent->chain->Parent(), name, false,
      GENERIC_READ | GENERIC_WRITE | DELETE | SYNCHRONIZE, 2 /* FILE_CREATE */,
      descriptor ? &descriptor->descriptor : nullptr);
    if (creationMode) {
      stage->security = std::make_unique<SecuritySnapshot>(SecuritySnapshot::Read(stage->file->value));
      if (descriptor) stage->security->RequirePrivate(false);
    }
    stage->initial = Inspect(stage->file->value, false);
    if (stage->initial.standard.NumberOfLinks != 1)
      throw Failure("FS_STAGE_CHANGED", "New stage has additional links");
    napi_value object;
    Check(napi_create_object(env, &object));
    Check(napi_type_tag_object(env, object, &stageTag));
    napi_property_descriptor methods[] = {
      {"write", nullptr, StageWrite, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"sync", nullptr, StageSync, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"publishNew", nullptr, StagePublishNew, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"verify", nullptr, StageVerify, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"identity", nullptr, StageIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, StageClose, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Check(napi_define_properties(env, object, sizeof(methods) / sizeof(methods[0]), methods));
    Check(napi_wrap(env, object, stage.get(), [](napi_env, void* data, void*) { delete static_cast<Stage*>(data); }, nullptr, nullptr));
    stage.release();
    return object;
  });
}
napi_value CreatePrivateDirectory(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1; napi_value arg;
    auto parent = Receiver<Parent>(env, info, &parentTag, &count, &arg);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Write parent closed");
    if (count != 1) throw Failure("FS_NAME_REJECTED", "Expected private directory name");
    const auto name = Name(env, arg);
    if (!parent->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Pinned parent changed");
    PrivateSecurity security(true);
    auto directory = OpenChild(parent->chain->Parent(), name, true,
      FILE_READ_ATTRIBUTES | READ_CONTROL | DELETE | SYNCHRONIZE, 2 /* FILE_CREATE */, &security.descriptor);
    try {
      Inspect(directory->value, true);
      SecuritySnapshot::Read(directory->value).RequirePrivate(true);
    } catch (...) {
      FILE_DISPOSITION_INFO disposition{TRUE};
      SetFileInformationByHandle(directory->value, FileDispositionInfo, &disposition, sizeof(disposition));
      throw;
    }
    return Undefined(env);
  });
}
// Kept in this translation unit so transactions retain the exact same pinned
// directory chain as staging; no path-only alternative is exported.
#include "anchored-transaction.inc"
#include "anchored-database.inc"
#include "anchored-directory.inc"
#include "anchored-custody.inc"
#include "anchored-source-tree.inc"
#include "clipboard.inc"

napi_value OpenParent(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2;
    napi_value args[2];
    void* mode = nullptr;
    Check(napi_get_cb_info(env, info, &count, args, nullptr, &mode));
    const bool publicMutation = mode == reinterpret_cast<void*>(4);
    const bool flushAccess = mode == reinterpret_cast<void*>(1) || publicMutation, identityPin = mode == reinterpret_cast<void*>(2), sourceRead = mode == reinterpret_cast<void*>(3);
    const bool observePolicy = sourceRead || publicMutation;
    if (count != 2) throw Failure("FS_PATH_REJECTED", "Expected root and relative target");
    const auto root = String(env, args[0]), relative = String(env, args[1]);
    if (root.size() < 3 || !((root[0] >= L'A' && root[0] <= L'Z') || (root[0] >= L'a' && root[0] <= L'z')) ||
        root[1] != L':' || root[2] != L'\\' || relative.empty())
      throw Failure("FS_PATH_REJECTED", "Only absolute local drive roots and relative targets are supported");
    const auto rootParts = Components(root.substr(3), L'\\');
    const auto parts = Components(relative, L'/');
    std::vector<std::wstring> directories(rootParts);
    directories.insert(directories.end(), parts.begin(), parts.end() - 1);
    if ((flushAccess || identityPin || sourceRead) && directories.empty())
      throw Failure("FS_VOLUME_UNSUPPORTED", "Volume-root directory flush is outside this experiment");
    const auto drive = root.substr(0, 3);
    if (GetDriveTypeW(drive.c_str()) != DRIVE_FIXED)
      throw Failure("FS_VOLUME_UNSUPPORTED", "Only fixed local NTFS volumes are supported");
    auto parent = std::make_unique<Parent>();
    parent->chain = std::make_shared<DirectoryChain>();
    auto volume = std::make_unique<Handle>(INVALID_HANDLE_VALUE);
    volume->value = CreateFileW((L"\\\\?\\" + drive).c_str(), FILE_READ_ATTRIBUTES | SYNCHRONIZE | (observePolicy ? READ_CONTROL : 0),
      FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (volume->value == INVALID_HANDLE_VALUE)
      throw Failure("WIN32_IO_ERROR", "Cannot pin drive root", GetLastError());
    wchar_t filesystem[32];
    if (!GetVolumeInformationByHandleW(volume->value, nullptr, 0, nullptr, nullptr, nullptr, filesystem, 32))
      throw Failure("WIN32_IO_ERROR", "Cannot identify volume", GetLastError());
    if (wcscmp(filesystem, L"NTFS") != 0)
      throw Failure("FS_VOLUME_UNSUPPORTED", "Only NTFS is qualified for this experiment");
    parent->chain->Add(std::move(volume));
    if (observePolicy) parent->chain->observedSecurity.push_back(SecuritySnapshot::Read(parent->chain->Parent()));
    for (size_t i = 0; i < directories.size(); i++) {
      const bool finalFlush = flushAccess && i + 1 == directories.size();
      const bool finalIdentity = identityPin && i + 1 == directories.size();
      // Persistence opens existing ancestors only. No directory creation may
      // escape its own missing-parent error or acquire an unflushed namespace.
      const auto disposition = flushAccess || identityPin || sourceRead || i < rootParts.size() ? 1u : 3u;
      parent->chain->Add(OpenChild(parent->chain->Parent(), directories[i], true,
        finalFlush ? GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE : (finalIdentity || sourceRead && i + 1 == directories.size() ? GENERIC_READ | READ_CONTROL | SYNCHRONIZE : (observePolicy ? FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE : 0)), disposition, nullptr,
        finalFlush || finalIdentity || observePolicy && i + 1 < directories.size() ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ));
      if (observePolicy) parent->chain->observedSecurity.push_back(SecuritySnapshot::Read(parent->chain->Parent()));
    }
    parent->chain->directorySync = flushAccess;
    // A project root need not have the private metadata ACL. Retain its actual
    // policy and data-read HANDLE so namespace changes are denied while nested
    // SQLite/persistence opens remain compatible; never create missing parents.
    if (identityPin) parent->chain->privateSecurity = std::make_unique<SecuritySnapshot>(SecuritySnapshot::Read(parent->chain->Parent()));
    if (sourceRead) return MakeSourceDirectory(env, std::move(parent));
    return MakeParent(env, std::move(parent), false);
  });
}
} // namespace
void InitWriteBindings(napi_env env, napi_value exports) {
  napi_value open;
  Check(napi_create_function(env, "readNativeFileClipboard", NAPI_AUTO_LENGTH, ReadNativeFileClipboard, nullptr, &open));
  Check(napi_set_named_property(env, exports, "readNativeFileClipboard", open));
  Check(napi_create_function(env, "writeNativeFileClipboard", NAPI_AUTO_LENGTH, WriteNativeFileClipboard, nullptr, &open));
  Check(napi_set_named_property(env, exports, "writeNativeFileClipboard", open));
  Check(napi_create_function(env, "openAnchoredPublicMutationParent", NAPI_AUTO_LENGTH, OpenParent,
    reinterpret_cast<void*>(4), &open));
  Check(napi_set_named_property(env, exports, "openAnchoredPublicMutationParent", open));
  Check(napi_create_function(env, "openAnchoredSourceDirectory", NAPI_AUTO_LENGTH, OpenParent,
    reinterpret_cast<void*>(3), &open));
  Check(napi_set_named_property(env, exports, "openAnchoredSourceDirectory", open));
  Check(napi_create_function(env, "createSupervisorCustody", NAPI_AUTO_LENGTH, CreateSupervisorCustody, nullptr, &open));
  Check(napi_set_named_property(env, exports, "createSupervisorCustody", open));
  Check(napi_create_function(env, "openAnchoredWriteParent", NAPI_AUTO_LENGTH, OpenParent, nullptr, &open));
  Check(napi_set_named_property(env, exports, "openAnchoredWriteParent", open));
  Check(napi_create_function(env, "openAnchoredPersistenceParent", NAPI_AUTO_LENGTH, OpenParent,
    reinterpret_cast<void*>(1), &open));
  Check(napi_set_named_property(env, exports, "openAnchoredPersistenceParent", open));
  Check(napi_create_function(env, "openAnchoredDirectoryIdentity", NAPI_AUTO_LENGTH, OpenParent,
    reinterpret_cast<void*>(2), &open));
  Check(napi_set_named_property(env, exports, "openAnchoredDirectoryIdentity", open));
}
