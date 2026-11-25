// Relative private tree inspection. No path-based enumeration, implicit repair
// or cleanup. Writable file pins deny other data writers and namespace changes.
struct PrivateTreeFile {
  std::shared_ptr<DirectoryChain> parent;
  std::unique_ptr<Handle> file;
  Snapshot initial{};
  SecuritySnapshot parentSecurity, security;
  bool deletable = false;
  bool writable = true;
  bool publicSource = false;
  void Verify() const {
    if (!file) throw Failure("FS_HANDLE_CLOSED", "Private tree file closed");
    if (!parent->Stable() || !parentSecurity.Matches(parent->Parent()) ||
        !Same(initial, Inspect(file->value, false), false) || !security.Matches(file->value))
      throw Failure("FS_STAGE_CHANGED", "Private tree file identity, bytes or policy changed");
    if (publicSource) RequireDefaultStreams(file->value, false);
  }
};
const napi_type_tag privateTreeFileTag = {0xf36a924f0d2745bcULL, 0x98e3e28349a18d2fULL};
napi_value PrivateTreeFileRemove(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto file = Receiver<PrivateTreeFile>(env, info, &privateTreeFileTag); file->Verify();
    if (!file->deletable) throw Failure("FS_HANDLE_REJECTED", "A private deletion file lease is required");
    auto result = Undefined(env);
    FILE_DISPOSITION_INFO disposition{TRUE};
    if (!SetFileInformationByHandle(file->file->value, FileDispositionInfo, &disposition, sizeof(disposition)))
      throw Failure("WIN32_IO_ERROR", "Private file deletion refused", GetLastError());
    // No allocation or post-delete inspection after the namespace mutation.
    file->file.reset(); file->parent.reset(); return result;
  });
}
napi_value RemovePrivateEmptyDirectory(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto directory = Receiver<Parent>(env, info, &parentTag);
    if (!directory->chain) throw Failure("FS_HANDLE_CLOSED", "Private directory closed");
    if (!directory->chain->privateDelete) throw Failure("FS_HANDLE_REJECTED", "A private deletion directory lease is required");
    if (!directory->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Private directory changed before deletion");
    auto result = Undefined(env);
    FILE_DISPOSITION_INFO disposition{TRUE};
    if (!SetFileInformationByHandle(directory->chain->Parent(), FileDispositionInfo, &disposition, sizeof(disposition)))
      throw Failure("WIN32_IO_ERROR", "Private empty directory deletion refused", GetLastError());
    directory->chain.reset(); return result;
  });
}
napi_value PrivateTreeFileClose(napi_env env, napi_callback_info info) {
  return Guard(env, [&] { auto file = Receiver<PrivateTreeFile>(env, info, &privateTreeFileTag); file->file.reset(); file->parent.reset(); return Undefined(env); });
}
napi_value PrivateTreeFileVerify(napi_env env, napi_callback_info info) {
  return Guard(env, [&] { Receiver<PrivateTreeFile>(env, info, &privateTreeFileTag)->Verify(); return Undefined(env); });
}
napi_value PrivateTreeFileSync(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto file = Receiver<PrivateTreeFile>(env, info, &privateTreeFileTag); file->Verify();
    if (!file->writable) throw Failure("FS_HANDLE_REJECTED", "Read-only object lease cannot flush a file");
    if (!FlushFileBuffers(file->file->value)) throw Failure("FS_FILE_SYNC_FAILED", "Private tree file flush failed", GetLastError());
    file->Verify(); return Undefined(env);
  });
}
napi_value PrivateTreeFileStat(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto file = Receiver<PrivateTreeFile>(env, info, &privateTreeFileTag); file->Verify();
    napi_value object, value; Check(napi_create_object(env, &object));
    const auto identity = DirectoryIdentityText(file->initial);
    Check(napi_create_string_utf8(env, identity.c_str(), identity.size(), &value)); Check(napi_set_named_property(env, object, "identity", value));
    Check(napi_create_bigint_int64(env, file->initial.standard.EndOfFile.QuadPart, &value)); Check(napi_set_named_property(env, object, "size", value));
    Check(napi_create_uint32(env, file->initial.basic.FileAttributes, &value)); Check(napi_set_named_property(env, object, "attributes", value));
    Check(napi_create_buffer_copy(env, file->security.bytes.size(), file->security.bytes.data(), nullptr, &value)); Check(napi_set_named_property(env, object, "security", value));
    return object;
  });
}
napi_value PrivateTreeFileReadAt(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2; napi_value args[2];
    auto file = Receiver<PrivateTreeFile>(env, info, &privateTreeFileTag, &count, args); file->Verify();
    if (count != 2) throw Failure("FS_READ_LIMIT", "Expected offset and byte count");
    double numbers[2];
    for (size_t i = 0; i < 2; i++) {
      napi_valuetype type; Check(napi_typeof(env, args[i], &type));
      if (type != napi_number) throw Failure("FS_READ_LIMIT", "Expected numeric offset and byte count");
      Check(napi_get_value_double(env, args[i], &numbers[i]));
    }
    if (!(numbers[0] >= 0 && numbers[0] <= 9007199254740991.0) || numbers[0] != static_cast<LONGLONG>(numbers[0]) ||
        !(numbers[1] >= 1 && numbers[1] <= 1048576) || numbers[1] != static_cast<DWORD>(numbers[1]))
      throw Failure("FS_READ_LIMIT", "Expected safe integer offset and 1..1048576 bytes");
    LARGE_INTEGER offset; offset.QuadPart = static_cast<LONGLONG>(numbers[0]);
    if (!SetFilePointerEx(file->file->value, offset, nullptr, FILE_BEGIN)) throw Failure("WIN32_IO_ERROR", "Tree file seek failed", GetLastError());
    std::vector<char> bytes(static_cast<size_t>(numbers[1])); DWORD read = 0;
    if (!ReadFile(file->file->value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr))
      throw Failure("WIN32_IO_ERROR", "Tree file read failed", GetLastError());
    file->Verify(); napi_value result; Check(napi_create_buffer_copy(env, read, bytes.data(), nullptr, &result)); return result;
  });
}
napi_value OpenPrivateTreeFile(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1; napi_value arg; auto parent = ReadDirectoryReceiver(env, info, &count, &arg);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Private tree parent closed");
    if (count != 1) throw Failure("FS_NAME_REJECTED", "Expected private tree filename");
    const auto name = Name(env, arg); auto file = std::make_unique<PrivateTreeFile>(); file->parent = parent->chain;
    void* mode = nullptr; Check(napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &mode));
    const bool ownedLock = mode == reinterpret_cast<void*>(3);
    const bool publicSource = mode == reinterpret_cast<void*>(4);
    file->publicSource = publicSource;
    file->deletable = mode == reinterpret_cast<void*>(1) || ownedLock;
    file->writable = mode != reinterpret_cast<void*>(2) && !publicSource;
    if ((!publicSource && !file->parent->directorySync) || !file->parent->Stable()) throw Failure("FS_STAGE_CHANGED", "Tree parent changed");
    file->parentSecurity = SecuritySnapshot::Read(file->parent->Parent());
    // Git metadata parents are user-owned public directories. An owned lock
    // still requires its own exact protected user-only policy; retain the
    // parent's actual policy without repairing or privatizing the repository.
    if (!ownedLock && !publicSource) file->parentSecurity.RequirePrivate(true);
    file->file = OpenChild(file->parent->Parent(), name, false, GENERIC_READ | (file->writable ? GENERIC_WRITE : 0) | READ_CONTROL | SYNCHRONIZE | (file->deletable ? DELETE : 0));
    file->initial = Inspect(file->file->value, false);
    if (file->initial.standard.NumberOfLinks != 1) throw Failure("FS_ENTRY_REJECTED", "Private tree file must have one link");
    file->security = SecuritySnapshot::Read(file->file->value);
    if (ownedLock) file->security.RequirePrivate(false); else if (!publicSource) file->security.RequireInheritedUserFile();
    file->Verify();
    napi_value object; Check(napi_create_object(env, &object)); Check(napi_type_tag_object(env, object, &privateTreeFileTag));
    napi_property_descriptor methods[] = {
      {"verify", nullptr, PrivateTreeFileVerify, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stat", nullptr, PrivateTreeFileStat, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readAt", nullptr, PrivateTreeFileReadAt, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, PrivateTreeFileClose, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"sync", nullptr, PrivateTreeFileSync, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"remove", nullptr, PrivateTreeFileRemove, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Check(napi_define_properties(env, object, publicSource ? 4 : sizeof(methods) / sizeof(methods[0]), methods));
    Check(napi_wrap(env, object, file.get(), [](napi_env, void* data, void*) { delete static_cast<PrivateTreeFile*>(data); }, nullptr, nullptr));
    file.release(); return object;
  });
}
struct PrivateTreeEntry { std::wstring name; FILE_ID_INFO id{}; DWORD attributes; };
napi_value PrivateTreeDirectorySecurity(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto parent = ReadDirectoryReceiver(env, info);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Private tree directory closed");
    if (!parent->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Private tree directory changed");
    void* mode = nullptr; Check(napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &mode));
    const auto security = SecuritySnapshot::Read(parent->chain->Parent());
    if (mode == reinterpret_cast<void*>(4)) RequireDefaultStreams(parent->chain->Parent(), true);
    if (mode != reinterpret_cast<void*>(4) && mode != reinterpret_cast<void*>(5)) security.RequirePrivate(true);
    napi_value value; Check(napi_create_buffer_copy(env, security.bytes.size(), security.bytes.data(), nullptr, &value)); return value;
  });
}
napi_value PrivateDirectoryEntries(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1; napi_value arg; auto parent = ReadDirectoryReceiver(env, info, &count, &arg);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Private tree directory closed");
    double limit = 0; napi_valuetype type;
    if (count != 1) throw Failure("FS_TREE_LIMIT", "Expected directory entry limit");
    Check(napi_typeof(env, arg, &type));
    if (type != napi_number) throw Failure("FS_TREE_LIMIT", "Expected numeric directory entry limit");
    Check(napi_get_value_double(env, arg, &limit));
    if (!(limit >= 1 && limit <= 10000) || limit != static_cast<DWORD>(limit)) throw Failure("FS_TREE_LIMIT", "Directory entry limit must be 1..10000");
    void* mode = nullptr; Check(napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &mode));
    if ((mode != reinterpret_cast<void*>(4) && !parent->chain->directorySync) || !parent->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Tree directory changed");
    auto security = SecuritySnapshot::Read(parent->chain->Parent());
    if (mode == reinterpret_cast<void*>(4)) RequireDefaultStreams(parent->chain->Parent(), true);
    if (mode != reinterpret_cast<void*>(4)) security.RequirePrivate(true);
    std::vector<PrivateTreeEntry> entries; std::vector<ULONG_PTR> storage(8192);
    auto information = FileIdExtdDirectoryRestartInfo;
    while (true) {
      std::fill(storage.begin(), storage.end(), 0);
      if (!GetFileInformationByHandleEx(parent->chain->Parent(), information, storage.data(), static_cast<DWORD>(storage.size() * sizeof(ULONG_PTR)))) {
        const auto error = GetLastError(); if (error == ERROR_NO_MORE_FILES) break;
        throw Failure("WIN32_IO_ERROR", "Pinned directory enumeration failed", error);
      }
      information = FileIdExtdDirectoryInfo; size_t offset = 0;
      while (true) {
        const auto capacity = storage.size() * sizeof(ULONG_PTR), header = offsetof(FILE_ID_EXTD_DIR_INFO, FileName);
        if (offset > capacity - header) throw Failure("FS_ENTRY_REJECTED", "Invalid directory enumeration record");
        const auto item = reinterpret_cast<FILE_ID_EXTD_DIR_INFO*>(reinterpret_cast<BYTE*>(storage.data()) + offset);
        if (!item->FileNameLength || item->FileNameLength % sizeof(wchar_t) || item->FileNameLength > 510 ||
            item->FileNameLength > capacity - offset - header)
          throw Failure("FS_NAME_REJECTED", "Invalid enumerated filename");
        std::wstring name(item->FileName, item->FileNameLength / sizeof(wchar_t));
        if (name != L"." && name != L"..") {
          if (item->FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) throw Failure("FS_REPARSE_REJECTED", "Private tree contains a reparse entry");
          if (item->FileAttributes & FILE_ATTRIBUTE_DEVICE) throw Failure("FS_ENTRY_REJECTED", "Private tree contains a device entry");
          PrivateTreeEntry entry; entry.name = std::move(name); entry.attributes = item->FileAttributes;
          entry.id.VolumeSerialNumber = parent->chain->initial.back().id.VolumeSerialNumber; entry.id.FileId = item->FileId;
          entries.push_back(std::move(entry));
          if (entries.size() > limit) throw Failure("FS_TREE_LIMIT", "Private directory exceeds entry limit");
        }
        if (!item->NextEntryOffset) break;
        if (item->NextEntryOffset < header + item->FileNameLength || item->NextEntryOffset % 8 || item->NextEntryOffset > capacity - offset - header)
          throw Failure("FS_ENTRY_REJECTED", "Invalid directory enumeration offset");
        offset += item->NextEntryOffset;
      }
    }
    if (!parent->chain->Stable() || !security.Matches(parent->chain->Parent())) throw Failure("FS_STAGE_CHANGED", "Private tree directory changed during enumeration");
    std::sort(entries.begin(), entries.end(), [](const PrivateTreeEntry& a, const PrivateTreeEntry& b) { return a.name < b.name; });
    napi_value result; Check(napi_create_array_with_length(env, entries.size(), &result));
    for (size_t index = 0; index < entries.size(); index++) {
      const auto& entry = entries[index]; napi_value object, value; Check(napi_create_object(env, &object));
      Check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(entry.name.data()), entry.name.size(), &value)); Check(napi_set_named_property(env, object, "name", value));
      const auto identity = DirectoryIdentityText(Snapshot{entry.id});
      Check(napi_create_string_utf8(env, identity.c_str(), identity.size(), &value)); Check(napi_set_named_property(env, object, "identity", value));
      Check(napi_get_boolean(env, (entry.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0, &value)); Check(napi_set_named_property(env, object, "directory", value));
      Check(napi_create_uint32(env, entry.attributes, &value)); Check(napi_set_named_property(env, object, "attributes", value));
      Check(napi_set_element(env, result, static_cast<uint32_t>(index), object));
    }
    return result;
  });
}
napi_value OpenPrivateTreeRoot(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1; napi_value arg; auto parent = Receiver<Parent>(env, info, &parentTag, &count, &arg);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Tree root parent closed");
    if (count != 1) throw Failure("FS_NAME_REJECTED", "Expected private tree root name");
    const auto name = Name(env, arg);
    void* creation = nullptr; Check(napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &creation));
    if (!parent->chain->directorySync || !parent->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Tree root parent changed");
    if (parent->chain->privateDepth >= 128) throw Failure("FS_TREE_LIMIT", "Private tree depth limit exceeded");
    auto root = std::make_unique<Parent>(); root->chain = std::make_shared<DirectoryChain>();
    root->chain->ancestor = parent->chain; root->chain->privateDepth = parent->chain->privateDepth + 1;
    root->chain->ancestorSecurity = std::make_unique<SecuritySnapshot>(SecuritySnapshot::Read(parent->chain->Parent()));
    root->chain->directorySync = true; root->chain->privateTreeRoot = true;
    root->chain->privateDelete = true;
    root->chain->privateTreeName = name;
    PrivateSecurity descriptor(true); ULONG_PTR information = 0;
    auto handle = OpenChild(parent->chain->Parent(), name, true, GENERIC_READ | GENERIC_WRITE | DELETE | SYNCHRONIZE,
      creation ? 2 : 1, creation ? &descriptor.descriptor : nullptr, FILE_SHARE_READ | FILE_SHARE_WRITE, &information);
    try {
    root->chain->Add(std::move(handle));
    root->chain->privateSecurity = std::make_unique<SecuritySnapshot>(SecuritySnapshot::Read(root->chain->Parent())); root->chain->privateSecurity->RequirePrivate(true);
    if (!root->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Private tree root changed");
    return MakeParent(env, std::move(root), creation != nullptr);
    } catch (Failure& error) { if (information == 2) error.committed = true; throw; }
      catch (const std::exception&) { Failure error("NATIVE_BINDING_ERROR", "Private tree creation failed; reconcile retained entry"); error.committed = information == 2; throw error; }
  });
}
napi_value BeginPrivateSelfMove(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 3; napi_value args[3]; auto root = Receiver<Parent>(env, info, &parentTag, &count, args);
    if (!root->chain) throw Failure("FS_HANDLE_CLOSED", "Private tree root closed");
    void* mode = nullptr; Check(napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &mode));
    const bool publicTree = mode == reinterpret_cast<void*>(1);
    if (!(publicTree ? root->chain->publicTreeRoot : root->chain->privateTreeRoot) || !root->chain->ancestor)
      throw Failure("FS_HANDLE_REJECTED", "An explicit tree root move handle is required");
    if (root->chain->privateTreePublished) throw Failure("FS_MOVE_PUBLISHED", "Private tree already moved; reconcile instead of replaying");
    if (count != 3) throw Failure("FS_NAME_REJECTED", "Expected destination parent, name and identity");
    bool tagged = false;
    if (napi_check_object_type_tag(env, args[0], &parentTag, &tagged) != napi_ok || !tagged) throw Failure("FS_HANDLE_REJECTED", "Invalid destination parent");
    Parent* destination; Check(napi_unwrap(env, args[0], reinterpret_cast<void**>(&destination)));
    if (!destination->chain) throw Failure("FS_HANDLE_CLOSED", "Destination parent closed");
    if (publicTree && destination->chain->observedSecurity.empty()) throw Failure("FS_HANDLE_REJECTED", "Public mutation destination required");
    const auto name = Name(env, args[1]), expected = String(env, args[2]);
    const auto identity = DirectoryIdentityText(root->chain->initial.back());
    if (expected != std::wstring(identity.begin(), identity.end())) throw Failure("FS_DIRECTORY_CONFLICT", "Private tree root identity differs");
    if (!destination->chain->directorySync || root->chain->initial.back().id.VolumeSerialNumber != destination->chain->initial.back().id.VolumeSerialNumber)
      throw Failure("FS_VOLUME_UNSUPPORTED", "Same-volume persistence destination required");
    if (!root->chain->Stable() || !destination->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Private tree move parent changed");
    const auto& from = root->chain->ancestor->initial.back().id; const auto& to = destination->chain->initial.back().id;
    if (from.VolumeSerialNumber == to.VolumeSerialNumber && memcmp(from.FileId.Identifier, to.FileId.Identifier, 16) == 0 &&
        CompareStringOrdinal(root->chain->privateTreeName.c_str(), static_cast<int>(root->chain->privateTreeName.size()), name.c_str(), static_cast<int>(name.size()), TRUE) == CSTR_EQUAL)
      throw Failure("FS_NAME_REJECTED", "Private tree move requires distinct names");
    auto move = std::make_unique<DirectoryMove>(); move->sourceParent = root->chain->ancestor; move->destinationParent = destination->chain;
    move->originTree = root->chain;
    move->sourceParentSecurity = SecuritySnapshot::Read(move->sourceParent->Parent()); move->destinationParentSecurity = SecuritySnapshot::Read(move->destinationParent->Parent());
    move->destinationName = name; move->initial = root->chain->initial.back(); move->security = SecuritySnapshot::Read(root->chain->Parent());
    if (!publicTree) move->security.RequirePrivate(true);
    auto duplicate = std::make_unique<Handle>(INVALID_HANDLE_VALUE);
    if (!DuplicateHandle(GetCurrentProcess(), root->chain->Parent(), GetCurrentProcess(), &duplicate->value, 0, FALSE, DUPLICATE_SAME_ACCESS))
      throw Failure("WIN32_IO_ERROR", "Cannot retain private tree move handle", GetLastError());
    move->directory = std::move(duplicate); move->Verify(); return WrapDirectoryMove(env, std::move(move));
  });
}
