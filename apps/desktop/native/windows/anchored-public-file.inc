// Public regular-file transfers. The source lease denies writes/deletion and
// retains both parent chains. Close never removes either public pathname.
struct PublicFileTransfer {
  std::shared_ptr<DirectoryChain> sourceParent, destinationParent;
  std::unique_ptr<Handle> file;
  Snapshot initial{};
  SecuritySnapshot security;
  std::wstring destinationName;
  bool move = false, published = false;
  void Verify() const {
    if (!file) throw Failure("FS_HANDLE_CLOSED", "Public file transfer closed");
    auto now = Inspect(file->value, false);
    auto expected = initial;
    // A successful rename changes ChangeTime, but never the byte version.
    if (published) expected.basic.ChangeTime = now.basic.ChangeTime;
    if (!sourceParent->Stable() || !destinationParent->Stable() ||
        !Same(expected, now, false) || !security.Matches(file->value))
      throw Failure("FS_STAGE_CHANGED", "Public source identity, bytes or policy changed");
  }
  void Close() { file.reset(); sourceParent.reset(); destinationParent.reset(); }
};
const napi_type_tag publicFileTransferTag = {0x128ecce593d84f92ULL, 0x92c47130b91280bfULL};
napi_value PublicFileTransferClose(napi_env env, napi_callback_info info) {
  return Guard(env, [&] { Receiver<PublicFileTransfer>(env, info, &publicFileTransferTag)->Close(); return Undefined(env); });
}
napi_value PublicFileTransferVerify(napi_env env, napi_callback_info info) {
  return Guard(env, [&] { Receiver<PublicFileTransfer>(env, info, &publicFileTransferTag)->Verify(); return Undefined(env); });
}
napi_value PublicFileTransferStat(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto lease = Receiver<PublicFileTransfer>(env, info, &publicFileTransferTag); lease->Verify();
    napi_value result, value; Check(napi_create_object(env, &result));
    const auto identity = DirectoryIdentityText(lease->initial);
    Check(napi_create_string_utf8(env, identity.c_str(), identity.size(), &value)); Check(napi_set_named_property(env, result, "identity", value));
    Check(napi_create_bigint_int64(env, lease->initial.standard.EndOfFile.QuadPart, &value)); Check(napi_set_named_property(env, result, "size", value));
    return result;
  });
}
napi_value PublicFileTransferRead(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2; napi_value args[2];
    auto lease = Receiver<PublicFileTransfer>(env, info, &publicFileTransferTag, &count, args); lease->Verify();
    if (count != 2) throw Failure("FS_READ_LIMIT", "Expected offset and byte count");
    double numbers[2];
    for (size_t i = 0; i < 2; i++) {
      napi_valuetype type; Check(napi_typeof(env, args[i], &type));
      if (type != napi_number) throw Failure("FS_READ_LIMIT", "Expected numeric offset and count");
      Check(napi_get_value_double(env, args[i], &numbers[i]));
    }
    if (!(numbers[0] >= 0 && numbers[0] <= 9007199254740991.0) || numbers[0] != static_cast<LONGLONG>(numbers[0]) ||
        !(numbers[1] >= 1 && numbers[1] <= 1048576) || numbers[1] != static_cast<DWORD>(numbers[1]))
      throw Failure("FS_READ_LIMIT", "Expected safe offset and 1..1048576 bytes");
    LARGE_INTEGER offset; offset.QuadPart = static_cast<LONGLONG>(numbers[0]);
    if (!SetFilePointerEx(lease->file->value, offset, nullptr, FILE_BEGIN)) throw Failure("WIN32_IO_ERROR", "Public source seek failed", GetLastError());
    std::vector<char> bytes(static_cast<size_t>(numbers[1])); DWORD read = 0;
    if (!ReadFile(lease->file->value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr))
      throw Failure("WIN32_IO_ERROR", "Public source read failed", GetLastError());
    lease->Verify(); napi_value result; Check(napi_create_buffer_copy(env, read, bytes.data(), nullptr, &result)); return result;
  });
}
napi_value PublicFileTransferCommit(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto lease = Receiver<PublicFileTransfer>(env, info, &publicFileTransferTag); lease->Verify();
    if (!lease->move) throw Failure("FS_HANDLE_REJECTED", "Copy source lease cannot move a file");
    if (lease->published) throw Failure("FS_MOVE_PUBLISHED", "Public file already moved");
    if (!FlushFileBuffers(lease->file->value)) throw Failure("FS_FILE_SYNC_FAILED", "Public move source flush failed", GetLastError());
    lease->Verify();
    auto ntdll = GetModuleHandleW(L"ntdll.dll");
    auto set = reinterpret_cast<NtSet>(GetProcAddress(ntdll, "NtSetInformationFile"));
    auto error = reinterpret_cast<NtError>(GetProcAddress(ntdll, "RtlNtStatusToDosError"));
    if (!set || !error) throw Failure("NATIVE_API_UNAVAILABLE", "Required NT rename API unavailable");
    const auto bytes = (std::max)(sizeof(RenameInformation), offsetof(RenameInformation, name) + lease->destinationName.size() * sizeof(wchar_t));
    std::vector<ULONG_PTR> storage((bytes + sizeof(ULONG_PTR) - 1) / sizeof(ULONG_PTR), 0);
    auto rename = reinterpret_cast<RenameInformation*>(storage.data());
    rename->replace = FALSE; rename->root = lease->destinationParent->Parent();
    rename->length = static_cast<ULONG>(lease->destinationName.size() * sizeof(wchar_t));
    memcpy(rename->name, lease->destinationName.data(), rename->length);
    IO_STATUS_BLOCK io{};
    const auto status = set(lease->file->value, &io, rename, static_cast<ULONG>(bytes), static_cast<FILE_INFORMATION_CLASS>(10));
    if (status < 0) {
      const auto windows = error(status);
      throw Failure(windows == ERROR_ALREADY_EXISTS || windows == ERROR_FILE_EXISTS ? "FS_TARGET_EXISTS" : "WIN32_IO_ERROR", "No-replace public move refused", windows);
    }
    lease->published = true;
    try {
      lease->Verify();
      if (!FlushFileBuffers(lease->file->value)) throw Failure("FS_FILE_SYNC_FAILED", "Moved public file flush failed", GetLastError());
      lease->Verify(); return Undefined(env);
    } catch (Failure& failure) { failure.committed = true; throw; }
    catch (const std::exception&) { Failure failure("NATIVE_BINDING_ERROR", "Moved public file retained"); failure.committed = true; throw failure; }
  });
}
napi_value BeginPublicFileTransfer(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 4; napi_value args[4];
    auto source = Receiver<Parent>(env, info, &parentTag, &count, args);
    if (count != 4) throw Failure("FS_NAME_REJECTED", "Expected source, destination parent/name and move boolean");
    napi_valuetype type; bool tagged = false;
    Check(napi_typeof(env, args[1], &type));
    if (type != napi_object) throw Failure("FS_HANDLE_REJECTED", "Expected destination parent");
    Check(napi_check_object_type_tag(env, args[1], &parentTag, &tagged));
    if (!tagged) throw Failure("FS_HANDLE_REJECTED", "Expected destination parent");
    Parent* destination; Check(napi_unwrap(env, args[1], reinterpret_cast<void**>(&destination)));
    auto lease = std::make_unique<PublicFileTransfer>();
    Check(napi_typeof(env, args[3], &type));
    if (type != napi_boolean) throw Failure("FS_HANDLE_REJECTED", "Expected move boolean");
    Check(napi_get_value_bool(env, args[3], &lease->move));
    const auto name = Name(env, args[0]); lease->destinationName = Name(env, args[2]);
    if (!source->chain || !destination->chain) throw Failure("FS_HANDLE_CLOSED", "Public transfer parent closed");
    if (!source->chain->directorySync || !destination->chain->directorySync ||
        source->chain->observedSecurity.empty() || destination->chain->observedSecurity.empty())
      throw Failure("FS_HANDLE_REJECTED", "Public mutation parents required");
    lease->sourceParent = source->chain; lease->destinationParent = destination->chain;
    if (!source->chain->Stable() || !destination->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Public parent changed");
    const auto& from = source->chain->initial.back().id; const auto& to = destination->chain->initial.back().id;
    if (from.VolumeSerialNumber != to.VolumeSerialNumber) throw Failure("FS_VOLUME_UNSUPPORTED", "Cross-volume public transfers unsupported");
    if (memcmp(from.FileId.Identifier, to.FileId.Identifier, 16) == 0 &&
        CompareStringOrdinal(name.c_str(), static_cast<int>(name.size()), lease->destinationName.c_str(), static_cast<int>(lease->destinationName.size()), TRUE) == CSTR_EQUAL)
      throw Failure("FS_NAME_REJECTED", "Public transfer requires distinct names");
    lease->file = OpenChild(source->chain->Parent(), name, false,
      GENERIC_READ | READ_CONTROL | SYNCHRONIZE | (lease->move ? GENERIC_WRITE | DELETE : 0));
    lease->initial = Inspect(lease->file->value, false);
    if (lease->initial.standard.NumberOfLinks != 1) throw Failure("FS_ENTRY_REJECTED", "Public source must have one link");
    lease->security = SecuritySnapshot::Read(lease->file->value);
    // Do not silently drop alternate streams on copy. Oversized stream lists
    // refuse rather than falling back to a path-only query or partial copy.
    std::vector<ULONG_PTR> streams(8192);
    if (!GetFileInformationByHandleEx(lease->file->value, FileStreamInfo, streams.data(), static_cast<DWORD>(streams.size() * sizeof(ULONG_PTR))))
      throw Failure("FS_STREAMS_UNSUPPORTED", "Cannot verify public source streams", GetLastError());
    auto stream = reinterpret_cast<FILE_STREAM_INFO*>(streams.data());
    const std::wstring unnamed = L"::$DATA";
    if (stream->NextEntryOffset || stream->StreamNameLength != unnamed.size() * sizeof(wchar_t) ||
        memcmp(stream->StreamName, unnamed.data(), stream->StreamNameLength) != 0)
      throw Failure("FS_STREAMS_UNSUPPORTED", "Alternate streams retained; transfer unsupported");
    lease->Verify();
    napi_value result; Check(napi_create_object(env, &result)); Check(napi_type_tag_object(env, result, &publicFileTransferTag));
    napi_property_descriptor methods[] = {
      {"verify", nullptr, PublicFileTransferVerify, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stat", nullptr, PublicFileTransferStat, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readAt", nullptr, PublicFileTransferRead, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"commit", nullptr, PublicFileTransferCommit, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, PublicFileTransferClose, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Check(napi_define_properties(env, result, sizeof(methods) / sizeof(methods[0]), methods));
    Check(napi_wrap(env, result, lease.get(), [](napi_env, void* data, void*) { delete static_cast<PublicFileTransfer*>(data); }, nullptr, nullptr));
    lease.release(); return result;
  });
}
