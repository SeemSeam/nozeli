// nozeli macOS durability primitive: fcntl(fd, F_FULLFSYNC).
//
// Apple's fsync(2) flushes the kernel page cache to the drive but explicitly
// does NOT force the drive's own (possibly volatile) write cache to permanent
// storage; the man page points callers that need that guarantee at
// fcntl(fd, F_FULLFSYNC). Node's fs.promises FileHandle.sync() is plain
// fsync(), so this module is the only honest file/directory durability
// barrier on macOS — the same fcntl runs on directory descriptors to make a
// completed rename survive power loss.
//
// ABI: plain N-API (no V8/NAN), so one build serves both the pinned Node 24
// runtime and Electron 44; no Electron rebuild is needed. Build it from
// apps/desktop/src/platform/darwin/native with:
//   ../../../../node_modules/.bin/node-gyp configure build
#include <node_api.h>
#include <fcntl.h>
#include <errno.h>
#include <string.h>
#include <stdio.h>

#ifndef F_FULLFSYNC
#error "nozeli-fullsync is macOS-only: F_FULLFSYNC is not defined on this platform"
#endif

static void throw_errno(napi_env env, const char *code, int err, const char *prefix) {
  char message[192];
  napi_value code_value, message_value, error, errno_value;
  snprintf(message, sizeof(message), "%s: %s", prefix, strerror(err));
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok ||
      napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value) != napi_ok ||
      napi_create_error(env, code_value, message_value, &error) != napi_ok) {
    napi_throw_error(env, code, message);
    return;
  }
  if (napi_create_int32(env, err, &errno_value) == napi_ok)
    napi_set_named_property(env, error, "errno", errno_value);
  napi_throw(env, error);
}

// fullSync(fd) -> undefined. Throws FULLFSYNC_FAILED with .errno when the
// kernel refuses the barrier; it never pretends a refused barrier succeeded.
static napi_value FullSync(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1], undefined;
  napi_valuetype type;
  int32_t fd;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc < 1 ||
      napi_typeof(env, args[0], &type) != napi_ok || type != napi_number ||
      napi_get_value_int32(env, args[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, "FULLFSYNC_BAD_ARGUMENT",
                          "fullSync(fd) expects one non-negative integer file descriptor");
    return NULL;
  }
  if (fcntl(fd, F_FULLFSYNC) == -1) {
    throw_errno(env, "FULLFSYNC_FAILED", errno, "fcntl(fd, F_FULLFSYNC) failed");
    return NULL;
  }
  if (napi_get_undefined(env, &undefined) != napi_ok) return NULL;
  return undefined;
}

NAPI_MODULE_INIT() {
  napi_value full_sync;
  if (napi_create_function(env, "fullSync", NAPI_AUTO_LENGTH, FullSync, NULL, &full_sync) != napi_ok)
    return NULL;
  if (napi_set_named_property(env, exports, "fullSync", full_sync) != napi_ok) return NULL;
  return exports;
}
