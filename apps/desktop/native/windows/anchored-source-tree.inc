// Ordinary project payloads have public/inherited ACLs. Observe them with
// read-only HANDLEs and a separate native type; never grant persistence writes.
napi_value MakeSourceDirectory(napi_env env, std::unique_ptr<Parent> parent);
napi_value OpenSourceDirectoryChild(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1; napi_value arg;
    auto parent = Receiver<Parent>(env, info, &sourceDirectoryTag, &count, &arg);
    if (!parent->chain) throw Failure("FS_HANDLE_CLOSED", "Source directory closed");
    if (count != 1) throw Failure("FS_NAME_REJECTED", "Expected source directory name");
    const auto name = Name(env, arg);
    if (!parent->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Source ancestor changed");
    if (parent->chain->privateDepth >= 128) throw Failure("FS_TREE_LIMIT", "Source depth exceeds 128");
    auto child = std::make_unique<Parent>(); child->chain = std::make_shared<DirectoryChain>();
    child->chain->ancestor = parent->chain; child->chain->privateDepth = parent->chain->privateDepth + 1;
    child->chain->Add(OpenChild(parent->chain->Parent(), name, true, GENERIC_READ | READ_CONTROL | SYNCHRONIZE));
    RequireDefaultStreams(child->chain->Parent(), true);
    child->chain->observedSecurity.push_back(SecuritySnapshot::Read(child->chain->Parent()));
    if (!child->chain->Stable()) throw Failure("FS_STAGE_CHANGED", "Source directory changed during open");
    return MakeSourceDirectory(env, std::move(child));
  });
}
napi_value MakeSourceDirectory(napi_env env, std::unique_ptr<Parent> parent) {
  napi_value object; Check(napi_create_object(env, &object));
  Check(napi_type_tag_object(env, object, &sourceDirectoryTag));
  napi_property_descriptor methods[] = {
    {"openDirectory", nullptr, OpenSourceDirectoryChild, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openFile", nullptr, OpenPrivateTreeFile, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(4)},
    {"entries", nullptr, PrivateDirectoryEntries, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(4)},
    {"securityBytes", nullptr, PrivateTreeDirectorySecurity, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(4)},
    {"verify", nullptr, ParentVerify, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(4)},
    {"identity", nullptr, ParentIdentity, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(4)},
    {"close", nullptr, ParentClose, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(4)},
  };
  Check(napi_define_properties(env, object, sizeof(methods) / sizeof(methods[0]), methods));
  Check(napi_wrap(env, object, parent.get(), [](napi_env, void* data, void*) { delete static_cast<Parent*>(data); }, nullptr, nullptr));
  parent.release(); return object;
}
