// Internal lease for qualification of the shared SQLite worker. SQLite retains
// its own Windows VFS/locking. This lease fixes namespace identity, not file
// contents, and is deliberately absent from production selection.
struct DatabaseLease {
  std::shared_ptr<DirectoryChain> chain;
  std::unique_ptr<Handle> file;
  Snapshot initial{};
  SecuritySnapshot directorySecurity, fileSecurity;
  std::wstring name;
  void VerifyDirectoryAndSidecars() const {
    if (!chain->Stable() || !directorySecurity.Matches(chain->Parent()))
      throw Failure("FS_SECURITY_CHANGED", "Private database directory changed");
    for (const auto suffix : {L"-journal", L"-wal", L"-shm"}) {
      NTSTATUS status = 0;
      try {
        auto sidecar = OpenChild(chain->Parent(), name + suffix, false,
          FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE, 1, nullptr,
          FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, &status);
        // SQLite may unlink its journal between this read-only observer's
        // open and inspection. A delete-pending name cannot authorize a new
        // SQLite open; it is an absent sidecar, not a policy exception.
        const auto facts = Inspect(sidecar->value, false, true);
        if (facts.standard.DeletePending) continue;
        if (facts.standard.NumberOfLinks != 1)
          throw Failure("FS_ENTRY_REJECTED", "Database sidecar must be single-link");
        SecuritySnapshot::Read(sidecar->value).RequireInheritedUserFile();
      } catch (const Failure& error) {
        // Do not suppress ACCESS_DENIED: only the original NT delete-pending
        // status identifies SQLite's normal transient namespace state.
        if (status == static_cast<NTSTATUS>(0xC0000056L) /* STATUS_DELETE_PENDING */) continue;
        if (strcmp(error.code, "WIN32_IO_ERROR") || error.windows != ERROR_FILE_NOT_FOUND) throw;
      }
    }
  }
  void Verify() const {
    if (!file) throw Failure("FS_HANDLE_CLOSED", "Database lease closed");
    VerifyDirectoryAndSidecars();
    const auto facts = Inspect(file->value, false);
    if (initial.id.VolumeSerialNumber != facts.id.VolumeSerialNumber ||
        memcmp(initial.id.FileId.Identifier, facts.id.FileId.Identifier, 16) ||
        facts.standard.NumberOfLinks != 1)
      throw Failure("FS_ENTRY_REJECTED", "Database requires the same single-link file");
    if (!fileSecurity.Matches(file->value))
      throw Failure("FS_SECURITY_CHANGED", "Database access policy changed");
  }
};
const napi_type_tag databaseTag = {0xf6d72d9e203f4b61ULL, 0xa024c895e08a3e47ULL};
napi_value DatabaseClose(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto lease = Receiver<DatabaseLease>(env, info, &databaseTag);
    lease->file.reset(); lease->chain.reset(); return Undefined(env);
  });
}
napi_value DatabaseVerify(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    Receiver<DatabaseLease>(env, info, &databaseTag)->Verify(); return Undefined(env);
  });
}
napi_value DatabaseIdentity(napi_env env,napi_callback_info info) {
  return Guard(env,[&]{auto* lease=Receiver<DatabaseLease>(env,info,&databaseTag);lease->Verify();
    const auto text=DirectoryIdentityText(lease->initial);napi_value result;
    Check(napi_create_string_utf8(env,text.c_str(),text.size(),&result));return result;});
}
napi_value OpenPrivateDatabase(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2; napi_value args[2];
    auto parent = Receiver<Parent>(env, info, &parentTag, &count, args);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Database parent closed");
    if (count != 2) throw Failure("FS_NAME_REJECTED", "Expected database name and mustExist boolean");
    const auto name = Name(env, args[0]); bool mustExist;
    Check(napi_get_value_bool(env, args[1], &mustExist));
    auto lease = std::make_unique<DatabaseLease>();
    lease->chain = parent->chain; lease->name = name;
    if (!lease->chain->directorySync || !lease->chain->Stable())
      throw Failure("FS_DIRECTORY_SYNC_UNSUPPORTED", "Existing writable persistence parent required");
    lease->directorySecurity = SecuritySnapshot::Read(lease->chain->Parent());
    lease->directorySecurity.RequirePrivate(true);
    lease->VerifyDirectoryAndSidecars();
    PrivateSecurity security(false); ULONG_PTR information = 0;
    // Data-read access participates in Windows share checks. Attribute-only
    // handles do not enforce the intended delete denial. SQLite READ/WRITE
    // opens remain compatible; deny delete for the connection lifetime.
    lease->file = OpenChild(lease->chain->Parent(), name, false,
      GENERIC_READ | READ_CONTROL | SYNCHRONIZE, mustExist ? 1 : 3,
      &security.descriptor, FILE_SHARE_READ | FILE_SHARE_WRITE, &information);
    lease->initial = Inspect(lease->file->value, false);
    lease->fileSecurity = SecuritySnapshot::Read(lease->file->value);
    lease->fileSecurity.RequireInheritedUserFile(); lease->Verify();
    const auto target = PinnedDirectoryPath(lease->chain->Parent()) + name;
    napi_value object, value; Check(napi_create_object(env, &object));
    Check(napi_type_tag_object(env, object, &databaseTag));
    Check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(target.data()), target.size(), &value));
    Check(napi_set_named_property(env, object, "path", value));
    Check(napi_get_boolean(env, information == 2 /* FILE_CREATED */, &value));
    Check(napi_set_named_property(env, object, "created", value));
    napi_property_descriptor methods[] = {
      {"verify", nullptr, DatabaseVerify, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"identity", nullptr, DatabaseIdentity, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, DatabaseClose, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Check(napi_define_properties(env, object, 3, methods));
    Check(napi_wrap(env, object, lease.get(), [](napi_env, void* data, void*) { delete static_cast<DatabaseLease*>(data); }, nullptr, nullptr));
    lease.release(); return object;
  });
}
