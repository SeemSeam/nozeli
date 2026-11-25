// Included inside the process bridge's private namespace. No HANDLE is exposed
// by number or name, and an arbitrary already-running PID cannot join this Job.
#include "process-stdio.inc"
struct JobPin {
  using Member=nozeli_members::Member;
  std::vector<Member> members;
  std::unique_ptr<JobStdio> stdio;
  HANDLE job = nullptr;
  PROCESS_INFORMATION process{};
  ULONGLONG creation = 0;
  bool resumed = false;
  bool terminationRequested = false;
  bool supervisionAttempted = false;
  // Kernel member notifications: a completion port associated before the
  // suspended leader exists, drained by one collector thread into the same
  // ledger the live enumeration supplements. Sticky errors refuse.
  SRWLOCK memberLock{};
  DWORD memberError=0;
  ULONGLONG memberAnnounced=0;
  nozeli_members::Notifications notifications{&memberLock,&members,&memberAnnounced,&memberError,nullptr,nullptr,nullptr,0};
  HANDLE factsMapping=nullptr;
  nozeli_members::MemberFacts* factsView=nullptr;
  ~JobPin() { Dispose(); }
  void Dispose() {
    // Finalization/unwinding requests kernel cleanup, but supplies no stopped
    // verdict to a business owner. Explicit close below requires observed exit.
    nozeli_members::StopCollector(notifications);
    if (notifications.port) { CloseHandle(notifications.port); notifications.port = nullptr; }
    if (factsView) { UnmapViewOfFile(factsView); factsView = nullptr; }
    if (factsMapping) { CloseHandle(factsMapping); factsMapping = nullptr; }
    if (job) { CloseHandle(job); job = nullptr; }
    stdio.reset();
    if (process.hThread) { CloseHandle(process.hThread); process.hThread = nullptr; }
    if (process.hProcess) { CloseHandle(process.hProcess); process.hProcess = nullptr; }
    for (const auto& member : members) CloseHandle(member.handle);
    members.clear();
  }
  std::string Stamp() const {
    return "win32:" + std::to_string(process.dwProcessId) + ":" + std::to_string(creation);
  }
};
constexpr napi_type_tag jobTag = {0x4e8133e103654187ULL, 0x9d864c7114897f2fULL};
struct JobFacts {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  DWORD wait;
  bool empty;
  DWORD pendingMembers = 0;
  DWORD memberError = 0;
  bool allObserved = false;
  ULONGLONG announced = 0;
  std::vector<nozeli_members::MemberFact> report;
};
void VerifyJobPolicy(JobPin* pin) {
  if (!pin->job) throw Failure("PROCESS_JOB_CLOSED", "Job lease is closed");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  if (!QueryInformationJobObject(pin->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits), nullptr))
    throw Failure("PROCESS_JOB_QUERY_FAILED", "Cannot query retained Job limits", GetLastError());
  if (limits.BasicLimitInformation.LimitFlags != JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
    throw Failure("PROCESS_JOB_POLICY_CHANGED", "Job kill-on-close / no-breakaway policy changed");
  DWORD flags = 0;
  if (!GetHandleInformation(pin->job, &flags))
    throw Failure("PROCESS_JOB_QUERY_FAILED", "Cannot inspect Job HANDLE flags", GetLastError());
  if (flags & HANDLE_FLAG_INHERIT)
    throw Failure("PROCESS_JOB_POLICY_CHANGED", "Job HANDLE unexpectedly inheritable");
}
JobFacts InspectJob(JobPin* pin) {
  VerifyJobPolicy(pin);
  JobFacts facts;
  if (!QueryInformationJobObject(pin->job, JobObjectBasicAccountingInformation,
      &facts.accounting, sizeof(facts.accounting), nullptr))
    throw Failure("PROCESS_JOB_QUERY_FAILED", "Cannot query retained Job accounting", GetLastError());
  facts.wait = WaitForSingleObject(pin->process.hProcess, 0);
  if (facts.wait != WAIT_OBJECT_0 && facts.wait != WAIT_TIMEOUT)
    throw Failure("PROCESS_JOB_QUERY_FAILED", "Cannot wait on retained leader HANDLE", GetLastError());
  struct Released { SRWLOCK* lock; ~Released() { ReleaseSRWLockExclusive(lock); } } released{&pin->memberLock};
  AcquireSRWLockExclusive(&pin->memberLock);
  // Notification failure refuses certification but never blocks stopping or
  // observing: termination authority and completeness proofs stay separate.
  facts.memberError = pin->memberError;
  if (!facts.memberError) {
    try { nozeli_members::Observe(pin->job, pin->process.dwProcessId, pin->members); }
    catch (const nozeli_members::Failure& error) { facts.memberError = error.windows ? error.windows : ERROR_INVALID_DATA; }
  }
  for (const auto& member : pin->members) {
    const auto state = WaitForSingleObject(member.handle, 0);
    if (state == WAIT_TIMEOUT) facts.pendingMembers++;
    else if (state != WAIT_OBJECT_0)
      throw Failure("PROCESS_JOB_MEMBERS_UNVERIFIED", "Cannot wait on retained member HANDLE", GetLastError());
    facts.report.push_back({member.creation, member.pid, state == WAIT_OBJECT_0 ? 1u : 0u});
  }
  facts.announced = pin->memberAnnounced;
  if (pin->factsView) {
    // After supervision handoff only the helper drains the port; its bounded
    // published ledger keeps this lease's counters aligned with the helper's.
    std::vector<nozeli_members::MemberFact> helper;
    ULONGLONG helperAnnounced = 0; DWORD helperError = 0;
    if (!nozeli_members::ReadFacts(pin->factsView, helper, helperAnnounced, helperError) || helperError)
      facts.memberError = helperError ? helperError : ERROR_INVALID_DATA;
    else
    for (const auto& fact : helper) {
      const bool retained = std::any_of(facts.report.begin(), facts.report.end(),
        [&](const nozeli_members::MemberFact& held) { return held.pid == fact.pid && held.creation == fact.creation; });
      if (retained) continue;
      if (!fact.exited) facts.pendingMembers++;
      facts.report.push_back(fact);
    }
    facts.announced = helperAnnounced;
  }
  facts.empty = facts.wait == WAIT_OBJECT_0 && facts.accounting.ActiveProcesses == 0 && facts.pendingMembers == 0;
  // The announced cross-check applies only where a notification consumer is
  // alive (own collector or the helper's published facts); a cold observer
  // keeps the accounting equality alone.
  const bool announcedTracked = pin->factsView || pin->notifications.thread;
  facts.allObserved = !facts.memberError && facts.accounting.TotalProcesses == facts.report.size() + 1 &&
    (!announcedTracked || facts.announced == facts.accounting.TotalProcesses);
  return facts;
}
JobPin* JobReceiver(napi_env env, napi_callback_info info) {
  napi_value self;
  size_t count = 0;
  Check(napi_get_cb_info(env, info, &count, nullptr, &self, nullptr));
  napi_valuetype type;
  Check(napi_typeof(env, self, &type));
  bool tagged = false;
  if (type == napi_object) Check(napi_check_object_type_tag(env, self, &jobTag, &tagged));
  if (!tagged) throw Failure("PROCESS_JOB_RECEIVER", "Expected a native created Job lease");
  JobPin* pin = nullptr;
  Check(napi_unwrap(env, self, reinterpret_cast<void**>(&pin)));
  return pin;
}
napi_value JobSnapshotValue(napi_env env, JobPin* pin) {
  const auto facts = InspectJob(pin);
  napi_value result;
  Check(napi_create_object(env, &result));
  Number(env, result, "schema", 1);
  Number(env, result, "pid", pin->process.dwProcessId);
  Text(env, result, "creationTime100ns", std::to_string(pin->creation));
  Text(env, result, "stamp", pin->Stamp());
  Text(env, result, "leaderState", facts.wait == WAIT_OBJECT_0 ? "exited" : "running");
  Text(env, result, "state", facts.empty ? "exited" : pin->terminationRequested ? "terminating" : pin->resumed ? "running" : "prepared");
  Text(env, result, "launchMode", "attribute-job-list+suspended");
  Number(env, result, "activeProcesses", facts.accounting.ActiveProcesses);
  Number(env, result, "totalProcesses", facts.accounting.TotalProcesses);
  Number(env, result, "observedMembers", static_cast<DWORD>(facts.report.size()));
  Number(env, result, "unexitedObservedMembers", facts.pendingMembers);
  napi_value members;
  Check(napi_create_array_with_length(env, facts.report.size(), &members));
  uint32_t index = 0;
  for (const auto& member : facts.report) {
    napi_value entry;
    Check(napi_create_object(env, &entry));
    Number(env, entry, "pid", member.pid);
    Text(env, entry, "creationTime100ns", std::to_string(member.creation));
    Text(env, entry, "stamp", "win32:" + std::to_string(member.pid) + ":" + std::to_string(member.creation));
    // Own entries waited on their retained original HANDLE here; entries the
    // helper captured were waited on their retained original HANDLE there.
    Text(env, entry, "state", member.exited ? "exited" : "running");
    Check(napi_set_element(env, members, index++, entry));
  }
  Check(napi_set_named_property(env, result, "members", members));
  Boolean(env, result, "allProcessIncarnationsObserved", facts.allObserved);
  if (facts.memberError) Number(env, result, "memberCaptureError", facts.memberError);
  Boolean(env, result, "resumed", pin->resumed);
  Boolean(env, result, "terminationRequested", pin->terminationRequested);
  Boolean(env, result, "jobHandleInheritable", false);
  Boolean(env, result, "breakawayAllowed", false);
  Boolean(env, result, "killOnJobClose", true);
  Boolean(env, result, "jobEmptyObserved", facts.empty);
  Text(env, result, "scope", "created-job-local-handle-only");
  // This exact in-memory Job observation does not establish a persisted owner
  // generation, cold-recovery authority, or any product resource release.
  Boolean(env, result, "ownerRegistrationVerified", false);
  Text(env, result, "stdio", pin->stdio ? "explicit-handle-list" : "disabled");
  if (facts.wait == WAIT_OBJECT_0) {
    DWORD code;
    if (!GetExitCodeProcess(pin->process.hProcess, &code))
      throw Failure("PROCESS_JOB_QUERY_FAILED", "Cannot query exited leader", GetLastError());
    Number(env, result, "leaderExitCode", code);
  }
  return result;
}
napi_value JobSnapshot(napi_env env, napi_callback_info info) {
  return Guard(env, [&] { return JobSnapshotValue(env, JobReceiver(env, info)); });
}
napi_value JobResume(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* pin = JobReceiver(env, info);
    const auto before = InspectJob(pin);
    if (pin->resumed || pin->terminationRequested || before.wait == WAIT_OBJECT_0)
      throw Failure("PROCESS_JOB_RESUME_REFUSED", "Job cannot be resumed again or after termination");
    const DWORD count = ResumeThread(pin->process.hThread);
    if (count == static_cast<DWORD>(-1))
      throw Failure("PROCESS_JOB_RESUME_FAILED", "Cannot resume retained primary thread", GetLastError());
    pin->resumed = true; // Even an unexpected count may have allowed execution.
    if (count != 1) throw Failure("PROCESS_JOB_RESUME_UNVERIFIED", "Unexpected primary-thread suspend count; retain Job");
    return JobSnapshotValue(env, pin);
  });
}
napi_value JobTerminate(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* pin = JobReceiver(env, info);
    // Stopping the original retained Job needs policy authority only; member
    // completeness certification stays refused independently.
    VerifyJobPolicy(pin);
    if (!TerminateJobObject(pin->job, 0xe0000001))
      throw Failure("PROCESS_JOB_TERMINATE_FAILED", "Cannot terminate retained Job", GetLastError());
    pin->terminationRequested = true;
    return JobSnapshotValue(env, pin); // Termination requested != exit observed.
  });
}
napi_value JobClose(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* pin = JobReceiver(env, info);
    if (pin->job) {
      if (!InspectJob(pin).empty)
        throw Failure("PROCESS_JOB_ACTIVE", "Job exit unconfirmed; retain all HANDLEs");
      pin->Dispose();
    }
    napi_value result;
    Check(napi_get_undefined(env, &result));
    return result;
  });
}
JobStdio* RequireStdio(JobPin* pin) {
  if (!pin->job) throw Failure("PROCESS_JOB_CLOSED", "Job lease is closed");
  if (!pin->stdio) throw Failure("PROCESS_STDIO_DISABLED", "This Job has no explicit standard pipes");
  return pin->stdio.get();
}
ProcessPipe* OutputPipe(napi_env env, napi_callback_info info, JobPin* pin) {
  size_t count = 2;
  napi_value args[2];
  Check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
  if (count != 1) throw Failure("PROCESS_STDIO_CHANNEL", "Expected stdout=1 or stderr=2");
  napi_valuetype type;
  Check(napi_typeof(env, args[0], &type));
  double value = 0;
  if (type == napi_number) Check(napi_get_value_double(env, args[0], &value));
  if (type != napi_number || (value != 1 && value != 2))
    throw Failure("PROCESS_STDIO_CHANNEL", "Expected stdout=1 or stderr=2");
  auto* io = RequireStdio(pin);
  return value == 1 ? &io->output : &io->error;
}
napi_value PipeResult(napi_env env, bool complete, ProcessPipe* pipe, DWORD size, bool read) {
  napi_value result;
  Check(napi_create_object(env, &result));
  Text(env, result, "state", !complete ? "pending" : read ? (size ? "data" : "eof") : "done");
  if (complete && read && size) {
    napi_value bytes;
    Check(napi_create_buffer_copy(env, size, pipe->buffer.data(), nullptr, &bytes));
    Check(napi_set_named_property(env, result, "bytes", bytes));
  }
  if (complete && !read) Number(env, result, "bytes", size);
  return result;
}
napi_value JobReadOutput(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* pin=JobReceiver(env,info);
    if(RequireStdio(pin)->outputTransferred)throw Failure("PROCESS_OUTPUT_SUPERVISED","Only the original supervisor may read transferred output endpoints");
    auto* pipe = OutputPipe(env, info, pin);
    DWORD size = 0;
    const bool complete = pipe->eof || (pipe->pending ? pipe->Complete(size) : pipe->Start(nullptr, 0, size));
    if (complete && !size) pipe->eof = true;
    return PipeResult(env, complete, pipe, size, true);
  });
}
napi_value JobWriteInput(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* io=RequireStdio(JobReceiver(env, info));
    if(io->inputTransferred)throw Failure("PROCESS_INPUT_SUPERVISED","Only the original supervisor may write transferred stdin");
    auto* pipe = &io->input;
    size_t count = 2;
    napi_value args[2];
    Check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    bool buffer = false;
    if (count == 1) Check(napi_is_buffer(env, args[0], &buffer));
    if (!buffer) throw Failure("PROCESS_STDIO_BUFFER", "Expected one bounded Buffer");
    void* data = nullptr; size_t size = 0;
    Check(napi_get_buffer_info(env, args[0], &data, &size));
    if (!size || size > 65536) throw Failure("PROCESS_STDIO_BUFFER", "Expected 1..65536 input bytes");
    DWORD transferred = 0;
    const bool complete = pipe->Start(static_cast<BYTE*>(data), size, transferred);
    return PipeResult(env, complete, pipe, transferred, false);
  });
}
napi_value JobPollInput(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* io=RequireStdio(JobReceiver(env, info));
    if(io->inputTransferred)throw Failure("PROCESS_INPUT_SUPERVISED","Only the original supervisor may poll transferred stdin");
    auto* pipe = &io->input;
    DWORD size = 0;
    const bool complete = pipe->Complete(size);
    return PipeResult(env, complete, pipe, size, false);
  });
}
napi_value JobCloseInput(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* io=RequireStdio(JobReceiver(env, info));
    if(io->inputTransferred)throw Failure("PROCESS_INPUT_SUPERVISED","Only the original supervisor may close transferred stdin");
    auto* pipe = &io->input;
    if (pipe->pending) throw Failure("PROCESS_STDIO_BUSY", "Input completion unconfirmed; use explicit abort to discard");
    pipe->parent.Close();
    napi_value result;Check(napi_get_undefined(env, &result));return result;
  });
}
napi_value JobAbortInput(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* io=RequireStdio(JobReceiver(env, info));
    if(io->inputTransferred)throw Failure("PROCESS_INPUT_SUPERVISED","Only the original supervisor may abort transferred stdin");
    io->input.Abort();
    napi_value result;Check(napi_get_undefined(env, &result));return result;
  });
}
napi_value JobCloseOutput(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    OutputPipe(env, info, JobReceiver(env, info))->Abort();
    napi_value result;Check(napi_get_undefined(env, &result));return result;
  });
}
std::wstring JobString(napi_env env, napi_value value) {
  napi_valuetype type;
  Check(napi_typeof(env, value, &type));
  if (type != napi_string) throw Failure("PROCESS_SPEC_INVALID", "Expected a string in process specification");
  size_t size;
  Check(napi_get_value_string_utf16(env, value, nullptr, 0, &size));
  if (size > 32760) throw Failure("PROCESS_SPEC_INVALID", "Process string exceeds native limit");
  std::u16string value16(size + 1, u'\0');
  Check(napi_get_value_string_utf16(env, value, value16.data(), value16.size(), &size));
  std::wstring text(reinterpret_cast<const wchar_t*>(value16.data()), size);
  if (text.find(L'\0') != std::wstring::npos)
    throw Failure("PROCESS_SPEC_INVALID", "Embedded NUL in process specification");
  return text;
}
std::vector<std::wstring> JobStrings(napi_env env, napi_value value) {
  bool array = false;
  Check(napi_is_array(env, value, &array));
  if (!array) throw Failure("PROCESS_SPEC_INVALID", "Expected explicit string array");
  uint32_t length;
  Check(napi_get_array_length(env, value, &length));
  if (length > 4096) throw Failure("PROCESS_SPEC_INVALID", "Process array exceeds native limit");
  std::vector<std::wstring> values;
  for (uint32_t index = 0; index < length; index++) {
    napi_value element;
    Check(napi_get_element(env, value, index, &element));
    values.push_back(JobString(env, element));
  }
  return values;
}
bool LocalAbsolute(const std::wstring& value) {
  return value.size() >= 3 && ((value[0] >= L'A' && value[0] <= L'Z') ||
    (value[0] >= L'a' && value[0] <= L'z')) && value[1] == L':' && value[2] == L'\\';
}
std::wstring QuoteArgument(const std::wstring& value) {
  // Windows CRT argv encoding, not cmd.exe/PowerShell/shell escaping.
  std::wstring quoted = L"\"";
  size_t slashes = 0;
  for (wchar_t character : value) {
    if (character == L'\\') { slashes++; continue; }
    if (character == L'\"') quoted.append(slashes * 2 + 1, L'\\');
    else quoted.append(slashes, L'\\');
    quoted += character;
    slashes = 0;
  }
  quoted.append(slashes * 2, L'\\');
  return quoted + L'\"';
}
struct AttributeList {
  std::vector<BYTE> storage;
  LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
  explicit AttributeList(DWORD count = 1) {
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, count, 0, &size);
    if (!size) throw Failure("PROCESS_JOB_CREATE_FAILED", "Cannot size launch attributes", GetLastError());
    storage.resize(size);
    auto* list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    if (!InitializeProcThreadAttributeList(list, count, 0, &size))
      throw Failure("PROCESS_JOB_CREATE_FAILED", "Cannot initialize launch attributes", GetLastError());
    value = list;
  }
  ~AttributeList() { if (value) DeleteProcThreadAttributeList(value); }
};
napi_value CreateProcessJob(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 6;
    napi_value args[6];
    Check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count != 4 && count != 5) throw Failure("PROCESS_SPEC_INVALID", "Expected executable, argv, cwd, explicit environment and optional stdio mode");
    const auto mode = count == 5 ? JobString(env, args[4]) : std::wstring{};
    const bool piped = mode == L"pipe", console = mode == L"new-console";
    if (count == 5 && !piped && !console)
      throw Failure("PROCESS_SPEC_INVALID", "Expected pipe or new-console stdio mode");
    const auto command = JobString(env, args[0]), cwd = JobString(env, args[2]);
    const auto arguments = JobStrings(env, args[1]);
    auto environment = JobStrings(env, args[3]);
    if (!LocalAbsolute(command) || !LocalAbsolute(cwd) || command.find(L'\"') != std::wstring::npos)
      throw Failure("PROCESS_SPEC_INVALID", "Explicit local absolute executable and cwd are required");
    std::wstring line = QuoteArgument(command);
    for (const auto& argument : arguments) line += L" " + QuoteArgument(argument);
    if (line.size() > 32760) throw Failure("PROCESS_SPEC_INVALID", "Command line exceeds native limit");
    std::vector<std::wstring> keys;
    for (const auto& entry : environment) {
      const auto equal = entry.find(L'=');
      if (equal == 0 || equal == std::wstring::npos)
        throw Failure("PROCESS_SPEC_INVALID", "Environment requires nonempty explicit keys");
      const auto key = entry.substr(0, equal);
      for (const auto& previous : keys)
        if (CompareStringOrdinal(key.c_str(), -1, previous.c_str(), -1, TRUE) == CSTR_EQUAL)
          throw Failure("PROCESS_SPEC_INVALID", "Case-insensitive duplicate environment key");
      keys.push_back(key);
    }
    std::sort(environment.begin(), environment.end(), [](const std::wstring& a, const std::wstring& b) {
      return CompareStringOrdinal(a.c_str(), -1, b.c_str(), -1, TRUE) == CSTR_LESS_THAN;
    });
    std::vector<wchar_t> block;
    for (const auto& entry : environment) { block.insert(block.end(), entry.begin(), entry.end()); block.push_back(0); }
    block.push_back(0);
    if (environment.empty()) block.push_back(0);
    if (block.size() > 32760) throw Failure("PROCESS_SPEC_INVALID", "Environment block exceeds experiment limit");
    auto pin = std::make_unique<JobPin>();
    pin->job = CreateJobObjectW(nullptr, nullptr);
    if (!pin->job) throw Failure("PROCESS_JOB_CREATE_FAILED", "Cannot create private unnamed Job", GetLastError());
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(pin->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
      throw Failure("PROCESS_JOB_CREATE_FAILED", "Cannot set Job cleanup policy", GetLastError());
    // Associate the completion port before any process can exist in this Job,
    // so NEW_PROCESS is queued for the leader and every descendant alike.
    try { pin->notifications.port = nozeli_members::AssociatePort(pin->job); }
    catch (const nozeli_members::Failure& error) { throw Failure("PROCESS_JOB_CREATE_FAILED", error.what(), error.windows); }
    pin->notifications.job = pin->job;
    if (piped) pin->stdio = std::make_unique<JobStdio>();
    AttributeList attributes(piped ? 2 : 1);
    // Atomic association at creation closes the create-suspended/assign gap.
    // Unsupported/nested/permission failures do not fall back to blind spawn.
    if (!UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
        &pin->job, sizeof(pin->job), nullptr, nullptr))
      throw Failure("PROCESS_JOB_CREATE_FAILED", "Cannot bind Job creation attribute", GetLastError());
    STARTUPINFOEXW startup{};
    startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = attributes.value;
    HANDLE childHandles[3]{};
    if (piped) {
      childHandles[0] = pin->stdio->input.child.value;
      childHandles[1] = pin->stdio->output.child.value;
      childHandles[2] = pin->stdio->error.child.value;
      if (!UpdateProcThreadAttribute(attributes.value, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
          childHandles, sizeof(childHandles), nullptr, nullptr))
        throw Failure("PROCESS_STDIO_CREATE", "Cannot restrict inherited standard HANDLEs", GetLastError());
      startup.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
      startup.StartupInfo.hStdInput = childHandles[0];
      startup.StartupInfo.hStdOutput = childHandles[1];
      startup.StartupInfo.hStdError = childHandles[2];
    }
    std::vector<wchar_t> mutableLine(line.begin(), line.end()); mutableLine.push_back(0);
    if (!CreateProcessW(command.c_str(), mutableLine.data(), nullptr, nullptr, piped ? TRUE : FALSE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
        (console ? CREATE_NEW_CONSOLE : CREATE_NO_WINDOW),
        block.data(), cwd.c_str(), &startup.StartupInfo, &pin->process))
      throw Failure("PROCESS_JOB_LAUNCH_FAILED", "Cannot create suspended Job-bound process", GetLastError());
    try {
      if (piped) pin->stdio->ReleaseChildEnds();
      FILETIME creation{}, exit{}, kernel{}, user{};
      if (!GetProcessTimes(pin->process.hProcess, &creation, &exit, &kernel, &user))
        throw Failure("PROCESS_JOB_QUERY_FAILED", "Cannot query created process incarnation", GetLastError());
      pin->creation = Time(creation);
      BOOL member = FALSE;
      if (!IsProcessInJob(pin->process.hProcess, pin->job, &member) || !member)
        throw Failure("PROCESS_JOB_UNVERIFIED", "Created process membership unverified", GetLastError());
      pin->notifications.leaderPid = pin->process.dwProcessId;
      if (!nozeli_members::StartCollector(pin->notifications))
        throw Failure("PROCESS_JOB_CREATE_FAILED", "Cannot start Job member collector", GetLastError());
      InspectJob(pin.get());
      napi_value result;
      Check(napi_create_object(env, &result));
      Check(napi_type_tag_object(env, result, &jobTag));
      napi_property_descriptor methods[] = {
        {"snapshot", nullptr, JobSnapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"resume", nullptr, JobResume, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"terminate", nullptr, JobTerminate, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"close", nullptr, JobClose, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"readOutput", nullptr, JobReadOutput, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"writeInput", nullptr, JobWriteInput, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"pollInput", nullptr, JobPollInput, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"closeInput", nullptr, JobCloseInput, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"abortInput", nullptr, JobAbortInput, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"closeOutput", nullptr, JobCloseOutput, nullptr, nullptr, nullptr, napi_default, nullptr}
      };
      Check(napi_define_properties(env, result, sizeof(methods) / sizeof(methods[0]), methods));
      Check(napi_wrap(env, result, pin.get(), [](napi_env, void* data, void*) { delete static_cast<JobPin*>(data); }, nullptr, nullptr));
      pin.release();
      return result;
    } catch (Failure& error) {
      error.processPid = pin->process.dwProcessId; error.processStamp = pin->Stamp();
      throw; // RAII closes this exact Job. Error does not assert stopped.
    } catch (const std::exception&) {
      Failure error("PROCESS_JOB_BINDING_FAILED", "Created Job result could not be published; cleanup requested, exit unconfirmed");
      error.processPid = pin->process.dwProcessId; error.processStamp = pin->Stamp();
      throw error;
    }
  });
}
void InitProcessJobBindings(napi_env env, napi_value exports) {
  napi_value create;
  Check(napi_create_function(env, "createSuspendedProcessJob", NAPI_AUTO_LENGTH, CreateProcessJob, nullptr, &create));
  Check(napi_set_named_property(env, exports, "createSuspendedProcessJob", create));
}
