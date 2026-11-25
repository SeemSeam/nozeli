// Shared by private tree provisioning and the existing persistence parent.
napi_value MakeParent(napi_env env, std::unique_ptr<Parent> parent, bool created);
napi_value InspectDirectoryEntry(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1; napi_value arg; auto parent = Receiver<Parent>(env, info, &parentTag, &count, &arg);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Directory parent closed");
    if (count != 1) throw Failure("FS_NAME_REJECTED", "Expected entry name");
    const auto name = Name(env, arg);
    if (!parent->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Directory parent changed");
    std::unique_ptr<Handle> file;
    try { file = OpenChild(parent->chain->Parent(), name, false, FILE_READ_ATTRIBUTES | SYNCHRONIZE, 1, nullptr, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE); }
    catch (const Failure& error) {
      if (error.windows == ERROR_FILE_NOT_FOUND || error.windows == ERROR_PATH_NOT_FOUND) { napi_value result; Check(napi_get_null(env, &result)); return result; }
      if (error.windows != ERROR_ACCESS_DENIED && error.windows != ERROR_DIRECTORY) throw;
      file = OpenChild(parent->chain->Parent(), name, true, FILE_READ_ATTRIBUTES | SYNCHRONIZE, 1, nullptr, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    }
    FILE_ATTRIBUTE_TAG_INFO attributes{}; FILE_ID_INFO id{};
    if (!GetFileInformationByHandleEx(file->value, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
        !GetFileInformationByHandleEx(file->value, FileIdInfo, &id, sizeof(id)))
      throw Failure("WIN32_IO_ERROR", "Cannot inspect target entry", GetLastError());
    if (!parent->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Directory parent changed during entry observation");
    napi_value result, value; Check(napi_create_object(env, &result));
    Check(napi_get_boolean(env, (attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0, &value)); Check(napi_set_named_property(env, result, "directory", value));
    Check(napi_get_boolean(env, (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0, &value)); Check(napi_set_named_property(env, result, "reparse", value));
    const auto identity = DirectoryIdentityText(Snapshot{id});
    Check(napi_create_string_utf8(env, identity.c_str(), identity.size(), &value)); Check(napi_set_named_property(env, result, "identity", value));
    return result;
  });
}
std::string DirectoryIdentityText(const Snapshot& snapshot) {
  const auto& id = snapshot.id;
  char text[64];
  int length = sprintf_s(text, "%016llx:", static_cast<unsigned long long>(id.VolumeSerialNumber));
  for (BYTE byte : id.FileId.Identifier) length += sprintf_s(text + length, sizeof(text) - length, "%02x", byte);
  return text;
}
napi_value ParentVerify(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto parent = ReadDirectoryReceiver(env, info);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Directory lease closed");
    if (!parent->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Pinned directory identity or policy changed");
    return Undefined(env);
  });
}
napi_value ParentIdentity(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto parent = ReadDirectoryReceiver(env, info);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Directory lease closed");
    const auto text = DirectoryIdentityText(parent->chain->initial.back());
    napi_value result; Check(napi_create_string_utf8(env, text.c_str(), text.size(), &result)); return result;
  });
}
napi_value OpenPrivateDirectory(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2; napi_value args[2];
    auto source = Receiver<Parent>(env, info, &parentTag, &count, args);
    void* mode = nullptr; Check(napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &mode));
    const bool exclusive = mode == reinterpret_cast<void*>(1), deletable = mode == reinterpret_cast<void*>(2);
    if (!source->chain) throw Failure("FS_HANDLE_CLOSED", "Directory parent closed");
    if (count != (mode ? 1 : 2)) throw Failure("FS_NAME_REJECTED", "Expected directory name and optional create boolean");
    const auto name = Name(env, args[0]); bool create = exclusive;
    if (!mode) Check(napi_get_value_bool(env, args[1], &create));
    if (source->chain->privateDepth >= 128)
      throw Failure("FS_PATH_REJECTED", "Private directory chain exceeds 128 components");
    if (!source->chain->directorySync || !source->chain->Stable())
      throw Failure("FS_STAGE_CHANGED", "Existing stable persistence parent required");
    PrivateSecurity security(true); ULONG_PTR information = 0;
    auto directory = OpenChild(source->chain->Parent(), name, true,
      GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE | (deletable ? DELETE : 0), exclusive ? 2 : (create ? 3 : 1),
      &security.descriptor, FILE_SHARE_READ | FILE_SHARE_WRITE, &information);
    try {
      auto child = std::make_unique<Parent>(); child->chain = std::make_shared<DirectoryChain>();
      child->chain->ancestor = source->chain; child->chain->directorySync = true;
      child->chain->privateDelete = deletable;
      child->chain->privateDepth = source->chain->privateDepth + 1;
      child->chain->Add(std::move(directory));
      child->chain->privateSecurity = std::make_unique<SecuritySnapshot>(SecuritySnapshot::Read(child->chain->Parent()));
      child->chain->privateSecurity->RequirePrivate(true);
      if (!child->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Private directory changed during open");
      return MakeParent(env, std::move(child), information == 2 /* FILE_CREATED */);
    } catch (Failure& error) {
      // Retain newly created entries for explicit reconciliation; never remove
      // a name after an allocation/security failure or guess that nothing ran.
      if (information == 2) error.committed = true;
      throw;
    } catch (const std::exception&) {
      Failure error("NATIVE_BINDING_ERROR", "Private directory open failed; reconcile any created entry");
      error.committed = information == 2; throw error;
    }
  });
}
#include "anchored-directory-move.inc"
#include "anchored-public-tree.inc"
#include "anchored-private-tree.inc"
#include "anchored-public-file.inc"
#include "anchored-journal.inc"
napi_value CreatePublicDirectoryExclusive(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1; napi_value arg;
    auto parent = Receiver<Parent>(env, info, &parentTag, &count, &arg);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Public directory parent closed");
    if (count != 1) throw Failure("FS_NAME_REJECTED", "Expected directory name");
    const auto name = Name(env, arg);
    if (!parent->chain->directorySync || !parent->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Stable flush-capable parent required");
    // FILE_CREATE is exclusive. Null security preserves ordinary inheritance;
    // never impose the metadata-only user-private policy on project content.
    auto directory = OpenChild(parent->chain->Parent(), name, true,
      GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE, 2, nullptr, FILE_SHARE_READ | FILE_SHARE_WRITE);
    try {
      auto child = std::make_unique<Parent>(); child->chain = std::make_shared<DirectoryChain>();
      child->chain->ancestor = parent->chain; child->chain->directorySync = true;
      child->chain->Add(std::move(directory));
      child->chain->observedSecurity.push_back(SecuritySnapshot::Read(child->chain->Parent()));
      if (!child->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Created public directory changed");
      return MakeParent(env, std::move(child), true);
    } catch (Failure& error) { error.committed = true; throw; }
    catch (const std::exception&) {
      Failure error("NATIVE_BINDING_ERROR", "Created public directory retained; reconcile before retry"); error.committed = true; throw error;
    }
  });
}
napi_value MakeParent(napi_env env, std::unique_ptr<Parent> parent, bool created) {
  const auto directory = PinnedDirectoryPath(parent->chain->Parent());
  napi_value object, value; Check(napi_create_object(env, &object));
  Check(napi_type_tag_object(env, object, &parentTag));
  Check(napi_get_boolean(env, created, &value)); Check(napi_set_named_property(env, object, "created", value));
  Check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(directory.data()), directory.size(), &value));
  Check(napi_set_named_property(env, object, "path", value));
  napi_property_descriptor methods[] = {
    {"createExclusive", nullptr, CreateExclusive, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createPublicExclusive", nullptr, CreateExclusive, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(2)},
    {"createPublicDirectoryExclusive", nullptr, CreatePublicDirectoryExclusive, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createPrivateExclusive", nullptr, CreateExclusive, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(1)},
    {"createPrivateDirectory", nullptr, CreatePrivateDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openPrivateDirectory", nullptr, OpenPrivateDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createPrivateDirectoryExclusive", nullptr, OpenPrivateDirectory, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(1)},
    {"openPrivateDeleteDirectory", nullptr, OpenPrivateDirectory, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(2)},
    {"removePrivateEmptyDirectory", nullptr, RemovePrivateEmptyDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"beginPrivateDirectoryMove", nullptr, BeginPrivateDirectoryMove, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"beginPublicFileTransfer", nullptr, BeginPublicFileTransfer, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openPublicTreeRoot", nullptr, OpenPublicTreeRoot, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createPublicTreeRootExclusive", nullptr, OpenPublicTreeRoot, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(1)},
    {"sourceDirectory", nullptr, PublicTreeSourceDirectory, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"beginPublicSelfMove", nullptr, BeginPrivateSelfMove, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(1)},
    {"openPrivateTreeRoot", nullptr, OpenPrivateTreeRoot, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"createPrivateTreeRootExclusive", nullptr, OpenPrivateTreeRoot, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(1)},
    {"openPrivateTreeFile", nullptr, OpenPrivateTreeFile, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openPrivateObjectRead", nullptr, OpenPrivateTreeFile, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(2)},
    {"openPrivateLockFile", nullptr, OpenPrivateTreeFile, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(3)},
    {"openPrivateDeleteFile", nullptr, OpenPrivateTreeFile, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(1)},
    {"openPrivateJournal", nullptr, OpenPrivateJournal, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"entries", nullptr, PrivateDirectoryEntries, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"inspectEntry", nullptr, InspectDirectoryEntry, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"privateSecurityBytes", nullptr, PrivateTreeDirectorySecurity, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"observedSecurityBytes", nullptr, PrivateTreeDirectorySecurity, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(5)},
    {"beginPrivateSelfMove", nullptr, BeginPrivateSelfMove, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"beginReplacement", nullptr, BeginReplacement, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openPrivateDatabase", nullptr, OpenPrivateDatabase, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"syncDirectory", nullptr, ParentSync, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"verify", nullptr, ParentVerify, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"identity", nullptr, ParentIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, ParentClose, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  Check(napi_define_properties(env, object, sizeof(methods) / sizeof(methods[0]), methods));
  Check(napi_wrap(env, object, parent.get(), [](napi_env, void* data, void*) { delete static_cast<Parent*>(data); }, nullptr, nullptr));
  parent.release(); return object;
}
