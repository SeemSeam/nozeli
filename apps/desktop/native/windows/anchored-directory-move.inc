// Included after private directory helpers. A move pins both existing parents
// and opens the source directory for DELETE without delete sharing. Closing the
// lease only releases HANDLEs; neither source nor destination is ever removed.
struct DirectoryMove {
  std::shared_ptr<DirectoryChain> sourceParent, destinationParent;
  std::shared_ptr<DirectoryChain> originTree;
  std::unique_ptr<Handle> directory;
  Snapshot initial{};
  SecuritySnapshot security, sourceParentSecurity, destinationParentSecurity;
  std::wstring destinationName;
  bool published = false;
  void Verify() const {
    if (!directory) throw Failure("FS_HANDLE_CLOSED", "Directory move lease closed");
    if (!sourceParent->Stable() || !destinationParent->Stable() ||
        !sourceParentSecurity.Matches(sourceParent->Parent()) || !destinationParentSecurity.Matches(destinationParent->Parent()) ||
        !Same(initial, Inspect(directory->value, true), true) || !security.Matches(directory->value))
      throw Failure("FS_STAGE_CHANGED", "Directory move identity or policy changed");
  }
  void Close() {
    directory.reset(); sourceParent.reset(); destinationParent.reset(); originTree.reset();
  }
};
const napi_type_tag directoryMoveTag = {0xc0dfdce5b38d42f1ULL, 0x8c985ab357fc1a60ULL};
napi_value DirectoryMoveVerify(napi_env env, napi_callback_info info) {
  return Guard(env, [&] { Receiver<DirectoryMove>(env, info, &directoryMoveTag)->Verify(); return Undefined(env); });
}
napi_value DirectoryMoveIdentity(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto move = Receiver<DirectoryMove>(env, info, &directoryMoveTag);
    if (!move->directory) throw Failure("FS_HANDLE_CLOSED", "Directory move lease closed");
    const auto identity = DirectoryIdentityText(move->initial);
    napi_value value; Check(napi_create_string_utf8(env, identity.c_str(), identity.size(), &value)); return value;
  });
}
napi_value DirectoryMoveClose(napi_env env, napi_callback_info info) {
  return Guard(env, [&] { Receiver<DirectoryMove>(env, info, &directoryMoveTag)->Close(); return Undefined(env); });
}
napi_value DirectoryMoveSync(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto move = Receiver<DirectoryMove>(env, info, &directoryMoveTag);
    move->Verify();
    if (!FlushFileBuffers(move->directory->value))
      throw Failure("FS_DIRECTORY_SYNC_FAILED", "Move directory flush failed", GetLastError());
    move->Verify(); return Undefined(env);
  });
}
napi_value DirectoryMoveCommit(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto move = Receiver<DirectoryMove>(env, info, &directoryMoveTag);
    move->Verify();
    if (move->published) throw Failure("FS_MOVE_PUBLISHED", "Directory move already published; reconcile before another operation");
    auto ntdll = GetModuleHandleW(L"ntdll.dll");
    auto set = reinterpret_cast<NtSet>(GetProcAddress(ntdll, "NtSetInformationFile"));
    auto error = reinterpret_cast<NtError>(GetProcAddress(ntdll, "RtlNtStatusToDosError"));
    if (!set || !error) throw Failure("NATIVE_API_UNAVAILABLE", "Required NT rename API unavailable");
    const auto bytes = (std::max)(sizeof(RenameInformation), offsetof(RenameInformation, name) + move->destinationName.size() * sizeof(wchar_t));
    std::vector<ULONG_PTR> storage((bytes + sizeof(ULONG_PTR) - 1) / sizeof(ULONG_PTR), 0);
    auto rename = reinterpret_cast<RenameInformation*>(storage.data());
    rename->replace = FALSE; rename->root = move->destinationParent->Parent();
    rename->length = static_cast<ULONG>(move->destinationName.size() * sizeof(wchar_t));
    memcpy(rename->name, move->destinationName.data(), rename->length);
    IO_STATUS_BLOCK io{};
    const auto status = set(move->directory->value, &io, rename, static_cast<ULONG>(bytes),
      static_cast<FILE_INFORMATION_CLASS>(10) /* FileRenameInformation */);
    if (status < 0) {
      const auto windows = error(status);
      throw Failure(windows == ERROR_ALREADY_EXISTS || windows == ERROR_FILE_EXISTS ?
        "FS_TARGET_EXISTS" : "WIN32_IO_ERROR", "No-replace directory move refused", windows);
    }
    move->published = true;
    if (move->originTree) move->originTree->privateTreePublished = true;
    try { move->Verify(); return Undefined(env); }
    catch (Failure& failure) { failure.committed = true; throw; }
    catch (const std::exception&) {
      Failure failure("NATIVE_BINDING_ERROR", "Post-move failure; destination retained"); failure.committed = true; throw failure;
    }
  });
}
napi_value WrapDirectoryMove(napi_env env, std::unique_ptr<DirectoryMove> move) {
  napi_value object; Check(napi_create_object(env, &object));
  Check(napi_type_tag_object(env, object, &directoryMoveTag));
  napi_property_descriptor methods[] = {
    {"verify", nullptr, DirectoryMoveVerify, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"identity", nullptr, DirectoryMoveIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"syncDirectory", nullptr, DirectoryMoveSync, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"commit", nullptr, DirectoryMoveCommit, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"close", nullptr, DirectoryMoveClose, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  Check(napi_define_properties(env, object, 5, methods));
  Check(napi_wrap(env, object, move.get(), [](napi_env, void* data, void*) { delete static_cast<DirectoryMove*>(data); }, nullptr, nullptr));
  move.release(); return object;
}
napi_value BeginPrivateDirectoryMove(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 4; napi_value args[4];
    auto source = Receiver<Parent>(env, info, &parentTag, &count, args);
    if (count != 4) throw Failure("FS_NAME_REJECTED", "Expected source name, destination parent, destination name and identity");
    bool tagged = false; napi_valuetype type;
    Check(napi_typeof(env, args[1], &type));
    if (type != napi_object) throw Failure("FS_HANDLE_REJECTED", "Invalid destination parent");
    Check(napi_check_object_type_tag(env, args[1], &parentTag, &tagged));
    if (!tagged) throw Failure("FS_HANDLE_REJECTED", "Invalid destination parent");
    Parent* destination; Check(napi_unwrap(env, args[1], reinterpret_cast<void**>(&destination)));
    if (!source->chain || !destination->chain) throw Failure("FS_HANDLE_CLOSED", "Directory move parent closed");
    const auto sourceName = Name(env, args[0]), destinationName = Name(env, args[2]), expected = String(env, args[3]);
    if (expected.size() != 49 || expected[16] != L':' ||
        std::any_of(expected.begin(), expected.end(), [](wchar_t c) { return c != L':' && !(c >= L'0' && c <= L'9') && !(c >= L'a' && c <= L'f'); }) ||
        std::count(expected.begin(), expected.end(), L':') != 1)
      throw Failure("FS_IDENTITY_REJECTED", "Expected canonical volume and directory file ID");
    if (!source->chain->directorySync || !destination->chain->directorySync)
      throw Failure("FS_DIRECTORY_SYNC_UNSUPPORTED", "Directory moves require persistence parents");
    if (!source->chain->Stable() || !destination->chain->Stable())
      throw Failure("FS_STAGE_CHANGED", "Directory move parent changed");
    const auto& from = source->chain->initial.back().id;
    const auto& to = destination->chain->initial.back().id;
    if (from.VolumeSerialNumber != to.VolumeSerialNumber)
      throw Failure("FS_VOLUME_UNSUPPORTED", "Cross-volume directory move refused");
    if (memcmp(from.FileId.Identifier, to.FileId.Identifier, 16) == 0 &&
        CompareStringOrdinal(sourceName.c_str(), static_cast<int>(sourceName.size()), destinationName.c_str(),
          static_cast<int>(destinationName.size()), TRUE) == CSTR_EQUAL)
      throw Failure("FS_NAME_REJECTED", "Directory move requires distinct names");
    auto move = std::make_unique<DirectoryMove>();
    move->sourceParent = source->chain; move->destinationParent = destination->chain; move->destinationName = destinationName;
    move->sourceParentSecurity = SecuritySnapshot::Read(source->chain->Parent());
    move->destinationParentSecurity = SecuritySnapshot::Read(destination->chain->Parent());
    move->directory = OpenChild(source->chain->Parent(), sourceName, true,
      GENERIC_READ | GENERIC_WRITE | DELETE | SYNCHRONIZE, 1, nullptr, FILE_SHARE_READ | FILE_SHARE_WRITE);
    move->initial = Inspect(move->directory->value, true);
    const auto identity = DirectoryIdentityText(move->initial);
    if (std::wstring(identity.begin(), identity.end()) != expected)
      throw Failure("FS_DIRECTORY_CONFLICT", "Source directory identity differs from the expected version");
    move->security = SecuritySnapshot::Read(move->directory->value); move->security.RequirePrivate(true);
    move->Verify();
    return WrapDirectoryMove(env, std::move(move));
  });
}
