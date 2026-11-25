// Dedicated console client. The host creates this process suspended inside the
// terminal's no-breakaway Job and pseudoconsole before any of this code runs.
// Reset only the child's inherited Ctrl-C-ignore attribute, never the GUI host.
#include <windows.h>
#include <cwchar>

namespace {
BOOL WINAPI KeepLauncher(DWORD event) {
  // Handler functions are not inherited. The actual interactive shell receives
  // normal Ctrl-C/Ctrl-Break; this wait-only launcher must survive those events.
  return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}
struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value) CloseHandle(value); }
};
}
int wmain(int argc, wchar_t** argv) {
  if (argc != 2 || std::wcscmp(argv[1], L"--nozeli-terminal-launch-v1") != 0)
    return ERROR_INVALID_PARAMETER;
  if (!SetConsoleCtrlHandler(nullptr, FALSE) || !SetConsoleCtrlHandler(KeepLauncher, TRUE))
    return static_cast<int>(GetLastError());
  constexpr UINT capacity = 32768;
  wchar_t line[capacity]; line[0] = L'"';
  const UINT length = GetSystemDirectoryW(line + 1, capacity - 1);
  constexpr wchar_t suffix[] = L"\\cmd.exe\" /d /q";
  if (!length || length + sizeof(suffix) / sizeof(wchar_t) + 1 >= capacity) return ERROR_FILENAME_EXCED_RANGE;
  // No caller command, ambient COMSPEC, rc hook or shell argument interpolation.
  if (wcscat_s(line, capacity, suffix) != 0) return ERROR_FILENAME_EXCED_RANGE;
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(nullptr, line, nullptr, nullptr, FALSE,
      CREATE_UNICODE_ENVIRONMENT, nullptr, nullptr, &startup, &process))
    return static_cast<int>(GetLastError());
  CloseHandle(process.hThread);
  Handle child{process.hProcess};
  if (WaitForSingleObject(child.value, INFINITE) != WAIT_OBJECT_0)
    return static_cast<int>(GetLastError());
  DWORD code = ERROR_GEN_FAILURE;
  if (!GetExitCodeProcess(child.value, &code)) return static_cast<int>(GetLastError());
  return static_cast<int>(code);
}
