// Read-only W2 primitive. A process HANDLE is not a tree ownership lease.
#include <node_api.h>
#include <windows.h>
#include <tlhelp32.h>
#include <sddl.h>
#include <bcrypt.h>
#include <algorithm>
#include <cmath>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include "supervisor-protocol.h"
#include "process-members.h"
#include "../windows/custody-transfer.h"

namespace {
struct Failure : std::runtime_error {
  const char* code;
  DWORD windows;
  DWORD processPid = 0;
  std::string processStamp;
  Failure(const char* c, const char* message, DWORD w = 0)
      : std::runtime_error(message), code(c), windows(w) {}
};
void Check(napi_status status) {
  if (status != napi_ok) throw Failure("PROCESS_BINDING_ERROR", "Node-API call failed");
}
napi_value Throw(napi_env env, const char* failureCode, const char* text, DWORD failureWindows) {
    napi_value message, value, code, windows;
    napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &message);
    napi_create_error(env, nullptr, message, &value);
    napi_create_string_utf8(env, failureCode, NAPI_AUTO_LENGTH, &code);
    napi_set_named_property(env, value, "code", code);
    napi_create_uint32(env, failureWindows, &windows);
    napi_set_named_property(env, value, "win32Code", windows);
    napi_throw(env, value);
    return nullptr;
}
template <typename F> napi_value Guard(napi_env env, F work) {
  try { return work(); }
  catch (const Failure& error) {
    napi_value result = Throw(env, error.code, error.what(), error.windows);
    if (error.processPid) {
      napi_value pending, pid, stamp, unverified;
      napi_get_and_clear_last_exception(env, &pending);
      napi_create_uint32(env, error.processPid, &pid);
      napi_set_named_property(env, pending, "processPid", pid);
      napi_create_string_utf8(env, error.processStamp.c_str(), NAPI_AUTO_LENGTH, &stamp);
      napi_set_named_property(env, pending, "processStamp", stamp);
      napi_get_boolean(env, false, &unverified);
      napi_set_named_property(env, pending, "treeExitVerified", unverified);
      napi_throw(env, pending);
    }
    return result;
  }
  catch (const nozeli_windows::Failure& error) { return Throw(env,error.code,error.what(),error.windows); }
  catch (const std::exception&) { return Throw(env, "PROCESS_BINDING_ERROR", "Native allocation or runtime failure", 0); }
}
void Text(napi_env env, napi_value object, const char* name, const std::string& value) {
  napi_value text;
  Check(napi_create_string_utf8(env, value.c_str(), value.size(), &text));
  Check(napi_set_named_property(env, object, name, text));
}
void Number(napi_env env, napi_value object, const char* name, DWORD value) {
  napi_value number;
  Check(napi_create_uint32(env, value, &number));
  Check(napi_set_named_property(env, object, name, number));
}
void Boolean(napi_env env, napi_value object, const char* name, bool value) {
  napi_value boolean;
  Check(napi_get_boolean(env, value, &boolean));
  Check(napi_set_named_property(env, object, name, boolean));
}
ULONGLONG Time(const FILETIME& value) {
  return (static_cast<ULONGLONG>(value.dwHighDateTime) << 32) | value.dwLowDateTime;
}
struct ProcessPin {
  HANDLE handle = nullptr;
  DWORD pid = 0;
  ULONGLONG creation = 0;
  std::wstring image;
  bool terminable = false;
  ~ProcessPin() { Close(); }
  void Close() { if (handle) { CloseHandle(handle); handle = nullptr; } }
};
constexpr napi_type_tag pinTag = {0xc2dfb049e61b4241ULL, 0x8acbf984b950f1d7ULL};
ProcessPin* Receiver(napi_env env, napi_callback_info info) {
  napi_value self;
  size_t count = 0;
  Check(napi_get_cb_info(env, info, &count, nullptr, &self, nullptr));
  bool tagged = false;
  // Check the type before unwrapping; another native object's pointer is invalid.
  napi_valuetype type;
  Check(napi_typeof(env, self, &type));
  if (type == napi_object) Check(napi_check_object_type_tag(env, self, &pinTag, &tagged));
  if (!tagged) throw Failure("PROCESS_HANDLE_RECEIVER", "Expected a native process identity handle");
  ProcessPin* pin = nullptr;
  Check(napi_unwrap(env, self, reinterpret_cast<void**>(&pin)));
  return pin;
}
napi_value Close(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    Receiver(env, info)->Close();
    napi_value result;
    Check(napi_get_undefined(env, &result));
    return result;
  });
}
napi_value Snapshot(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    auto* pin = Receiver(env, info);
    if (!pin->handle) throw Failure("PROCESS_HANDLE_CLOSED", "Process identity handle is closed");
    FILETIME creation{}, exit{}, kernel{}, user{};
    if (!GetProcessTimes(pin->handle, &creation, &exit, &kernel, &user))
      throw Failure("PROCESS_QUERY_FAILED", "Cannot query process times", GetLastError());
    if (Time(creation) != pin->creation || GetProcessId(pin->handle) != pin->pid)
      throw Failure("PROCESS_IDENTITY_CHANGED", "Pinned process identity changed");
    // Only the signaled HANDLE proves this process exited. Exit code 259 can
    // also be a real exit code and is never used as a liveness test.
    const DWORD wait = WaitForSingleObject(pin->handle, 0);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT)
      throw Failure("PROCESS_QUERY_FAILED", "Cannot observe process HANDLE state", GetLastError());
    DWORD flags = 0;
    if (!GetHandleInformation(pin->handle, &flags))
      throw Failure("PROCESS_QUERY_FAILED", "Cannot inspect process HANDLE flags", GetLastError());
    napi_value result, image;
    Check(napi_create_object(env, &result));
    Number(env, result, "schema", 1);
    Number(env, result, "pid", pin->pid);
    Text(env, result, "creationTime100ns", std::to_string(pin->creation));
    Text(env, result, "stamp", "win32:" + std::to_string(pin->pid) + ":" + std::to_string(pin->creation));
    Check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(pin->image.data()), pin->image.size(), &image));
    Check(napi_set_named_property(env, result, "imagePath", image));
    Text(env, result, "state", wait == WAIT_OBJECT_0 ? "exited" : "running");
    Boolean(env, result, "inheritable", (flags & HANDLE_FLAG_INHERIT) != 0);
    // Only an explicitly opened termination lease advertises the authority;
    // default query-only snapshots keep their exact historical shape.
    if (pin->terminable) Boolean(env, result, "terminateAllowed", true);
    Boolean(env, result, "treeExitVerified", false);
    Text(env, result, "scope", "single-process-observation-only");
    if (wait == WAIT_OBJECT_0) {
      DWORD code = 0;
      if (!GetExitCodeProcess(pin->handle, &code))
        throw Failure("PROCESS_QUERY_FAILED", "Cannot query exited process code", GetLastError());
      Number(env, result, "exitCode", code);
      // Query again after the wait: the first times query may precede exit.
      if (!GetProcessTimes(pin->handle, &creation, &exit, &kernel, &user))
        throw Failure("PROCESS_QUERY_FAILED", "Cannot query exited process times", GetLastError());
      Text(env, result, "exitTime100ns", std::to_string(Time(exit)));
    }
    return result;
  });
}
napi_value Terminate(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1; napi_value arg;
    Check(napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr));
    auto* pin = Receiver(env, info);
    // An explicitly opened termination lease is the only authority; the
    // default query-only pin keeps refusing here.
    if (!pin->terminable)
      throw Failure("PROCESS_TERMINATE_UNAVAILABLE", "Termination requires an explicitly opened termination lease");
    if (!pin->handle) throw Failure("PROCESS_HANDLE_CLOSED", "Process identity handle is closed");
    napi_valuetype type;
    if (count != 1) throw Failure("PROCESS_EXIT_INVALID", "Expected one exit code");
    Check(napi_typeof(env, arg, &type));
    double code = 0;
    if (type != napi_number) throw Failure("PROCESS_EXIT_INVALID", "Expected a numeric exit code");
    Check(napi_get_value_double(env, arg, &code));
    if (!std::isfinite(code) || code < 0 || code > 4294967295.0 || code != static_cast<DWORD>(code))
      throw Failure("PROCESS_EXIT_INVALID", "Expected a uint32 exit code");
    // Re-verify the exact original incarnation immediately before the call:
    // the retained HANDLE, not a pid lookup, is the termination authority.
    FILETIME creation{}, exit{}, kernel{}, user{};
    if (!GetProcessTimes(pin->handle, &creation, &exit, &kernel, &user))
      throw Failure("PROCESS_QUERY_FAILED", "Cannot query pinned creation time", GetLastError());
    if (Time(creation) != pin->creation || GetProcessId(pin->handle) != pin->pid)
      throw Failure("PROCESS_IDENTITY_CHANGED", "Pinned process identity changed");
    const DWORD wait = WaitForSingleObject(pin->handle, 0);
    if (wait != WAIT_OBJECT_0 && wait != WAIT_TIMEOUT)
      throw Failure("PROCESS_QUERY_FAILED", "Cannot observe process HANDLE state", GetLastError());
    if (wait == WAIT_OBJECT_0)
      throw Failure("PROCESS_ALREADY_EXITED", "Pinned process has already exited");
    if (!TerminateProcess(pin->handle, static_cast<UINT>(code)))
      throw Failure("PROCESS_TERMINATE_FAILED", "Cannot terminate the pinned original process", GetLastError());
    napi_value result;
    Check(napi_get_undefined(env, &result));
    return result;
  });
}
napi_value Open(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 2;
    napi_value args[2];
    Check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
    napi_valuetype type;
    if (count < 1 || count > 2) throw Failure("PROCESS_PID_INVALID", "Expected a process ID and optional options object");
    Check(napi_typeof(env, args[0], &type));
    double value = 0;
    if (type != napi_number) throw Failure("PROCESS_PID_INVALID", "Expected a numeric process ID");
    Check(napi_get_value_double(env, args[0], &value));
    if (!std::isfinite(value) || value < 1 || value > 4294967295.0 || std::floor(value) != value)
      throw Failure("PROCESS_PID_INVALID", "Expected a positive uint32 process ID");
    bool allowTerminate = false;
    if (count == 2 && args[1] != nullptr) {
      napi_valuetype optionsType;
      Check(napi_typeof(env, args[1], &optionsType));
      if (optionsType == napi_object) {
        napi_value flag;
        if (napi_get_named_property(env, args[1], "allowTerminate", &flag) == napi_ok && flag != nullptr) {
          napi_valuetype flagType;
          Check(napi_typeof(env, flag, &flagType));
          if (flagType != napi_boolean) throw Failure("PROCESS_PID_INVALID", "allowTerminate must be a boolean");
          Check(napi_get_value_bool(env, flag, &allowTerminate));
        }
      } else if (optionsType != napi_undefined && optionsType != napi_null)
        throw Failure("PROCESS_PID_INVALID", "Expected an options object");
    }
    auto pin = std::make_unique<ProcessPin>();
    pin->pid = static_cast<DWORD>(value);
    pin->terminable = allowTerminate;
    // No termination right unless explicitly requested; no write/duplicate
    // rights, privilege changes or inheritance either way.
    pin->handle = OpenProcess(
      PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | (allowTerminate ? PROCESS_TERMINATE : 0),
      FALSE, pin->pid);
    if (!pin->handle) throw Failure("PROCESS_OPEN_UNVERIFIED", "Cannot open process identity; no absence or tree-exit verdict", GetLastError());
    FILETIME creation{}, exit{}, kernel{}, user{};
    if (!GetProcessTimes(pin->handle, &creation, &exit, &kernel, &user))
      throw Failure("PROCESS_QUERY_FAILED", "Cannot query pinned creation time", GetLastError());
    pin->creation = Time(creation);
    std::vector<wchar_t> image(32768);
    DWORD size = static_cast<DWORD>(image.size());
    if (!QueryFullProcessImageNameW(pin->handle, 0, image.data(), &size))
      throw Failure("PROCESS_QUERY_FAILED", "Cannot query pinned image path", GetLastError());
    pin->image.assign(image.data(), size);
    napi_value result;
    Check(napi_create_object(env, &result));
    Check(napi_type_tag_object(env, result, &pinTag));
    napi_property_descriptor methods[] = {
      {"snapshot", nullptr, Snapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"terminate", nullptr, Terminate, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, Close, nullptr, nullptr, nullptr, napi_default, nullptr}
    };
    Check(napi_define_properties(env, result, 3, methods));
    Check(napi_wrap(env, result, pin.get(), [](napi_env, void* data, void*) { delete static_cast<ProcessPin*>(data); }, nullptr, nullptr));
    pin.release();
    return result;
  });
}
#include "process-job.inc"
#include "process-conpty.inc"
#include "process-launch-set.inc"
#include "process-supervision.inc"
#include "process-force-quit.inc"
napi_value DecodeAnsi(napi_env env, napi_callback_info info) {
  return Guard(env, [&] {
    size_t count = 1, size = 0;
    napi_value arg, result;
    void* data = nullptr;
    Check(napi_get_cb_info(env, info, &count, &arg, nullptr, nullptr));
    if (count != 1) throw Failure("PROCESS_ENCODING_INPUT", "Expected tool output bytes");
    Check(napi_get_buffer_info(env, arg, &data, &size));
    if (size > 512 * 1024) throw Failure("PROCESS_ENCODING_INPUT", "Tool output exceeds decoding bound");
    const auto* bytes = static_cast<const char*>(data);
    const int length = size ? MultiByteToWideChar(CP_ACP, MB_ERR_INVALID_CHARS, bytes, static_cast<int>(size), nullptr, 0) : 0;
    if (size && !length) { Check(napi_get_null(env, &result)); return result; }
    std::wstring text(length, L'\0');
    if (length && MultiByteToWideChar(CP_ACP, MB_ERR_INVALID_CHARS, bytes, static_cast<int>(size), text.data(), length) != length) {
      Check(napi_get_null(env, &result)); return result;
    }
    Check(napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(text.data()), text.size(), &result));
    return result;
  });
}
} // namespace
NAPI_MODULE_INIT() {
  return Guard(env, [&] {
    napi_value open;
    Check(napi_create_function(env, "openProcessIdentity", NAPI_AUTO_LENGTH, Open, nullptr, &open));
    Check(napi_set_named_property(env, exports, "openProcessIdentity", open));
    napi_value decoder;
    Check(napi_create_function(env, "decodeAnsi", NAPI_AUTO_LENGTH, DecodeAnsi, nullptr, &decoder));
    Check(napi_set_named_property(env, exports, "decodeAnsi", decoder));
    InitProcessJobBindings(env, exports);
    InitSupervisorBindings(env, exports);
    InitProjectConptyBindings(env, exports);
    InitForceQuitBindings(env, exports);
    napi_value launchSet;Check(napi_create_function(env,"createHostLaunchSet",NAPI_AUTO_LENGTH,CreateLaunchSet,nullptr,&launchSet));
    Check(napi_set_named_property(env,exports,"createHostLaunchSet",launchSet));
    return exports;
  });
}
