// Private connected pipe pairs: parent endpoints are overlapped; only the three
// explicit child standard HANDLEs enter the inherited HANDLE_LIST.
struct IoHandle {
  HANDLE value = INVALID_HANDLE_VALUE;
  ~IoHandle() { Close(); }
  void Close() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
};
struct PipeSecurity {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  PipeSecurity() {
    IoHandle token;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value))
      throw Failure("PROCESS_STDIO_SECURITY", "Cannot inspect pipe creator token", GetLastError());
    DWORD size = 0;
    GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
    if (!size) throw Failure("PROCESS_STDIO_SECURITY", "Cannot size pipe creator SID", GetLastError());
    std::vector<BYTE> bytes(size);
    if (!GetTokenInformation(token.value, TokenUser, bytes.data(), size, &size))
      throw Failure("PROCESS_STDIO_SECURITY", "Cannot query pipe creator SID", GetLastError());
    LPWSTR sid = nullptr;
    if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid, &sid))
      throw Failure("PROCESS_STDIO_SECURITY", "Cannot encode pipe creator SID", GetLastError());
    std::wstring sddl;
    try { sddl = L"D:P(A;;GA;;;" + std::wstring(sid) + L")"; }
    catch (...) { LocalFree(sid); throw; }
    LocalFree(sid);
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr))
      throw Failure("PROCESS_STDIO_SECURITY", "Cannot create protected pipe DACL", GetLastError());
  }
  ~PipeSecurity() { if (descriptor) LocalFree(descriptor); }
};
struct ProcessPipe {
  IoHandle parent, child, event;
  OVERLAPPED operation{};
  std::vector<BYTE> buffer;
  bool pending = false;
  bool eof = false;
  bool writing;
  explicit ProcessPipe(bool write) : writing(write) {
    PipeSecurity security;
    BYTE random[32];
    if (BCryptGenRandom(nullptr, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0)
      throw Failure("PROCESS_STDIO_CREATE", "Cannot generate private pipe nonce");
    std::wstring name = L"\\\\.\\pipe\\nozeli-stdio-";
    const wchar_t* digits = L"0123456789abcdef";
    for (const auto byte : random) { name += digits[byte >> 4]; name += digits[byte & 15]; }
    SECURITY_ATTRIBUTES parentSecurity{sizeof(SECURITY_ATTRIBUTES), security.descriptor, FALSE};
    parent.value = CreateNamedPipeW(name.c_str(), (writing ? PIPE_ACCESS_OUTBOUND : PIPE_ACCESS_INBOUND) |
      FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1, 65536, 65536, 0, &parentSecurity);
    if (parent.value == INVALID_HANDLE_VALUE)
      throw Failure("PROCESS_STDIO_CREATE", "Cannot create protected standard pipe", GetLastError());
    SECURITY_ATTRIBUTES childSecurity{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    // Connect both endpoints in this process before creating any child.
    child.value = CreateFileW(name.c_str(), writing ? GENERIC_READ : GENERIC_WRITE,
      0, &childSecurity, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (child.value == INVALID_HANDLE_VALUE)
      throw Failure("PROCESS_STDIO_CREATE", "Cannot open explicit child standard pipe", GetLastError());
    event.value = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!event.value) throw Failure("PROCESS_STDIO_CREATE", "Cannot allocate pipe operation event", GetLastError());
    operation.hEvent = event.value;
    if (!ConnectNamedPipe(parent.value, &operation)) {
      const auto error = GetLastError();
      if (error == ERROR_IO_PENDING) {
        CancelIoEx(parent.value, &operation);
        DWORD ignored = 0;
        GetOverlappedResult(parent.value, &operation, &ignored, TRUE);
      }
      if (error != ERROR_PIPE_CONNECTED)
        throw Failure("PROCESS_STDIO_CREATE", "Pipe connection was not established by creator", error);
    }
    ULONG client = 0, server = 0;
    if (!GetNamedPipeClientProcessId(parent.value, &client) ||
        !GetNamedPipeServerProcessId(child.value, &server) ||
        client != GetCurrentProcessId() || server != GetCurrentProcessId())
      throw Failure("PROCESS_STDIO_SECURITY", "Standard pipe creator endpoints unverified", GetLastError());
    ResetEvent(event.value);
    operation = {}; operation.hEvent = event.value;
  }
  ~ProcessPipe() { Abort(); }
  void Abort() {
    if (pending && parent.value != INVALID_HANDLE_VALUE) {
      CancelIoEx(parent.value, &operation);
      DWORD bytes = 0;
      // Cancellation is asynchronous. Keep OVERLAPPED/buffer alive until its
      // kernel completion, then close. This is not a transfer-success verdict.
      GetOverlappedResult(parent.value, &operation, &bytes, TRUE);
      pending = false;
    }
    parent.Close(); child.Close();
  }
  bool Complete(DWORD& size) {
    if (!pending) throw Failure("PROCESS_STDIO_STATE", "No outstanding pipe operation");
    if (GetOverlappedResult(parent.value, &operation, &size, FALSE)) { pending = false; return true; }
    const auto error = GetLastError();
    if (error == ERROR_IO_INCOMPLETE) return false;
    pending = false;
    if (!writing && (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED)) { eof = true; size = 0; return true; }
    throw Failure(writing ? "PROCESS_STDIN_WRITE_FAILED" : "PROCESS_STDOUT_READ_FAILED", "Standard pipe completion failed; no replay", error);
  }
  bool Start(const BYTE* data, size_t length, DWORD& size) {
    if (pending) throw Failure("PROCESS_STDIO_BUSY", "Pipe operation already pending");
    if (parent.value == INVALID_HANDLE_VALUE) throw Failure("PROCESS_STDIO_CLOSED", "Standard pipe endpoint closed");
    ResetEvent(event.value);operation = {};operation.hEvent = event.value;
    if (writing) buffer.assign(data, data + length);
    else buffer.resize(65536);
    const bool done = writing ? WriteFile(parent.value, buffer.data(), static_cast<DWORD>(buffer.size()), &size, &operation) :
      ReadFile(parent.value, buffer.data(), static_cast<DWORD>(buffer.size()), &size, &operation);
    if (done) return true;
    const auto error = GetLastError();
    if (error == ERROR_IO_PENDING) { pending = true; return false; }
    if (!writing && (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED)) { eof = true; size = 0; return true; }
    throw Failure(writing ? "PROCESS_STDIN_WRITE_FAILED" : "PROCESS_STDOUT_READ_FAILED", "Standard pipe operation failed; no replay", error);
  }
};
struct JobStdio {
  ProcessPipe input{true}, output{false}, error{false};
  bool outputTransferred=false,inputTransferred=false;
  void ReleaseChildEnds() { input.child.Close(); output.child.Close(); error.child.Close(); }
};
