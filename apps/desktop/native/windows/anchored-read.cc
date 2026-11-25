// Experimental W1 read bridge. No production selector imports this module.
// Own each ancestor HANDLE and resolve children with NtCreateFile.RootDirectory;
// never reconstruct child paths from a mutable DOS path or a path prefix check.
#include "anchored-common.h"

void InitWriteBindings(napi_env env, napi_value exports);
using namespace nozeli_windows;

namespace {
struct ReadPin {
  std::vector<std::unique_ptr<Handle>> handles;
  std::vector<Snapshot> initial;
  bool closed = false;
  void Add(std::unique_ptr<Handle> h, bool directory) {
    auto s = Inspect(h->value, directory);
    handles.push_back(std::move(h));
    initial.push_back(s);
  }
  void Close() { handles.clear(); closed = true; }
};
const napi_type_tag pinTag = {0x374562a65ff54019ULL, 0xa95df70c68aa03c1ULL};
ReadPin* Receiver(napi_env env, napi_callback_info info, size_t* count = nullptr, napi_value* args = nullptr) {
  size_t zero = 0;
  napi_value receiver;
  Check(napi_get_cb_info(env, info, count ? count : &zero, args, &receiver, nullptr));
  bool tagged;
  Check(napi_check_object_type_tag(env, receiver, &pinTag, &tagged));
  if (!tagged) throw Failure("FS_HANDLE_REJECTED", "Invalid native read handle receiver");
  ReadPin* pin;
  Check(napi_unwrap(env, receiver, reinterpret_cast<void**>(&pin)));
  return pin;
}
napi_value Close(napi_env env, napi_callback_info info) {
  return Guard(env, [&] { Receiver(env, info)->Close(); return Undefined(env); });
}
napi_value Read(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1;
    napi_value arg;
    auto pin = Receiver(env, info, &count, &arg);
    if (pin->closed) throw Failure("FS_HANDLE_CLOSED", "Read handle closed");
    napi_valuetype type;
    if (count != 1) throw Failure("FS_READ_LIMIT", "Expected a chunk size");
    Check(napi_typeof(env, arg, &type));
    double size = 0;
    if (type != napi_number) throw Failure("FS_READ_LIMIT", "Expected a numeric chunk size");
    Check(napi_get_value_double(env, arg, &size));
    if (!(size >= 1 && size <= 1024 * 1024) || size != static_cast<DWORD>(size))
      throw Failure("FS_READ_LIMIT", "Chunk size must be an integer between 1 and 1048576");
    std::vector<char> bytes(static_cast<size_t>(size));
    DWORD read;
    if (!ReadFile(pin->handles.back()->value, bytes.data(), static_cast<DWORD>(size), &read, nullptr))
      throw Failure("WIN32_IO_ERROR", "Pinned file read failed", GetLastError());
    napi_value result;
    Check(napi_create_buffer_copy(env, read, bytes.data(), nullptr, &result));
    return result;
  });
}
napi_value Verify(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto pin = Receiver(env, info);
    if (pin->closed) throw Failure("FS_HANDLE_CLOSED", "Read handle closed");
    bool stable = true;
    for (size_t i = 0; i < pin->handles.size(); i++) {
      const bool directory = i + 1 < pin->handles.size();
      stable = Same(pin->initial[i], Inspect(pin->handles[i]->value, directory), directory) && stable;
    }
    napi_value result;
    Check(napi_get_boolean(env, stable, &result));
    return result;
  });
}
napi_value Stat(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto pin = Receiver(env, info);
    if (pin->closed) throw Failure("FS_HANDLE_CLOSED", "Read handle closed");
    // Facts captured from this retained HANDLE at open, not a second path open.
    const auto& initial = pin->initial.back();
    napi_value result, size, links, attributes;
    Check(napi_create_object(env, &result));
    Check(napi_create_bigint_int64(env, initial.standard.EndOfFile.QuadPart, &size));
    Check(napi_create_bigint_uint64(env, initial.standard.NumberOfLinks, &links));
    Check(napi_create_uint32(env, initial.basic.FileAttributes, &attributes));
    Check(napi_set_named_property(env, result, "size", size));
    Check(napi_set_named_property(env, result, "nlink", links));
    Check(napi_set_named_property(env, result, "attributes", attributes));
    return result;
  });
}
napi_value ReadAt(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2;
    napi_value args[2];
    auto pin = Receiver(env, info, &count, args);
    if (pin->closed) throw Failure("FS_HANDLE_CLOSED", "Read handle closed");
    if (count != 2) throw Failure("FS_READ_LIMIT", "Expected offset and chunk size");
    double numbers[2];
    for (size_t i = 0; i < 2; i++) {
      napi_valuetype type;
      Check(napi_typeof(env, args[i], &type));
      if (type != napi_number) throw Failure("FS_READ_LIMIT", "Expected numeric offset and size");
      Check(napi_get_value_double(env, args[i], &numbers[i]));
    }
    if (!(numbers[0] >= 0 && numbers[0] <= 9007199254740991.0) ||
        numbers[0] != static_cast<LONGLONG>(numbers[0]) ||
        !(numbers[1] >= 1 && numbers[1] <= 1048576) ||
        numbers[1] != static_cast<DWORD>(numbers[1]))
      throw Failure("FS_READ_LIMIT", "Expected safe integer offset and 1..1048576 chunk size");
    LARGE_INTEGER offset;
    offset.QuadPart = static_cast<LONGLONG>(numbers[0]);
    // Synchronous N-API call: seek + read cannot interleave with another JS
    // stream on this object. Each stream supplies its own absolute cursor.
    if (!SetFilePointerEx(pin->handles.back()->value, offset, nullptr, FILE_BEGIN))
      throw Failure("WIN32_IO_ERROR", "Pinned file seek failed", GetLastError());
    std::vector<char> bytes(static_cast<size_t>(numbers[1]));
    DWORD read;
    if (!ReadFile(pin->handles.back()->value, bytes.data(), static_cast<DWORD>(numbers[1]), &read, nullptr))
      throw Failure("WIN32_IO_ERROR", "Pinned file read failed", GetLastError());
    napi_value result;
    Check(napi_create_buffer_copy(env, read, bytes.data(), nullptr, &result));
    return result;
  });
}
napi_value Identity(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto pin = Receiver(env, info);
    if (pin->closed) throw Failure("FS_HANDLE_CLOSED", "Read handle closed");
    const auto& id = pin->initial.back().id;
    char text[64];
    int n = sprintf_s(text, "%016llx:", static_cast<unsigned long long>(id.VolumeSerialNumber));
    for (BYTE byte : id.FileId.Identifier) n += sprintf_s(text + n, sizeof(text) - n, "%02x", byte);
    napi_value value;
    Check(napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value));
    return value;
  });
}
napi_value Open(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2;
    napi_value args[2];
    Check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    if (count != 2) throw Failure("FS_PATH_REJECTED", "Expected root and relative file");
    const auto root = String(env, args[0]), relative = String(env, args[1]);
    if (root.size() < 3 || !((root[0] >= L'A' && root[0] <= L'Z') || (root[0] >= L'a' && root[0] <= L'z')) ||
        root[1] != L':' || root[2] != L'\\' || relative.empty())
      throw Failure("FS_PATH_REJECTED", "Only absolute local drive roots and relative files are supported");
    auto rootParts = Components(root.substr(3), L'\\');
    auto fileParts = Components(relative, L'/');
    const auto drive = root.substr(0, 3);
    if (GetDriveTypeW(drive.c_str()) != DRIVE_FIXED)
      throw Failure("FS_VOLUME_UNSUPPORTED", "Only fixed local NTFS volumes are supported");
    auto pin = std::make_unique<ReadPin>();
    HANDLE volume = CreateFileW((L"\\\\?\\" + drive).c_str(), FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (volume == INVALID_HANDLE_VALUE) throw Failure("WIN32_IO_ERROR", "Cannot pin drive root", GetLastError());
    pin->Add(std::make_unique<Handle>(volume), true);
    wchar_t filesystem[32];
    if (!GetVolumeInformationByHandleW(volume, nullptr, 0, nullptr, nullptr, nullptr, filesystem, 32))
      throw Failure("WIN32_IO_ERROR", "Cannot identify volume", GetLastError());
    if (wcscmp(filesystem, L"NTFS") != 0) throw Failure("FS_VOLUME_UNSUPPORTED", "Only NTFS is qualified for this experiment");
    for (const auto& name : rootParts) pin->Add(OpenChild(pin->handles.back()->value, name, true), true);
    for (size_t i = 0; i < fileParts.size(); i++) {
      const bool directory = i + 1 < fileParts.size();
      pin->Add(OpenChild(pin->handles.back()->value, fileParts[i], directory), directory);
    }
    // Managed reads currently require a single-link regular file. This bridge
    // keeps that restriction, but does not replace shared policy or byte limits.
    if (pin->initial.back().standard.NumberOfLinks != 1)
      throw Failure("FS_ENTRY_REJECTED", "Multiple hard links rejected");
    napi_value object;
    Check(napi_create_object(env, &object));
    Check(napi_type_tag_object(env, object, &pinTag));
    napi_property_descriptor methods[] = {
      {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readAt", nullptr, ReadAt, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"stat", nullptr, Stat, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"verify", nullptr, Verify, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"identity", nullptr, Identity, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    Check(napi_define_properties(env, object, 6, methods));
    Check(napi_wrap(env, object, pin.get(), [](napi_env, void* data, void*) { delete static_cast<ReadPin*>(data); }, nullptr, nullptr));
    pin.release();
    return object;
  });
}
} // namespace
NAPI_MODULE_INIT() {
  return Guard(env, [&] {
    napi_value open;
    Check(napi_create_function(env, "openAnchoredRead", NAPI_AUTO_LENGTH, Open, nullptr, &open));
    Check(napi_set_named_property(env, exports, "openAnchoredRead", open));
    InitWriteBindings(env, exports);
    return exports;
  });
}
