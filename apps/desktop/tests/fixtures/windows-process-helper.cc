// Synthetic native process fixture; never part of the application runtime.
#include <windows.h>
#include <string>
#include <cwchar>
#include <vector>

std::wstring Quote(const std::wstring& value) {
  std::wstring out = L"\"";
  size_t slashes = 0;
  for (const auto character : value) {
    if (character == L'\\') { slashes++; continue; }
    out.append(character == L'\"' ? slashes * 2 + 1 : slashes, L'\\');
    out += character; slashes = 0;
  }
  out.append(slashes * 2, L'\\');return out + L'\"';
}
bool Write(const wchar_t* file, const std::string& value) {
  const auto handle = CreateFileW(file, GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle == INVALID_HANDLE_VALUE) return false;
  DWORD size = 0;
  const bool written = WriteFile(handle, value.data(), static_cast<DWORD>(value.size()), &size, nullptr) && size == value.size();
  CloseHandle(handle);return written;
}
int wmain(int count, wchar_t** args) {
  if (count < 2) return 90;
  const std::wstring mode = args[1];
  if (mode == L"vanish") return 0;
  if (count < 3) return 90;
  if (mode == L"churn") {
    if (count != 4) return 90;
    wchar_t* end = nullptr;
    const long total = wcstol(args[3], &end, 10);
    if (total < 1 || total > 4096 || !end || *end) return 90;
    wchar_t image[32768];
    const auto size = GetModuleFileNameW(nullptr, image, 32768);
    if (!size || size == 32768) return 96;
    const std::wstring command = Quote(std::wstring(image, size)) + L" vanish";
    std::vector<wchar_t> line(command.begin(), command.end());
    line.push_back(0);
    std::string children;
    long spawned = 0;
    for (long index = 0; index < total; index++) {
      STARTUPINFOW startup{};
      startup.cb = sizeof(startup);
      PROCESS_INFORMATION child{};
      if (!CreateProcessW(image, line.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child)) break;
      if (index) children += ",";
      children += std::to_string(child.dwProcessId);
      spawned++;
      // Wait and close immediately: the shortest-lived, hardest-to-pin race.
      WaitForSingleObject(child.hProcess, INFINITE);
      CloseHandle(child.hThread);
      CloseHandle(child.hProcess);
    }
    return Write(args[2], "{\"pid\":" + std::to_string(GetCurrentProcessId()) +
      ",\"spawned\":" + std::to_string(spawned) + ",\"children\":[" + children + "]}") ? 0 : 94;
  }
  if (mode == L"stdio-tail") {
    if (!Write(args[2], "ready")) return 94;
    Sleep(300);
    const std::string tail = "descendant tail";DWORD bytes = 0;
    return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), tail.data(), static_cast<DWORD>(tail.size()), &bytes, nullptr) && bytes == tail.size() ? 0 : 95;
  }
  if (mode == L"spawn-stdio-tail") {
    wchar_t image[32768];const auto size = GetModuleFileNameW(nullptr, image, 32768);
    if (!size || size == 32768) return 96;
    const auto command = Quote(std::wstring(image, size)) + L" \"stdio-tail\" " + Quote(args[2]);
    std::vector<wchar_t> line(command.begin(), command.end());line.push_back(0);
    STARTUPINFOW startup{};startup.cb = sizeof(startup);startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(image, line.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child)) return 97;
    CloseHandle(child.hThread);CloseHandle(child.hProcess);
    const std::string head = "leader head\n";DWORD bytes = 0;
    if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), head.data(), static_cast<DWORD>(head.size()), &bytes, nullptr)) return 98;
    for (size_t attempt = 0; attempt < 500 && GetFileAttributesW(args[2]) == INVALID_FILE_ATTRIBUTES; attempt++) Sleep(10);
    return GetFileAttributesW(args[2]) == INVALID_FILE_ATTRIBUTES ? 99 : 0;
  }
  if (mode == L"hold" || mode == L"record") {
    if (!Write(args[2], "{\"pid\":" + std::to_string(GetCurrentProcessId()) + "}")) return 91;
    if (mode == L"hold") Sleep(12000);
    return 0;
  }
  if (count != 4 || (mode != L"breakaway" && mode != L"nested")) return 92;
  HANDLE inner = nullptr;
  if (mode == L"nested") {
    inner = CreateJobObjectW(nullptr, nullptr);
    if (!inner || !AssignProcessToJobObject(inner, GetCurrentProcess())) {
      const auto error = GetLastError();
      if (inner) CloseHandle(inner);
      Write(args[2], "{\"assigned\":false,\"win32Code\":" + std::to_string(error) + "}");return 0;
    }
  }
  wchar_t image[32768];
  const DWORD imageSize = GetModuleFileNameW(nullptr, image, 32768);
  if (!imageSize || imageSize == 32768) return 93;
  const auto command = Quote(std::wstring(image, imageSize)) +
    (mode == L"nested" ? L" \"hold\" " : L" \"record\" ") + Quote(args[3]);
  std::vector<wchar_t> line(command.begin(), command.end());line.push_back(0);
  STARTUPINFOW startup{};startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  const DWORD flags = CREATE_NO_WINDOW | (mode == L"breakaway" ? CREATE_BREAKAWAY_FROM_JOB : 0);
  const bool created = CreateProcessW(image, line.data(), nullptr, nullptr, FALSE, flags, nullptr, nullptr, &startup, &child);
  const DWORD error = created ? 0 : GetLastError();
  Write(args[2], std::string("{\"assigned\":") + (inner ? "true" : "false") +
    ",\"created\":" + (created ? "true" : "false") + ",\"pid\":" + std::to_string(GetCurrentProcessId()) +
    ",\"childPid\":" + std::to_string(child.dwProcessId) + ",\"win32Code\":" + std::to_string(error) + "}");
  if (created) {
    WaitForSingleObject(child.hProcess, 14000);
    CloseHandle(child.hThread);CloseHandle(child.hProcess);
  }
  if (inner) CloseHandle(inner);
  return 0;
}
