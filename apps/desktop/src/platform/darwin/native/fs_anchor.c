// macOS native anchoring helper for the nozeli.platform.filesystem/1 contract
// (platform/darwin/filesystem.mjs). Node has no openat surface, and macOS has
// no /proc fd namespace, so the component-wise O_NOFOLLOW anchoring is done
// here against directory descriptors:
//   - every directory component is opened openat(dirfd, name, O_NOFOLLOW|...)
//     and must fstat as a directory, so a swapped or symlinked component can
//     never redirect resolution outside the pinned tree;
//   - every write operation (mkdir/exclusive create/rename/unlink/clone) is
//     single-component relative to a pinned directory fd;
//   - file copies use clonefileat(src, AT_FDCWD, dirfd, name) so the cloned
//     entry lands inside the pinned directory without any destination path
//     re-resolution, with an fd-to-fd fcopyfile fallback for filesystems
//     without cloning.
// This helper is mechanics only: path rules, budgets and error policy live in
// the JS adapter and the policy layer. Build: node build.mjs (see build.mjs).
#include <node_api.h>
#include <copyfile.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/clonefile.h>
#include <sys/param.h>
#include <sys/stat.h>
#include <stdbool.h>
#include <unistd.h>

#define DIR_OPEN_FLAGS (O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)

// ── error plumbing: every syscall failure becomes a JS Error with the Node
// style errno name in `code` and the raw errno in `errno`. ──────────────────
static const struct { int no; const char *name; } ERRNO_NAMES[] = {
  {ENOENT, "ENOENT"},       {EACCES, "EACCES"},       {EEXIST, "EEXIST"},
  {ENOTDIR, "ENOTDIR"},     {EISDIR, "EISDIR"},       {ELOOP, "ELOOP"},
  {ENOTEMPTY, "ENOTEMPTY"}, {EINVAL, "EINVAL"},       {EPERM, "EPERM"},
  {EXDEV, "EXDEV"},         {ENOSPC, "ENOSPC"},       {EROFS, "EROFS"},
  {EBADF, "EBADF"},         {EMFILE, "EMFILE"},       {ENFILE, "ENFILE"},
  {ENAMETOOLONG, "ENAMETOOLONG"}, {EIO, "EIO"},       {ENOSYS, "ENOSYS"},
  {ENOTSUP, "ENOTSUP"},     {EOPNOTSUPP, "EOPNOTSUPP"}, {ENOTTY, "ENOTTY"},
  {EINTR, "EINTR"},         {EFBIG, "EFBIG"},         {EMLINK, "EMLINK"},
  {EOVERFLOW, "EOVERFLOW"}, {EDQUOT, "EDQUOT"},
};

static const char *errno_name(int no) {
  for (unsigned i = 0; i < sizeof ERRNO_NAMES / sizeof ERRNO_NAMES[0]; i++)
    if (ERRNO_NAMES[i].no == no) return ERRNO_NAMES[i].name;
  return "EUNKNOWN";
}

static void throw_errno(napi_env env, int no) {
  napi_value code, msg, error, num;
  char text[256];
  if (napi_create_string_utf8(env, errno_name(no), NAPI_AUTO_LENGTH, &code) != napi_ok) return;
  snprintf(text, sizeof text, "native anchored fs call failed: %s (%d)", strerror(no), no);
  if (napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &msg) != napi_ok) return;
  if (napi_create_error(env, code, msg, &error) != napi_ok) return;
  if (napi_create_int32(env, no, &num) == napi_ok)
    napi_set_named_property(env, error, "errno", num);
  napi_throw(env, error);
}

#define REQUIRE(cond) do { if (!(cond)) { napi_throw_type_error(env, NULL, "fs_anchor: invalid arguments"); return NULL; } } while (0)

static char *arg_string(napi_env env, napi_callback_info info, size_t arg) {
  size_t argc = arg + 1;
  napi_value argv[8];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc <= arg) return NULL;
  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv[arg], NULL, 0, &len) != napi_ok) return NULL;
  char *out = malloc(len + 1);
  if (!out) return NULL;
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, argv[arg], out, len + 1, &copied) != napi_ok) { free(out); return NULL; }
  return out;
}

static int arg_int32(napi_env env, napi_callback_info info, size_t arg, int32_t *out) {
  size_t argc = arg + 1;
  napi_value argv[8];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc <= arg) return 0;
  return napi_get_value_int32(env, argv[arg], out) == napi_ok;
}

static int arg_buffer(napi_env env, napi_callback_info info, size_t arg, void **data, size_t *len) {
  size_t argc = arg + 1;
  napi_value argv[8];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc <= arg) return 0;
  return napi_get_buffer_info(env, argv[arg], data, len) == napi_ok;
}

// Optional flag arguments accept numbers or booleans so a JS literal of
// either type cannot silently coerce to 0.
static int arg_flag(napi_env env, napi_callback_info info, size_t arg, int32_t *out) {
  size_t argc = arg + 1;
  napi_value argv[8];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc <= arg) return 0;
  if (napi_get_value_int32(env, argv[arg], out) == napi_ok) return 1;
  bool flag = false;
  if (napi_get_value_bool(env, argv[arg], &flag) == napi_ok) { *out = flag ? 1 : 0; return 1; }
  return 0;
}

// ── stat plumbing: mirrors the identity facts the contract verifies ─────────
static napi_value stat_to_js(napi_env env, const struct stat *st) {
  napi_value object, value;
  if (napi_create_object(env, &object) != napi_ok) return NULL;
  struct { const char *name; unsigned long long v; } fields[] = {
    {"dev", (unsigned long long)st->st_dev},
    {"ino", (unsigned long long)st->st_ino},
    {"size", (unsigned long long)st->st_size},
    {"nlink", (unsigned long long)st->st_nlink},
  };
  for (unsigned i = 0; i < sizeof fields / sizeof fields[0]; i++) {
    if (napi_create_bigint_uint64(env, fields[i].v, &value) != napi_ok) return NULL;
    napi_set_named_property(env, object, fields[i].name, value);
  }
  if (napi_create_uint32(env, (uint32_t)st->st_mode, &value) != napi_ok) return NULL;
  napi_set_named_property(env, object, "mode", value);
  const char *names[3] = {"atimeNs", "mtimeNs", "ctimeNs"};
  struct { time_t sec; long nsec; } raw[3] = {
    {st->st_atimespec.tv_sec, st->st_atimespec.tv_nsec},
    {st->st_mtimespec.tv_sec, st->st_mtimespec.tv_nsec},
    {st->st_ctimespec.tv_sec, st->st_ctimespec.tv_nsec},
  };
  for (unsigned i = 0; i < 3; i++) {
    long long ns = (long long)raw[i].sec * 1000000000LL + raw[i].nsec;
    if (napi_create_bigint_int64(env, ns, &value) != napi_ok) return NULL;
    napi_set_named_property(env, object, names[i], value);
  }
  return object;
}

// ── open helpers: O_NOFOLLOW everywhere, directories confirmed by fstat ─────
static int open_directory(int dirfd, const char *name) {
  int fd = openat(dirfd, name, DIR_OPEN_FLAGS);
  if (fd < 0) return -1;
  struct stat st;
  if (fstat(fd, &st) == 0 && S_ISDIR(st.st_mode)) return fd;
  int saved = errno;          // fstat failure, or 0 when simply not a directory
  close(fd);
  errno = saved ? saved : ENOTDIR;
  return -1;
}

static napi_value fn_open_root(napi_env env, napi_callback_info info) {
  char *path = arg_string(env, info, 0);
  REQUIRE(path);
  int fd = open(path, DIR_OPEN_FLAGS);
  if (fd >= 0) {
    struct stat st;
    if (fstat(fd, &st) == 0 && S_ISDIR(st.st_mode)) {
      free(path);
      napi_value result;
      if (napi_create_int32(env, fd, &result) != napi_ok) return NULL;
      return result;
    }
    int saved = errno;
    close(fd);
    errno = saved ? saved : ENOTDIR;
    fd = -1;
  }
  int saved = errno;
  free(path);
  errno = saved;
  throw_errno(env, saved);
  return NULL;
}

static napi_value fn_open_dir_at(napi_env env, napi_callback_info info) {
  int32_t dirfd;
  char *name = NULL;
  REQUIRE(arg_int32(env, info, 0, &dirfd) && (name = arg_string(env, info, 1)) != NULL);
  int fd = open_directory(dirfd, name);
  int saved = errno;
  free(name);
  if (fd < 0) { errno = saved; throw_errno(env, saved); return NULL; }
  napi_value result;
  if (napi_create_int32(env, fd, &result) != napi_ok) return NULL;
  return result;
}

static napi_value fn_open_entry_at(napi_env env, napi_callback_info info) {
  int32_t dirfd, nonblock = 0;
  char *name = NULL;
  REQUIRE(arg_int32(env, info, 0, &dirfd) && (name = arg_string(env, info, 1)) != NULL);
  arg_flag(env, info, 2, &nonblock);
  int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | (nonblock ? O_NONBLOCK : 0);
  int fd = openat(dirfd, name, flags);
  int saved = errno;
  free(name);
  if (fd < 0) { errno = saved; throw_errno(env, saved); return NULL; }
  napi_value result;
  if (napi_create_int32(env, fd, &result) != napi_ok) return NULL;
  return result;
}

// ── stat family ─────────────────────────────────────────────────────────────
static napi_value fn_fstat_entry(napi_env env, napi_callback_info info) {
  int32_t fd;
  REQUIRE(arg_int32(env, info, 0, &fd));
  struct stat st;
  if (fstat(fd, &st) != 0) { throw_errno(env, errno); return NULL; }
  return stat_to_js(env, &st);
}

static napi_value fn_lstat_at(napi_env env, napi_callback_info info) {
  int32_t dirfd;
  char *name = NULL;
  REQUIRE(arg_int32(env, info, 0, &dirfd) && (name = arg_string(env, info, 1)) != NULL);
  struct stat st;
  int rc = fstatat(dirfd, name, &st, AT_SYMLINK_NOFOLLOW);
  int saved = errno;
  free(name);
  if (rc != 0) { errno = saved; throw_errno(env, saved); return NULL; }
  return stat_to_js(env, &st);
}

static napi_value fn_lstat_path(napi_env env, napi_callback_info info) {
  char *path = arg_string(env, info, 0);
  REQUIRE(path);
  struct stat st;
  int rc = lstat(path, &st);
  int saved = errno;
  free(path);
  if (rc != 0) { errno = saved; throw_errno(env, saved); return NULL; }
  return stat_to_js(env, &st);
}

// ── writes inside a pinned directory ────────────────────────────────────────
static napi_value fn_mkdir_at(napi_env env, napi_callback_info info) {
  int32_t dirfd, mode;
  char *name = NULL;
  REQUIRE(arg_int32(env, info, 0, &dirfd) && (name = arg_string(env, info, 1)) != NULL && arg_int32(env, info, 2, &mode));
  int rc = mkdirat(dirfd, name, (mode_t)mode);
  int saved = errno;
  free(name);
  if (rc != 0) { errno = saved; throw_errno(env, saved); }
  return NULL;
}

static napi_value fn_fchmod_at(napi_env env, napi_callback_info info) {
  int32_t dirfd, mode;
  char *name = NULL;
  REQUIRE(arg_int32(env, info, 0, &dirfd) && (name = arg_string(env, info, 1)) != NULL && arg_int32(env, info, 2, &mode));
  int rc = fchmodat(dirfd, name, (mode_t)mode, 0);
  int saved = errno;
  free(name);
  if (rc != 0) { errno = saved; throw_errno(env, saved); }
  return NULL;
}

// Mode change on a pinned open descriptor: fchmod acts on the fd itself, so
// a concurrent directory-entry swap can never redirect the permission change
// onto a different inode (fchmodat would re-resolve the name).
static napi_value fn_fchmod_fd(napi_env env, napi_callback_info info) {
  int32_t fd, mode;
  REQUIRE(arg_int32(env, info, 0, &fd) && arg_int32(env, info, 1, &mode));
  int rc;
  do { rc = fchmod(fd, (mode_t)mode); } while (rc != 0 && errno == EINTR);
  if (rc != 0) { throw_errno(env, errno); }
  return NULL;
}

static int write_all_fd(int fd, const void *data, size_t len) {
  const char *cursor = data;
  while (len > 0) {
    ssize_t written = write(fd, cursor, len);
    if (written < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    cursor += written;
    len -= (size_t)written;
  }
  return 0;
}

static napi_value fn_open_exclusive_at(napi_env env, napi_callback_info info) {
  int32_t dirfd, mode;
  char *name = NULL;
  REQUIRE(arg_int32(env, info, 0, &dirfd) && (name = arg_string(env, info, 1)) != NULL && arg_int32(env, info, 2, &mode));
  int fd = openat(dirfd, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, (mode_t)mode);
  int saved = errno;
  free(name);
  if (fd < 0) { errno = saved; throw_errno(env, saved); return NULL; }
  napi_value result;
  if (napi_create_int32(env, fd, &result) != napi_ok) return NULL;
  return result;
}

static napi_value fn_write_all(napi_env env, napi_callback_info info) {
  int32_t fd;
  void *data = NULL;
  size_t len = 0;
  REQUIRE(arg_int32(env, info, 0, &fd) && arg_buffer(env, info, 1, &data, &len));
  if (write_all_fd(fd, data, len) != 0) { throw_errno(env, errno); return NULL; }
  return NULL;
}

static napi_value fn_write_exclusive_at(napi_env env, napi_callback_info info) {
  int32_t dirfd, mode;
  char *name = NULL;
  void *data = NULL;
  size_t len = 0;
  REQUIRE(arg_int32(env, info, 0, &dirfd) && (name = arg_string(env, info, 1)) != NULL
    && arg_buffer(env, info, 2, &data, &len) && arg_int32(env, info, 3, &mode));
  int fd = openat(dirfd, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, (mode_t)mode);
  if (fd < 0) {
    int saved = errno;
    free(name);
    errno = saved;
    throw_errno(env, saved);
    return NULL;
  }
  int failure = write_all_fd(fd, data, len) != 0 ? errno : 0;
  if (close(fd) != 0 && !failure) failure = errno;
  free(name);
  if (failure) { errno = failure; throw_errno(env, failure); }
  return NULL;
}

// Apple's fsync only flushes to the drive cache; F_FULLFSYNC is the real
// barrier (same primitive the durable-persistence helper uses). A filesystem
// that rejects it fails the call: no silent downgrade to the weaker fsync —
// the durability boundary stays explicit and the error propagates to JS.
static napi_value fn_fsync_fd(napi_env env, napi_callback_info info) {
  int32_t fd;
  REQUIRE(arg_int32(env, info, 0, &fd));
  int rc;
  do { rc = fcntl(fd, F_FULLFSYNC); } while (rc != 0 && errno == EINTR);
  if (rc != 0) { throw_errno(env, errno); return NULL; }
  return NULL;
}

static napi_value fn_rename_at(napi_env env, napi_callback_info info) {
  int32_t fromDirfd, toDirfd;
  char *fromName = NULL, *toName = NULL;
  REQUIRE(arg_int32(env, info, 0, &fromDirfd) && (fromName = arg_string(env, info, 1)) != NULL
    && arg_int32(env, info, 2, &toDirfd) && (toName = arg_string(env, info, 3)) != NULL);
  int rc = renameat(fromDirfd, fromName, toDirfd, toName);
  int saved = errno;
  free(fromName);
  free(toName);
  if (rc != 0) { errno = saved; throw_errno(env, saved); }
  return NULL;
}

// ── removal: recursive, descriptor-anchored, never following symlinks ───────
static int remove_tree(int dirfd, const char *name) {
  struct stat st;
  if (fstatat(dirfd, name, &st, AT_SYMLINK_NOFOLLOW) != 0) return -1;
  if (!S_ISDIR(st.st_mode)) {
    int rc;
    do { rc = unlinkat(dirfd, name, 0); } while (rc != 0 && errno == EINTR);
    return rc;
  }
  int subfd = openat(dirfd, name, DIR_OPEN_FLAGS);
  if (subfd < 0) return -1;
  int dupfd = dup(subfd);
  if (dupfd < 0) {
    int saved = errno;
    close(subfd);
    errno = saved;
    return -1;
  }
  DIR *dir = fdopendir(dupfd);
  if (!dir) {
    int saved = errno;
    close(dupfd);
    close(subfd);
    errno = saved;
    return -1;
  }
  struct dirent *entry;
  int failure = 0;
  while (!failure && (entry = readdir(dir)) != NULL) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    char *child = strdup(entry->d_name);
    if (!child) { failure = ENOMEM; break; }
    if (remove_tree(subfd, child) != 0) failure = errno;
    free(child);
  }
  closedir(dir);   // owns dupfd
  if (failure) { close(subfd); errno = failure; return -1; }
  errno = 0;
  int rc = unlinkat(dirfd, name, AT_REMOVEDIR);
  int saved = errno;
  close(subfd);
  errno = rc != 0 && saved == 0 ? EIO : saved;
  return rc;
}

static napi_value fn_remove_at(napi_env env, napi_callback_info info) {
  int32_t dirfd, force = 0;
  char *name = NULL;
  REQUIRE(arg_int32(env, info, 0, &dirfd) && (name = arg_string(env, info, 1)) != NULL);
  arg_flag(env, info, 2, &force);
  errno = 0;
  int rc = remove_tree(dirfd, name);
  int saved = errno;
  free(name);
  if (rc != 0) {
    if (force && (saved == ENOENT || saved == 0)) return NULL;
    throw_errno(env, saved ? saved : EIO);
  }
  return NULL;
}

static napi_value fn_rmdir_at(napi_env env, napi_callback_info info) {
  int32_t dirfd;
  char *name = NULL;
  REQUIRE(arg_int32(env, info, 0, &dirfd) && (name = arg_string(env, info, 1)) != NULL);
  int rc;
  do { rc = unlinkat(dirfd, name, AT_REMOVEDIR); } while (rc != 0 && errno == EINTR);
  int saved = errno;
  free(name);
  if (rc != 0) { errno = saved; throw_errno(env, saved); }
  return NULL;
}

// ── reads ───────────────────────────────────────────────────────────────────
static napi_value fn_readdir_at(napi_env env, napi_callback_info info) {
  int32_t fd;
  REQUIRE(arg_int32(env, info, 0, &fd));
  int dupfd = dup(fd);
  if (dupfd < 0) { throw_errno(env, errno); return NULL; }
  DIR *dir = fdopendir(dupfd);
  if (!dir) {
    int saved = errno;
    close(dupfd);
    errno = saved;
    throw_errno(env, saved);
    return NULL;
  }
  napi_value array;
  if (napi_create_array(env, &array) != napi_ok) { closedir(dir); return NULL; }
  struct dirent *entry;
  uint32_t count = 0;
  int failure = 0;
  while (!failure && (entry = readdir(dir)) != NULL) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    napi_value name;
    if (napi_create_string_utf8(env, entry->d_name, NAPI_AUTO_LENGTH, &name) == napi_ok
      && napi_set_element(env, array, count, name) == napi_ok) {
      count++;
      continue;
    }
    failure = 1;
  }
  closedir(dir);
  if (failure) { napi_throw_error(env, NULL, "fs_anchor: readdir conversion failed"); return NULL; }
  return array;
}

static napi_value fn_read_all(napi_env env, napi_callback_info info) {
  int32_t fd;
  REQUIRE(arg_int32(env, info, 0, &fd));
  struct stat st;
  if (fstat(fd, &st) != 0) { throw_errno(env, errno); return NULL; }
  size_t cap = st.st_size > 0 ? (size_t)st.st_size : 65536;
  unsigned char *data = malloc(cap);
  if (!data) { napi_throw_error(env, NULL, "fs_anchor: out of memory"); return NULL; }
  size_t have = 0;
  for (;;) {
    if (have == cap) {
      cap *= 2;
      unsigned char *grown = realloc(data, cap);
      if (!grown) { free(data); napi_throw_error(env, NULL, "fs_anchor: out of memory"); return NULL; }
      data = grown;
    }
    ssize_t got = pread(fd, data + have, cap - have, (off_t)have);
    if (got < 0) {
      if (errno == EINTR) continue;
      int saved = errno;
      free(data);
      errno = saved;
      throw_errno(env, saved);
      return NULL;
    }
    if (got == 0) break;
    have += (size_t)got;
  }
  napi_value result;
  napi_status status = napi_create_buffer_copy(env, have, data, NULL, &result);
  free(data);
  if (status != napi_ok) { napi_throw_error(env, NULL, "fs_anchor: buffer creation failed"); return NULL; }
  return result;
}

// ── misc ────────────────────────────────────────────────────────────────────
static napi_value fn_close_fd(napi_env env, napi_callback_info info) {
  int32_t fd;
  REQUIRE(arg_int32(env, info, 0, &fd));
  if (close(fd) != 0 && errno != EBADF) { throw_errno(env, errno); return NULL; }
  return NULL;
}

static napi_value fn_getpath_fd(napi_env env, napi_callback_info info) {
  int32_t fd;
  REQUIRE(arg_int32(env, info, 0, &fd));
  char buffer[MAXPATHLEN];
  if (fcntl(fd, F_GETPATH, buffer) != 0) { throw_errno(env, errno); return NULL; }
  napi_value result;
  if (napi_create_string_utf8(env, buffer, NAPI_AUTO_LENGTH, &result) != napi_ok) return NULL;
  return result;
}

// Clone the regular file at srcPath into (dirfd, name) on the pinned directory
// descriptor. clonefileat needs no destination path resolution, so a concurrent
// directory swap cannot redirect the copy. Filesystems without clone support
// fall back to fd-to-fd fcopyfile with the source mode applied, matching
// fs.copyFile's FICLONE-then-copy behavior.
static napi_value fn_copy_file_into(napi_env env, napi_callback_info info) {
  int32_t dirfd;
  char *name = NULL, *src = NULL;
  REQUIRE(arg_int32(env, info, 0, &dirfd) && (name = arg_string(env, info, 1)) != NULL
    && (src = arg_string(env, info, 2)) != NULL);
  errno = 0;
  if (clonefileat(AT_FDCWD, src, dirfd, name, 0) == 0) {
    free(name);
    free(src);
    return NULL;
  }
  int clone_errno = errno;
  int fallback_codes[] = {EINVAL, ENOTSUP, EOPNOTSUPP, ENOSYS, EPERM, EXDEV, ENOTTY, EROFS};
  int recoverable = 0;
  for (unsigned i = 0; i < sizeof fallback_codes / sizeof fallback_codes[0]; i++)
    if (clone_errno == fallback_codes[i]) recoverable = 1;
  if (!recoverable) {
    free(name);
    free(src);
    throw_errno(env, clone_errno);
    return NULL;
  }
  int srcfd = open(src, O_RDONLY | O_CLOEXEC);
  if (srcfd < 0) {
    int saved = errno;
    free(name);
    free(src);
    throw_errno(env, saved);
    return NULL;
  }
  struct stat st;
  if (fstat(srcfd, &st) != 0 || !S_ISREG(st.st_mode)) {
    int saved = fstat(srcfd, &st) != 0 ? errno : EINVAL;
    close(srcfd);
    free(name);
    free(src);
    throw_errno(env, saved);
    return NULL;
  }
  int dstfd = openat(dirfd, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (dstfd < 0) {
    int saved = errno;
    close(srcfd);
    free(name);
    free(src);
    throw_errno(env, saved);
    return NULL;
  }
  copyfile_state_t state = copyfile_state_alloc();
  int failure = 0;
  if (!state) failure = ENOMEM;
  if (!failure && fcopyfile(srcfd, dstfd, state, COPYFILE_DATA) != 0) failure = errno;
  if (state) copyfile_state_free(state);
  if (!failure && fchmod(dstfd, st.st_mode & 07777) != 0) failure = errno;
  if (close(dstfd) != 0 && !failure) failure = errno;
  close(srcfd);
  free(name);
  free(src);
  if (failure) throw_errno(env, failure);
  return NULL;
}

NAPI_MODULE_INIT() {
  const struct { const char *name; napi_callback callback; } EXPORTS[] = {
    {"openRoot", fn_open_root},
    {"openDirAt", fn_open_dir_at},
    {"openEntryAt", fn_open_entry_at},
    {"fstatEntry", fn_fstat_entry},
    {"lstatAt", fn_lstat_at},
    {"lstatPath", fn_lstat_path},
    {"mkdirAt", fn_mkdir_at},
    {"fchmodAt", fn_fchmod_at},
    {"fchmodFd", fn_fchmod_fd},
    {"openExclusiveAt", fn_open_exclusive_at},
    {"writeAll", fn_write_all},
    {"writeExclusiveAt", fn_write_exclusive_at},
    {"fsyncFd", fn_fsync_fd},
    {"renameAt", fn_rename_at},
    {"removeAt", fn_remove_at},
    {"rmdirAt", fn_rmdir_at},
    {"readdirAt", fn_readdir_at},
    {"readAll", fn_read_all},
    {"closeFd", fn_close_fd},
    {"getpathFd", fn_getpath_fd},
    {"copyFileInto", fn_copy_file_into},
  };
  for (unsigned i = 0; i < sizeof EXPORTS / sizeof EXPORTS[0]; i++) {
    napi_value function;
    if (napi_create_function(env, EXPORTS[i].name, NAPI_AUTO_LENGTH, EXPORTS[i].callback, NULL, &function) != napi_ok)
      return NULL;
    if (napi_set_named_property(env, exports, EXPORTS[i].name, function) != napi_ok)
      return NULL;
  }
  return NULL;
}
