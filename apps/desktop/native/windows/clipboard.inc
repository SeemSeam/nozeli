// Standard CF_HDROP cannot be emitted by registering a format named CF_HDROP.
// Exact native generation guards all read/prepare/write boundaries.
struct ClipboardSession {
  HWND window = nullptr;
  ClipboardSession() {
    window = CreateWindowExW(0, L"STATIC", L"Nozeli file clipboard", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, nullptr, nullptr);
    if (!window) throw Failure("CLIPBOARD_UNAVAILABLE", "Cannot create clipboard owner", GetLastError());
    if (!OpenClipboard(window)) { const auto code = GetLastError(); DestroyWindow(window); window = nullptr; throw Failure("CLIPBOARD_BUSY", "Clipboard busy; retry", code); }
  }
  ~ClipboardSession() { if (window) { CloseClipboard(); DestroyWindow(window); } }
};
struct ClipboardMemory {
  HGLOBAL handle = nullptr;
  explicit ClipboardMemory(const std::vector<unsigned char>& bytes) {
    handle = GlobalAlloc(GMEM_MOVEABLE, bytes.size());
    if (!handle) throw Failure("CLIPBOARD_UNAVAILABLE", "Clipboard allocation failed", GetLastError());
    auto pointer = GlobalLock(handle); if (!pointer) { GlobalFree(handle); handle = nullptr; throw Failure("CLIPBOARD_UNAVAILABLE", "Clipboard allocation lock failed", GetLastError()); }
    memcpy(pointer, bytes.data(), bytes.size()); GlobalUnlock(handle);
  }
  ~ClipboardMemory() { if (handle) GlobalFree(handle); }
  void Publish(UINT format) {
    if (!SetClipboardData(format, handle)) throw Failure("CLIPBOARD_WRITE_FAILED", "Clipboard publication incomplete", GetLastError());
    handle = nullptr;
  }
};
UINT ClipboardFormat(const std::wstring& name) {
  if (name == L"CF_HDROP") return CF_HDROP;
  if (name == L"FileNameW" || name == L"Preferred DropEffect" || name == L"application/x-nozeli-file-clipboard") {
    const auto format = RegisterClipboardFormatW(name.c_str()); if (format) return format;
  }
  throw Failure("CLIPBOARD_FORMAT_REJECTED", "Unexpected native file clipboard format");
}
napi_value ReadNativeFileClipboard(napi_env env, napi_callback_info) {
  return Guard(env, [&] {
    ClipboardSession clipboard; const auto sequence = GetClipboardSequenceNumber();
    napi_value result, value, rows; Check(napi_create_object(env, &result)); Check(napi_create_array(env, &rows));
    size_t index = 0, total = 0;
    for (const auto name : {L"CF_HDROP", L"FileNameW", L"Preferred DropEffect", L"application/x-nozeli-file-clipboard"}) {
      const auto format = ClipboardFormat(name); if (!IsClipboardFormatAvailable(format)) continue;
      const auto handle = GetClipboardData(format); if (!handle) throw Failure("CLIPBOARD_UNAVAILABLE", "Clipboard payload unavailable", GetLastError());
      const auto size = GlobalSize(handle); if (!size || size > 16 * 1024 * 1024 || (total += size) > 16 * 1024 * 1024) throw Failure("CLIPBOARD_LIMIT", "File clipboard exceeds 16 MiB");
      const auto pointer = GlobalLock(handle); if (!pointer) throw Failure("CLIPBOARD_UNAVAILABLE", "Cannot lock clipboard payload", GetLastError());
      napi_value row, bytes; try { Check(napi_create_object(env, &row)); Check(napi_create_buffer_copy(env, size, pointer, nullptr, &bytes)); } catch (...) { GlobalUnlock(handle); throw; } GlobalUnlock(handle);
      Check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(name), wcslen(name), &value)); Check(napi_set_named_property(env, row, "format", value)); Check(napi_set_named_property(env, row, "bytes", bytes)); Check(napi_set_element(env, rows, static_cast<uint32_t>(index++), row));
    }
    if (GetClipboardSequenceNumber() != sequence) throw Failure("CLIPBOARD_CHANGED", "Clipboard changed while reading");
    Check(napi_create_uint32(env, sequence, &value)); Check(napi_set_named_property(env, result, "sequence", value)); Check(napi_set_named_property(env, result, "entries", rows)); return result;
  });
}
napi_value WriteNativeFileClipboard(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2; napi_value args[2]; Check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr)); bool array = false;
    if (count != 2) throw Failure("CLIPBOARD_FORMAT_REJECTED", "Expected generation and format rows");
    uint32_t expected; Check(napi_get_value_uint32(env, args[0], &expected)); Check(napi_is_array(env, args[1], &array)); if (!array) throw Failure("CLIPBOARD_FORMAT_REJECTED", "Expected format rows");
    uint32_t length; Check(napi_get_array_length(env, args[1], &length)); if (!length || length > 3) throw Failure("CLIPBOARD_FORMAT_REJECTED", "Expected marker and optional file formats");
    std::vector<std::pair<UINT, std::unique_ptr<ClipboardMemory>>> rows; size_t total = 0; bool marker = false;
    for (uint32_t i = 0; i < length; ++i) {
      napi_value row, formatValue, bytesValue; Check(napi_get_element(env, args[1], i, &row)); Check(napi_get_named_property(env, row, "format", &formatValue)); Check(napi_get_named_property(env, row, "bytes", &bytesValue));
      const auto name = String(env, formatValue); const auto format = ClipboardFormat(name); bool buffer; Check(napi_is_buffer(env, bytesValue, &buffer)); if (!buffer || name == L"FileNameW") throw Failure("CLIPBOARD_FORMAT_REJECTED", "Expected bounded clipboard bytes");
      void* pointer; size_t size; Check(napi_get_buffer_info(env, bytesValue, &pointer, &size)); if (!size || (total += size) > 16 * 1024 * 1024) throw Failure("CLIPBOARD_LIMIT", "File clipboard exceeds 16 MiB");
      for (const auto& old : rows) if (old.first == format) throw Failure("CLIPBOARD_FORMAT_REJECTED", "Duplicate clipboard format");
      if (name == L"application/x-nozeli-file-clipboard") { if (size != 36) throw Failure("CLIPBOARD_FORMAT_REJECTED", "Expected nonce marker"); marker = true; }
      const auto begin = static_cast<const unsigned char*>(pointer); rows.emplace_back(format, std::make_unique<ClipboardMemory>(std::vector<unsigned char>(begin, begin + size)));
    }
    if (!marker) throw Failure("CLIPBOARD_FORMAT_REJECTED", "Clipboard marker required");
    ClipboardSession clipboard; if (GetClipboardSequenceNumber() != expected) throw Failure("CLIPBOARD_CHANGED", "Clipboard changed; copy again");
    if (!EmptyClipboard()) throw Failure("CLIPBOARD_WRITE_FAILED", "Cannot clear clipboard", GetLastError());
    try { for (auto& row : rows) row.second->Publish(row.first); }
    catch (Failure& error) { error.committed = true; throw; }
    napi_value result; Check(napi_create_uint32(env, GetClipboardSequenceNumber(), &result)); return result;
  });
}
