// Public tree roots preserve inherited ACLs. A read-only view shares the exact
// root HANDLE; it cannot borrow Parent mutators. Close never removes any name.
napi_value MakeSourceDirectory(napi_env env, std::unique_ptr<Parent> parent);
void RequireDefaultStreams(HANDLE handle, bool directory) {
  std::vector<ULONG_PTR> storage(8192, 0);
  if (!GetFileInformationByHandleEx(handle, FileStreamInfo, storage.data(), static_cast<DWORD>(storage.size() * sizeof(ULONG_PTR)))) {
    const auto error = GetLastError();
    if (directory && error == ERROR_HANDLE_EOF) return;
    throw Failure("FS_STREAMS_UNSUPPORTED", "Cannot verify pinned source streams", error);
  }
  const auto stream = reinterpret_cast<FILE_STREAM_INFO*>(storage.data());
  if (directory && !stream->StreamNameLength && !stream->NextEntryOffset) return;
  const std::wstring unnamed = L"::$DATA";
  if (stream->NextEntryOffset || stream->StreamNameLength != unnamed.size() * sizeof(wchar_t) ||
      memcmp(stream->StreamName, unnamed.data(), unnamed.size() * sizeof(wchar_t)) != 0)
    throw Failure("FS_STREAMS_UNSUPPORTED", "Alternate streams retained; tree transfer unsupported");
}
napi_value OpenPublicTreeRoot(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1; napi_value arg;
    auto parent = Receiver<Parent>(env, info, &parentTag, &count, &arg);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Public tree parent closed");
    if (count != 1) throw Failure("FS_NAME_REJECTED", "Expected public tree name");
    const auto name = Name(env, arg);
    void* creation = nullptr; Check(napi_get_cb_info(env, info, nullptr, nullptr, nullptr, &creation));
    if (!parent->chain->directorySync || parent->chain->observedSecurity.empty() || !parent->chain->Stable())
      throw Failure("FS_HANDLE_REJECTED", "Stable public mutation parent required");
    if (parent->chain->privateDepth >= 128) throw Failure("FS_TREE_LIMIT", "Public tree depth exceeds 128");
    ULONG_PTR information = 0;
    auto handle = OpenChild(parent->chain->Parent(), name, true, GENERIC_READ | GENERIC_WRITE | DELETE | SYNCHRONIZE,
      creation ? 2 : 1, nullptr, FILE_SHARE_READ | FILE_SHARE_WRITE, &information);
    try {
      auto root = std::make_unique<Parent>(); root->chain = std::make_shared<DirectoryChain>();
      root->chain->ancestor = parent->chain; root->chain->privateDepth = parent->chain->privateDepth + 1;
      root->chain->ancestorSecurity = std::make_unique<SecuritySnapshot>(SecuritySnapshot::Read(parent->chain->Parent()));
      root->chain->directorySync = true; root->chain->publicTreeRoot = true; root->chain->privateTreeName = name;
      root->chain->Add(std::move(handle)); RequireDefaultStreams(root->chain->Parent(), true);
      root->chain->observedSecurity.push_back(SecuritySnapshot::Read(root->chain->Parent()));
      if (!root->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Public tree root changed");
      return MakeParent(env, std::move(root), information == 2);
    } catch (Failure& error) { if (information == 2) error.committed = true; throw; }
      catch (const std::exception&) { Failure error("NATIVE_BINDING_ERROR", "Public tree allocation uncertain; retain entry"); error.committed = information == 2; throw error; }
  });
}
napi_value PublicTreeSourceDirectory(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto root = Receiver<Parent>(env, info, &parentTag);
    if (!root->chain || !root->chain->publicTreeRoot) throw Failure("FS_HANDLE_REJECTED", "Explicit public tree root required");
    if (!root->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Public tree root changed");
    RequireDefaultStreams(root->chain->Parent(), true);
    auto view = std::make_unique<Parent>(); view->chain = root->chain;
    return MakeSourceDirectory(env, std::move(view));
  });
}
