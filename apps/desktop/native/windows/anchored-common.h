#pragma once
#include <node_api.h>
#include <windows.h>
#include <winternl.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace nozeli_windows {
struct Failure : std::runtime_error {
  const char* code;
  DWORD windows;
  bool committed = false;
  const char* transactionOutcome = nullptr;
  Failure(const char* c, const char* message, DWORD w = 0)
      : std::runtime_error(message), code(c), windows(w) {}
};
inline void Check(napi_status status) {
  if (status != napi_ok) throw Failure("NATIVE_BINDING_ERROR", "Node-API call failed");
}
struct Handle {
  HANDLE value;
  explicit Handle(HANDLE h) : value(h) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
struct Snapshot {
  FILE_ID_INFO id{};
  FILE_BASIC_INFO basic{};
  FILE_STANDARD_INFO standard{};
};
inline Snapshot Inspect(HANDLE handle, bool directory, bool allowDeletePending = false) {
  Snapshot s;
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &s.id, sizeof(s.id)) ||
      !GetFileInformationByHandleEx(handle, FileBasicInfo, &s.basic, sizeof(s.basic)) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &s.standard, sizeof(s.standard)))
    throw Failure("WIN32_IO_ERROR", "Cannot inspect pinned handle", GetLastError());
  if (s.basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    throw Failure("FS_REPARSE_REJECTED", "Reparse entries are outside this experiment");
  if ((!allowDeletePending && s.standard.DeletePending) || static_cast<bool>(s.standard.Directory) != directory)
    throw Failure("FS_ENTRY_REJECTED", "Entry type or delete-pending state rejected");
  return s;
}
inline bool Same(const Snapshot& a, const Snapshot& b, bool directory) {
  const bool identity = a.id.VolumeSerialNumber == b.id.VolumeSerialNumber &&
    memcmp(a.id.FileId.Identifier, b.id.FileId.Identifier, 16) == 0 &&
    a.basic.FileAttributes == b.basic.FileAttributes;
  return identity && (directory || (
    a.basic.LastWriteTime.QuadPart == b.basic.LastWriteTime.QuadPart &&
    a.basic.ChangeTime.QuadPart == b.basic.ChangeTime.QuadPart &&
    a.standard.EndOfFile.QuadPart == b.standard.EndOfFile.QuadPart &&
    a.standard.NumberOfLinks == b.standard.NumberOfLinks));
}
using NtCreate = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
  PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
using NtError = ULONG (WINAPI*)(NTSTATUS);
inline std::unique_ptr<Handle> OpenChild(HANDLE parent, const std::wstring& name, bool directory,
    ACCESS_MASK requested = 0, ULONG disposition = 1 /* FILE_OPEN */,
    PSECURITY_DESCRIPTOR security = nullptr, ULONG sharing = FILE_SHARE_READ, ULONG_PTR* information = nullptr,
    NTSTATUS* nativeStatus = nullptr) {
  auto ntdll = GetModuleHandleW(L"ntdll.dll");
  auto create = reinterpret_cast<NtCreate>(GetProcAddress(ntdll, "NtCreateFile"));
  auto error = reinterpret_cast<NtError>(GetProcAddress(ntdll, "RtlNtStatusToDosError"));
  if (!create || !error) throw Failure("NATIVE_API_UNAVAILABLE", "Required NT file APIs unavailable");
  UNICODE_STRING child{};
  child.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  child.MaximumLength = child.Length;
  child.Buffer = const_cast<wchar_t*>(name.data());
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &child;
  attributes.Attributes = 0x40; // OBJ_CASE_INSENSITIVE
  attributes.SecurityDescriptor = security;
  IO_STATUS_BLOCK io{};
  auto result = std::make_unique<Handle>(INVALID_HANDLE_VALUE);
  // FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT | type constraint.
  const ULONG options = 0x00200000 | 0x20 | (directory ? 1 : 0x40);
  const ACCESS_MASK access = requested ? requested : SYNCHRONIZE | (directory ? FILE_READ_ATTRIBUTES : GENERIC_READ);
  const NTSTATUS status = create(&result->value, access, &attributes, &io, nullptr, 0,
    sharing, disposition, options, nullptr, 0);
  if (nativeStatus) *nativeStatus = status;
  if (status < 0) throw Failure("WIN32_IO_ERROR", "Cannot open pinned child", error(status));
  if (information) *information = io.Information;
  return result;
}
inline std::wstring String(napi_env env, napi_value value) {
  napi_valuetype type;
  Check(napi_typeof(env, value, &type));
  if (type != napi_string) throw Failure("FS_PATH_REJECTED", "Expected a path string");
  size_t length;
  Check(napi_get_value_string_utf16(env, value, nullptr, 0, &length));
  if (length > 32760) throw Failure("FS_PATH_REJECTED", "Path exceeds experiment limit");
  std::u16string text(length + 1, u'\0');
  Check(napi_get_value_string_utf16(env, value, text.data(), text.size(), &length));
  return std::wstring(reinterpret_cast<const wchar_t*>(text.data()), length);
}
inline std::vector<std::wstring> Components(const std::wstring& text, wchar_t separator) {
  std::vector<std::wstring> parts;
  size_t start = 0;
  while (start < text.size()) {
    const size_t end = text.find(separator, start);
    auto part = text.substr(start, end == std::wstring::npos ? end : end - start);
    if (part.empty() || part.size() > 255 || part == L"." || part == L".." ||
        part.back() == L'.' || part.back() == L' ' ||
        part.find_first_of(L"/\\:*?\"<>|") != std::wstring::npos ||
        std::any_of(part.begin(), part.end(), [](wchar_t c) { return c < 32; }))
      throw Failure("FS_PATH_REJECTED", "Unsafe path component");
    parts.push_back(part);
    if (end == std::wstring::npos) break;
    start = end + 1;
    if (start == text.size()) throw Failure("FS_PATH_REJECTED", "Trailing separator rejected");
  }
  return parts;
}
inline napi_value Undefined(napi_env env) { napi_value v; Check(napi_get_undefined(env, &v)); return v; }
inline napi_value Throw(napi_env env, const Failure& error) {
  napi_value message, value, code, windows;
  napi_create_string_utf8(env, error.what(), NAPI_AUTO_LENGTH, &message);
  napi_create_error(env, nullptr, message, &value);
  napi_create_string_utf8(env, error.code, NAPI_AUTO_LENGTH, &code);
  napi_set_named_property(env, value, "code", code);
  napi_create_uint32(env, error.windows, &windows);
  napi_set_named_property(env, value, "win32Code", windows);
  if (error.transactionOutcome) {
    napi_value outcome;
    napi_create_string_utf8(env, error.transactionOutcome, NAPI_AUTO_LENGTH, &outcome);
    napi_set_named_property(env, value, "transactionOutcome", outcome);
  }
  if (error.committed) {
    napi_value committed, durability;
    napi_get_boolean(env, true, &committed);
    napi_set_named_property(env, value, "committed", committed);
    napi_create_string_utf8(env, "uncertain", NAPI_AUTO_LENGTH, &durability);
    napi_set_named_property(env, value, "durability", durability);
  }
  napi_throw(env, value);
  return nullptr;
}
template <typename F> napi_value Guard(napi_env env, F work) {
  try { return work(); }
  catch (const Failure& e) { return Throw(env, e); }
  catch (const std::exception&) { return Throw(env, Failure("NATIVE_BINDING_ERROR", "Native allocation or runtime failure")); }
}
} // namespace nozeli_windows
