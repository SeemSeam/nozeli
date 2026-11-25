// Included after process-job.inc: reuses its strict Job, argv and overlapped-pipe primitives.
// The console endpoints never enter the child HANDLE table; only ConPTY receives them.
struct ConptyPin {
  JobPin owner;
  ProcessPipe input{true}, output{false};
  HPCON console = nullptr;
  HANDLE closer = nullptr;
  bool closing = false;
  using CloseFn = void (WINAPI*)(HPCON);
  CloseFn closeConsole = nullptr;
  static DWORD WINAPI CloseWorker(void* data) {
    auto* pin = static_cast<ConptyPin*>(data);
    pin->closeConsole(pin->console);
    return 0;
  }
  void BeginClose() {
    if (!console || closing) return;
    closer = CreateThread(nullptr, 0, CloseWorker, this, 0, nullptr);
    if (!closer) throw Failure("CONPTY_CLOSE_UNKNOWN", "Cannot start console close; retain lease", GetLastError());
    closing = true;
  }
  ~ConptyPin() {
    // Kill the exact Job before cancelling I/O. Closing the output reader releases
    // a console blocked flushing output, so finalization cannot deadlock on it.
    if (owner.job) TerminateJobObject(owner.job, 0xe0000001);
    output.Abort(); input.Abort();
    if (closer) { WaitForSingleObject(closer, INFINITE); CloseHandle(closer); }
    else if (console) closeConsole(console);
  }
};
constexpr napi_type_tag conptyTag = {0x74c607b683644241ULL, 0x930fb9361c086195ULL};
ConptyPin* ConptyReceiver(napi_env env, napi_callback_info info) {
  napi_value self; size_t count = 0;
  Check(napi_get_cb_info(env, info, &count, nullptr, &self, nullptr));
  bool tagged = false; napi_valuetype type;
  Check(napi_typeof(env, self, &type));
  if (type == napi_object) Check(napi_check_object_type_tag(env, self, &conptyTag, &tagged));
  if (!tagged) throw Failure("CONPTY_RECEIVER", "Expected a native ConPTY lease");
  ConptyPin* pin = nullptr; Check(napi_unwrap(env, self, reinterpret_cast<void**>(&pin))); return pin;
}
napi_value ConptySnapshot(napi_env env, napi_callback_info info) {
  return Guard(env, [&] { return JobSnapshotValue(env, &ConptyReceiver(env, info)->owner); });
}
napi_value ConptyResume(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* pin = ConptyReceiver(env, info); auto& owner = pin->owner;
    if (owner.resumed || owner.terminationRequested || InspectJob(&owner).wait == WAIT_OBJECT_0)
      throw Failure("CONPTY_RESUME_REFUSED", "Console cannot be resumed again or after termination");
    DWORD count = ResumeThread(owner.process.hThread);
    if (count == DWORD(-1)) throw Failure("CONPTY_RESUME_FAILED", "Cannot resume console process", GetLastError());
    owner.resumed = true;
    if (count != 1) throw Failure("CONPTY_RESUME_UNKNOWN", "Unexpected suspend count; retain console Job");
    return JobSnapshotValue(env, &owner);
  });
}
napi_value ConptyTerminate(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* pin = ConptyReceiver(env, info); InspectJob(&pin->owner);
    if (!TerminateJobObject(pin->owner.job, 0xe0000001))
      throw Failure("CONPTY_TERMINATE_UNKNOWN", "Cannot terminate console Job", GetLastError());
    pin->owner.terminationRequested = true;
    pin->input.Abort();
    pin->BeginClose();
    return JobSnapshotValue(env, &pin->owner);
  });
}
napi_value ConptyRead(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* pin = ConptyReceiver(env, info);
    if (InspectJob(&pin->owner).empty) pin->BeginClose();
    auto* pipe = &pin->output; DWORD size = 0;
    bool complete = pipe->eof || (pipe->pending ? pipe->Complete(size) : pipe->Start(nullptr, 0, size));
    if (complete && !size) pipe->eof = true;
    return PipeResult(env, complete, pipe, size, true);
  });
}
napi_value ConptyWrite(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* pin = ConptyReceiver(env, info); size_t count = 2; napi_value args[2];
    Check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    bool buffer = false; if (count == 1) Check(napi_is_buffer(env, args[0], &buffer));
    if (!buffer) throw Failure("CONPTY_INPUT_INVALID", "Expected one UTF-8 Buffer");
    void* bytes; size_t size; Check(napi_get_buffer_info(env, args[0], &bytes, &size));
    if (!size || size > 16384) throw Failure("CONPTY_INPUT_INVALID", "Input must contain 1..16384 bytes");
    if (pin->closing) throw Failure("CONPTY_CLOSED", "Console is closing");
    DWORD written = 0;
    bool done = pin->input.Start(static_cast<BYTE*>(bytes), size, written);
    return PipeResult(env, done, &pin->input, written, false);
  });
}
napi_value ConptyPollInput(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* pipe = &ConptyReceiver(env, info)->input; DWORD size = 0;
    bool complete = !pipe->pending || pipe->Complete(size);
    return PipeResult(env, complete, pipe, size, false);
  });
}
COORD ConptySize(napi_env env, napi_value columns, napi_value rows) {
  double c = 0, r = 0; napi_valuetype ct, rt;
  Check(napi_typeof(env, columns, &ct)); Check(napi_typeof(env, rows, &rt));
  if (ct != napi_number || rt != napi_number) throw Failure("CONPTY_SIZE_INVALID", "Expected numeric console size");
  Check(napi_get_value_double(env, columns, &c)); Check(napi_get_value_double(env, rows, &r));
  if (!std::isfinite(c) || !std::isfinite(r) || c != std::floor(c) || r != std::floor(r) || c < 2 || c > 500 || r < 2 || r > 300)
    throw Failure("CONPTY_SIZE_INVALID", "Console size outside 2..500 by 2..300");
  return COORD{static_cast<SHORT>(c), static_cast<SHORT>(r)};
}
napi_value ConptyResize(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* pin = ConptyReceiver(env, info); size_t count = 3; napi_value args[3];
    Check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count != 2 || pin->closing) throw Failure("CONPTY_RESIZE_REFUSED", "Expected size for a live console");
    auto size = ConptySize(env, args[0], args[1]);
    using Fn = HRESULT (WINAPI*)(HPCON, COORD);
    auto resize = reinterpret_cast<Fn>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "ResizePseudoConsole"));
    if (!resize) throw Failure("CONPTY_UNAVAILABLE", "ResizePseudoConsole unavailable");
    HRESULT status = resize(pin->console, size);
    if (FAILED(status)) throw Failure("CONPTY_RESIZE_FAILED", "ResizePseudoConsole failed", static_cast<DWORD>(status));
    napi_value result; Check(napi_get_undefined(env, &result)); return result;
  });
}
napi_value ConptyClose(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* pin = ConptyReceiver(env, info);
    if (pin->owner.job) {
      if (!InspectJob(&pin->owner).empty) throw Failure("CONPTY_CLEANUP_UNKNOWN", "Job exit not observed; retain lease");
      pin->BeginClose();
      if (!pin->output.eof || WaitForSingleObject(pin->closer, 0) != WAIT_OBJECT_0)
        throw Failure("CONPTY_DRAIN_PENDING", "Console output/close not complete; retain lease");
      CloseHandle(pin->closer); pin->closer = nullptr; pin->console = nullptr;
      pin->input.Abort(); pin->output.Abort(); pin->owner.Dispose();
    }
    napi_value result; Check(napi_get_undefined(env, &result)); return result;
  });
}
std::wstring ProjectShellPath() {
  wchar_t directory[32768]; UINT size = GetSystemDirectoryW(directory, 32768);
  if (!size || size >= 32768) throw Failure("SHELL_UNAVAILABLE", "Cannot resolve native System32", GetLastError());
  std::wstring path(directory, size); path += L"\\cmd.exe"; return path;
}
napi_value ProjectTerminalShell(napi_env env, napi_callback_info) {
  return Guard(env, [&] {
    const auto path = ProjectShellPath();
    napi_value result; Check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(path.data()), path.size(), &result)); return result;
  });
}
std::wstring ProjectTerminalLauncherPath() {
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
      reinterpret_cast<LPCWSTR>(&ProjectTerminalShell), &module))
    throw Failure("CONPTY_LAUNCHER_UNAVAILABLE", "Cannot bind terminal module", GetLastError());
  wchar_t file[32768]; const auto length = GetModuleFileNameW(module, file, 32768);
  if (!length || length >= 32768) throw Failure("CONPTY_LAUNCHER_UNAVAILABLE", "Cannot resolve terminal companion", GetLastError());
  std::wstring path(file, length); const auto separator = path.find_last_of(L'\\');
  if (separator == std::wstring::npos) throw Failure("CONPTY_LAUNCHER_UNAVAILABLE", "Terminal module has no native directory");
  path.resize(separator + 1); path += L"nozeli_windows_terminal.exe"; return path;
}
napi_value CreateProjectConpty(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 7; napi_value args[7]; Check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count != 6) throw Failure("CONPTY_SPEC_INVALID", "Expected executable, argv, cwd, environment, columns, rows");
    auto command = JobString(env, args[0]), cwd = JobString(env, args[2]);
    auto arguments = JobStrings(env, args[1]), environment = JobStrings(env, args[3]);
    auto size = ConptySize(env, args[4], args[5]);
    if (!LocalAbsolute(command) || !LocalAbsolute(cwd) || command.find(L'"') != std::wstring::npos)
      throw Failure("CONPTY_SPEC_INVALID", "Explicit local executable and cwd required");
    if (_wcsicmp(command.c_str(), ProjectShellPath().c_str()) != 0 || arguments.size() != 2 || arguments[0] != L"/d" || arguments[1] != L"/q")
      throw Failure("CONPTY_SPEC_INVALID", "Project terminals require the fixed native System32 shell policy");
    const auto launcher = ProjectTerminalLauncherPath();
    std::wstring line = QuoteArgument(launcher); line += L" --nozeli-terminal-launch-v1";
    if (line.size() > 32760) throw Failure("CONPTY_SPEC_INVALID", "Command line exceeds native limit");
    std::sort(environment.begin(), environment.end(), [](const std::wstring& a, const std::wstring& b) {
      return CompareStringOrdinal(a.c_str(), -1, b.c_str(), -1, TRUE) == CSTR_LESS_THAN;
    });
    std::vector<std::wstring> keys; std::vector<wchar_t> block;
    for (const auto& entry : environment) {
      auto equal = entry.find(L'=');
      if (!equal || equal == std::wstring::npos) throw Failure("CONPTY_SPEC_INVALID", "Invalid environment key");
      auto key = entry.substr(0, equal);
      for (const auto& previous : keys) if (CompareStringOrdinal(key.c_str(), -1, previous.c_str(), -1, TRUE) == CSTR_EQUAL)
        throw Failure("CONPTY_SPEC_INVALID", "Duplicate environment key");
      keys.push_back(key); block.insert(block.end(), entry.begin(), entry.end()); block.push_back(0);
    }
    block.push_back(0); if (environment.empty()) block.push_back(0);
    if (block.size() > 32760) throw Failure("CONPTY_SPEC_INVALID", "Environment exceeds native limit");
    IoHandle launcherPin;
    launcherPin.value = CreateFileW(launcher.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (launcherPin.value == INVALID_HANDLE_VALUE)
      throw Failure("CONPTY_LAUNCHER_UNAVAILABLE", "Terminal companion is missing or locked; rebuild the native component", GetLastError());
    BY_HANDLE_FILE_INFORMATION launcherInfo{};
    if (!GetFileInformationByHandle(launcherPin.value, &launcherInfo) || launcherInfo.nNumberOfLinks != 1 ||
        launcherInfo.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
      throw Failure("CONPTY_LAUNCHER_UNVERIFIED", "Terminal companion must be a single-link ordinary file");
    auto pin = std::make_unique<ConptyPin>();
    HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
    using CreateFn = HRESULT (WINAPI*)(COORD, HANDLE, HANDLE, DWORD, HPCON*);
    auto create = reinterpret_cast<CreateFn>(GetProcAddress(kernel, "CreatePseudoConsole"));
    pin->closeConsole = reinterpret_cast<ConptyPin::CloseFn>(GetProcAddress(kernel, "ClosePseudoConsole"));
    if (!create || !pin->closeConsole) throw Failure("CONPTY_UNAVAILABLE", "Windows ConPTY APIs unavailable");
    HRESULT status = create(size, pin->input.child.value, pin->output.child.value, 0, &pin->console);
    if (FAILED(status)) throw Failure("CONPTY_CREATE_FAILED", "Cannot create native pseudoconsole", static_cast<DWORD>(status));
    auto& owner = pin->owner;
    owner.job = CreateJobObjectW(nullptr, nullptr);
    if (!owner.job) throw Failure("CONPTY_JOB_FAILED", "Cannot create console Job", GetLastError());
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(owner.job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
      throw Failure("CONPTY_JOB_FAILED", "Cannot enforce console Job policy", GetLastError());
    AttributeList attributes(2);
    if (!UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, pin->console, sizeof(HPCON), nullptr, nullptr) ||
        !UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &owner.job, sizeof(HANDLE), nullptr, nullptr))
      throw Failure("CONPTY_JOB_FAILED", "Cannot establish console and atomic Job attributes", GetLastError());
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes.value;
    // Match the pinned node-pty ConPTY startup policy: clear inherited redirected
    // stdin/stdout/stderr so the client uses this console, not the host's pipes.
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    std::vector<wchar_t> mutableLine(line.begin(), line.end()); mutableLine.push_back(0);
    if (!CreateProcessW(launcher.c_str(), mutableLine.data(), nullptr, nullptr, FALSE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
        block.data(), cwd.c_str(), &startup.StartupInfo, &owner.process))
      throw Failure("CONPTY_LAUNCH_FAILED", "Cannot create suspended console shell in Job", GetLastError());
    // The pseudoconsole/client startup handshake still needs these endpoint
    // references until CreateProcess completes. Closing them earlier can end
    // the console input before the suspended client has attached.
    pin->input.child.Close(); pin->output.child.Close();
    FILETIME creation{}, exit{}, kernelTime{}, user{};
    if (!GetProcessTimes(owner.process.hProcess, &creation, &exit, &kernelTime, &user))
      throw Failure("CONPTY_IDENTITY_UNKNOWN", "Cannot pin original shell incarnation", GetLastError());
    owner.creation = Time(creation);
    BOOL member = FALSE;
    if (!IsProcessInJob(owner.process.hProcess, owner.job, &member) || !member)
      throw Failure("CONPTY_IDENTITY_UNKNOWN", "Console Job membership unverified", GetLastError());
    InspectJob(&owner);
    napi_value result; Check(napi_create_object(env, &result)); Check(napi_type_tag_object(env, result, &conptyTag));
    napi_property_descriptor methods[] = {
      {"snapshot",nullptr,ConptySnapshot,nullptr,nullptr,nullptr,napi_default,nullptr},
      {"resume",nullptr,ConptyResume,nullptr,nullptr,nullptr,napi_default,nullptr},
      {"terminate",nullptr,ConptyTerminate,nullptr,nullptr,nullptr,napi_default,nullptr},
      {"readOutput",nullptr,ConptyRead,nullptr,nullptr,nullptr,napi_default,nullptr},
      {"writeInput",nullptr,ConptyWrite,nullptr,nullptr,nullptr,napi_default,nullptr},
      {"pollInput",nullptr,ConptyPollInput,nullptr,nullptr,nullptr,napi_default,nullptr},
      {"resize",nullptr,ConptyResize,nullptr,nullptr,nullptr,napi_default,nullptr},
      {"close",nullptr,ConptyClose,nullptr,nullptr,nullptr,napi_default,nullptr}
    };
    Check(napi_define_properties(env, result, sizeof(methods)/sizeof(methods[0]), methods));
    Check(napi_wrap(env, result, pin.get(), [](napi_env, void* data, void*) { delete static_cast<ConptyPin*>(data); }, nullptr, nullptr));
    pin.release(); return result;
  });
}
void InitProjectConptyBindings(napi_env env, napi_value exports) {
  napi_value create, shell;
  Check(napi_create_function(env, "createProjectConpty", NAPI_AUTO_LENGTH, CreateProjectConpty, nullptr, &create));
  Check(napi_set_named_property(env, exports, "createProjectConpty", create));
  Check(napi_create_function(env, "projectTerminalShell", NAPI_AUTO_LENGTH, ProjectTerminalShell, nullptr, &shell));
  Check(napi_set_named_property(env, exports, "projectTerminalShell", shell));
}
