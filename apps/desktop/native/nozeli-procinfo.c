// nozeli-procinfo — Darwin process-facts helper for the verified process
// ownership capability (platform/darwin/process-ownership.mjs).
//
// The macOS kernel exposes no /proc; every fact this tool prints comes from
// public, unprivileged interfaces and is emitted as strict NDJSON (one JSON
// object per line, ASCII-escaped strings) on stdout:
//
//   nozeli-procinfo boot
//       {"bootSec":1793853020,"bootUsec":540627}
//         sysctl CTL_KERN KERN_BOOTTIME — the boot instant. The adapter binds
//         every identity stamp to this value (encoded UUID-shaped) so a stamp
//         can never outlive the boot that created it.
//
//   nozeli-procinfo info <pid>
//       {"pid":4533,"ppid":3912,"pgid":4533,"euid":501,"ruid":501,
//        "status":3,"startSec":1793871076,"startUsec":993583}
//       {"pid":123,"gone":true}            — no such process
//         sysctl CTL_KERN KERN_PROC_PID (kinfo_proc). Facts for ANY process
//         on the system, like /proc/<pid>/stat on Linux. `status` is the
//         kernel p_stat value (5 = SZOMB, i.e. already exited).
//
//   nozeli-procinfo stamps <pid> [pid...]
//       one {"pid":n,"status":s,"startSec":..,"startUsec":..} or
//       {"pid":n,"gone":true} per pid — batched incarnation re-checks used
//       between a table scan and signalling so only verified incarnations
//       are ever signalled.
//
//   nozeli-procinfo argsenv <pid>
//       {"pid":n,"argv":["..."],"env":["..."]}   — KERN_PROCARGS2
//       {"pid":n,"denied":true}  — env/args withheld (protected process) or
//                                  sysctl EPERM: identity is NOT provable
//       {"pid":n,"gone":true}
//         The argument/environment block of the process as captured at exec.
//         Layout after the argc int32: exec path string, argc argv strings,
//         NUL padding, then environment strings until the buffer end.
//
//   nozeli-procinfo path <pid>
//       {"pid":n,"path":"/abs/exe"} | {"pid":n,"denied":true} | {"pid":n,"gone":true}
//         proc_pidpath — the executable backing the process.
//
//   nozeli-procinfo session <pid>
//       {"pid":n,"sid":12537} | {"pid":n,"gone":true}
//       {"pid":n,"denied":true} | {"pid":n,"unstable":true}
//         getsid(2) bracketed by two kinfo snapshots; a start-time change
//         between them means the pid was recycled mid-query and the answer
//         is discarded (unstable) instead of attributed to the old process.
//
//   nozeli-procinfo fds <pid>
//       one {"pid":n,"fd":11,"path":"/abs/file","dev":16777231,"ino":463915}
//       per open vnode descriptor (PROC_PIDLISTFDS + PROC_PIDFDVNODEPATHINFO);
//       {"pid":n,"denied":true} | {"pid":n,"gone":true} on failure.
//         dev/ino identify the exact inode behind the descriptor so callers
//         can re-verify the handle after acting on it.
//
//   nozeli-procinfo scan [--sessions] [--argv] [--paths]
//       one facts object per process on the system (sysctl CTL_KERN
//       KERN_PROC_ALL — the whole table, like readdir('/proc')):
//         {"pid":n,"ppid":..,"pgid":..,"euid":..,"ruid":..,"status":..,
//          "startSec":..,"startUsec":..}
//       plus, for same-uid non-zombie processes, the PROCARGS2 block inline:
//         ,"env":["..."]            (or "envDenied":true)
//       --sessions adds ,"sid":.. (getsid with the double snapshot check)
//       --argv    adds ,"argv":[...]
//
//   nozeli-procinfo selfcheck
//       prints {"ok":true,...} after exercising boot/info/argsenv/path on the
//       current process; non-zero exit if any core fact source is unusable.
//
// Exit codes: 0 = facts emitted (per-pid gone/denied are facts, not errors),
// 1 = usage error, 2 = a required kernel interface failed globally.
//
// Every string is JSON-escaped with a UTF-8 validator: valid sequences pass
// through untouched; invalid bytes become \ufffd. ASCII payloads (the env-tag
// proofs) round-trip byte-exact. Built by tools/build-darwin-procinfo.mjs.
#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <unistd.h>

// ---------------------------------------------------------------- output ---

static char *out_buf = NULL;
static size_t out_len = 0, out_cap = 0;

static void out_reserve(size_t extra) {
  if (out_len + extra + 1 <= out_cap) return;
  size_t cap = out_cap ? out_cap : 4096;
  while (cap < out_len + extra + 1) cap *= 2;
  out_buf = realloc(out_buf, cap);
  if (!out_buf) { fprintf(stderr, "nozeli-procinfo: out of memory\n"); exit(2); }
  out_cap = cap;
}

static void out_raw(const char *s, size_t n) { out_reserve(n); memcpy(out_buf + out_len, s, n); out_len += n; }

static void out_lit(const char *s) { out_raw(s, strlen(s)); }

static void out_u64(uint64_t v) {
  char tmp[32];
  int n = snprintf(tmp, sizeof tmp, "%" PRIu64, v);
  if (n > 0) out_raw(tmp, (size_t)n);
}

// JSON string with UTF-8 validation; invalid bytes become U+FFFD escapes so
// the emitted line is always parseable while ASCII content stays exact.
static void out_str(const char *s, size_t n) {
  out_lit("\"");
  size_t i = 0;
  while (i < n) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"') { out_lit("\\\""); i++; continue; }
    if (c == '\\') { out_lit("\\\\"); i++; continue; }
    if (c < 0x20) { char tmp[8]; snprintf(tmp, sizeof tmp, "\\u%04x", c); out_lit(tmp); i++; continue; }
    if (c < 0x80) { out_raw(s + i, 1); i++; continue; }
    size_t need = 0;
    if ((c & 0xE0) == 0xC0) need = 2;
    else if ((c & 0xF0) == 0xE0) need = 3;
    else if ((c & 0xF8) == 0xF0) need = 4;
    int valid = need > 0 && i + need <= n;
    for (size_t k = 1; valid && k < need; k++)
      if (((unsigned char)s[i + k] & 0xC0) != 0x80) valid = 0;
    if (valid) { out_raw(s + i, need); i += need; continue; }
    out_lit("\\ufffd"); // replacement character
    i++;
  }
  out_lit("\"");
}

static void line_begin(void) { out_len = 0; out_lit("{"); }

static void line_flush(void) {
  out_lit("}");
  out_raw("\n", 1);
  fwrite(out_buf, 1, out_len, stdout);
  out_len = 0;
}

#define KEY(k) out_lit(",\"" k "\":")
// KEYFIRST must follow line_begin(); the object opener lives there so no
// emitted line can ever start bare.
#define KEYFIRST(k) out_lit("\"" k "\":")

// ----------------------------------------------------------------- facts ---

// Whole-process facts from kinfo_proc — readable for every process on the
// system regardless of owner (the /proc/<pid>/stat equivalent).
static int kinfo_for_pid(pid_t pid, struct kinfo_proc *out) {
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  size_t len = sizeof *out;
  memset(out, 0, len);
  if (sysctl(mib, 4, out, &len, NULL, 0) != 0) return -1;
  if (len < sizeof *out || out->kp_proc.p_pid != pid) return -1;
  return 0;
}

static void emit_facts(const struct kinfo_proc *k) {
  KEYFIRST("pid"); out_u64((uint64_t)k->kp_proc.p_pid);
  KEY("ppid"); out_u64((uint64_t)k->kp_eproc.e_ppid);
  KEY("pgid"); out_u64((uint64_t)k->kp_eproc.e_pgid);
  KEY("euid"); out_u64((uint64_t)k->kp_eproc.e_ucred.cr_uid);
  KEY("ruid"); out_u64((uint64_t)k->kp_eproc.e_pcred.p_ruid);
  KEY("status"); out_u64((uint64_t)(unsigned char)k->kp_proc.p_stat);
  KEY("startSec"); out_u64((uint64_t)k->kp_proc.p_starttime.tv_sec);
  KEY("startUsec"); out_u64((uint64_t)k->kp_proc.p_starttime.tv_usec);
}

// ----------------------------------------------------------------- args ----

// KERN_PROCARGS2 buffer. Two layouts exist in practice:
//   other process: [int32 argc][exec path\0][argv[0]\0]…[argvN\0][pad][env\0]…
//   self:           [int32 argc][argv[0]\0][pad][argv[0]\0]…[argvN\0][pad][env\0]…
// Both parse with the same walk: skip the argc, skip ONE string (exec path or
// the first argv[0] copy), skip NUL padding, read argc argv strings, skip NUL
// padding, and the remaining strings are the environment.
// Returns 0 with the split block (arrays alias buf; caller frees all three);
// 1 when the kernel withheld the block (protected process: identity NOT
// provable — or a truncated layout); -1 when the process is gone.
struct argsblock { char *buf; char **argv; char **env; int argc, envc; };
static int procargs_split(pid_t pid, struct argsblock *out) {
  out->buf = NULL; out->argv = NULL; out->env = NULL; out->argc = 0; out->envc = 0;
  int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0)
    return errno == ESRCH ? -1 : 1;
  for (int round = 0; round < 4; round++) {
    if (size < sizeof(int32_t) + 2) return 1;
    char *buf = malloc(size);
    if (!buf) exit(2);
    size_t got = size;
    if (sysctl(mib, 3, buf, &got, NULL, 0) == 0) {
      char *p = buf, *end = buf + got;
      int32_t argc;
      memcpy(&argc, p, sizeof argc);
      p += sizeof argc;
      if (argc < 1 || argc > 100000) { free(buf); return 1; }
      // One string before argv: the exec path (other processes) or the
      // first argv[0] copy (self query). Empty or missing means the block
      // was withheld.
      if (p >= end) { free(buf); return 1; }
      size_t l = strnlen(p, (size_t)(end - p));
      if (l == 0 || p + l + 1 > end) { free(buf); return 1; }
      p += l + 1;
      while (p < end && *p == '\0') p++; // padding before argv (self layout)
      char **argv = calloc((size_t)argc, sizeof(char *));
      if (!argv) exit(2);
      for (int i = 0; i < argc; i++) {
        if (p >= end) { free(argv); free(buf); return 1; } // args withheld
        l = strnlen(p, (size_t)(end - p));
        if (p + l + 1 > end) { free(argv); free(buf); return 1; }
        argv[i] = p;
        p += l + 1;
      }
      while (p < end && *p == '\0') p++; // alignment padding before env
      char **env = NULL;
      int envc = 0, envcap = 0;
      while (p < end) {
        l = strnlen(p, (size_t)(end - p));
        if (l == 0) break;
        if (envc == envcap) {
          envcap = envcap ? envcap * 2 : 64;
          env = realloc(env, (size_t)envcap * sizeof(char *));
          if (!env) exit(2);
        }
        env[envc++] = p;
        p += l + 1;
      }
      out->buf = buf; out->argv = argv; out->env = env; out->argc = argc; out->envc = envc;
      return 0;
    }
    free(buf);
    if (errno != ENOMEM) return errno == ESRCH ? -1 : 1;
    size = got; // buffer grew between the two calls; retry with the new size
  }
  return 1;
}


static void argsblock_free(struct argsblock *a) {
  free(a->argv); free(a->env); free(a->buf);
  a->buf = NULL; a->argv = NULL; a->env = NULL; a->argc = 0; a->envc = 0;
}

static void emit_argsenv(pid_t pid) {
  line_begin();
  struct argsblock a;
  int rc = procargs_split(pid, &a);
  line_begin();
  KEYFIRST("pid"); out_u64((uint64_t)pid);
  if (rc < 0) { KEY("gone"); out_lit("true"); line_flush(); return; }
  if (rc > 0) { KEY("denied"); out_lit("true"); line_flush(); return; }
  KEY("argv"); out_lit("[");
  for (int i = 0; i < a.argc; i++) { if (i) out_lit(","); out_str(a.argv[i], strlen(a.argv[i])); }
  out_lit("]");
  KEY("env"); out_lit("[");
  for (int i = 0; i < a.envc; i++) { if (i) out_lit(","); out_str(a.env[i], strlen(a.env[i])); }
  out_lit("]");
  line_flush();
  argsblock_free(&a);
}

// -------------------------------------------------------------- sessions ---

static void emit_session(pid_t pid) {
  line_begin();
  line_begin();
  KEYFIRST("pid"); out_u64((uint64_t)pid);
  struct kinfo_proc a, b;
  if (kinfo_for_pid(pid, &a) != 0 || a.kp_proc.p_stat == SZOMB) { KEY("gone"); out_lit("true"); line_flush(); return; }
  errno = 0;
  long sid = getsid(pid);
  // `sid` is only trusted after the re-snapshot below proves the pid held its
  // start time across the getsid call.
  if (kinfo_for_pid(pid, &b) != 0) { KEY("gone"); out_lit("true"); line_flush(); return; }
  if (a.kp_proc.p_starttime.tv_sec != b.kp_proc.p_starttime.tv_sec ||
      a.kp_proc.p_starttime.tv_usec != b.kp_proc.p_starttime.tv_usec) {
    KEY("unstable"); out_lit("true"); line_flush(); return; // pid recycled mid-query
  }
  if (sid < 0) { KEY("denied"); out_lit("true"); line_flush(); return; }
  KEY("sid"); out_u64((uint64_t)sid);
  line_flush();
}

// ------------------------------------------------------------------ fds ----

static void emit_fds(pid_t pid) {
  line_begin();
  int size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
  if (size <= 0) {
  line_begin();
    KEYFIRST("pid"); out_u64((uint64_t)pid);
    int e = errno;
    if (e == ESRCH || e == ENOENT) { KEY("gone"); out_lit("true"); }
    else { KEY("denied"); out_lit("true"); }
    line_flush();
    return;
  }
  struct proc_fdinfo *fds = malloc((size_t)size);
  if (!fds) exit(2);
  int got = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, size);
  if (got <= 0) {
    free(fds);
  line_begin();
    KEYFIRST("pid"); out_u64((uint64_t)pid);
    int e = errno;
    if (e == ESRCH || e == ENOENT) { KEY("gone"); out_lit("true"); }
    else { KEY("denied"); out_lit("true"); }
    line_flush();
    return;
  }
  int count = got / (int)sizeof(struct proc_fdinfo);
  for (int i = 0; i < count; i++) {
    if (fds[i].proc_fdtype != PROX_FDTYPE_VNODE) continue;
    struct vnode_fdinfowithpath vi;
    memset(&vi, 0, sizeof vi);
    int rv = proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDVNODEPATHINFO, &vi, sizeof vi);
    if (rv <= 0) continue; // descriptor closed between the two calls
  line_begin();
    KEYFIRST("pid"); out_u64((uint64_t)pid);
    KEY("fd"); out_u64((uint64_t)fds[i].proc_fd);
    KEY("dev"); out_u64((uint64_t)vi.pvip.vip_vi.vi_stat.vst_dev);
    KEY("ino"); out_u64((uint64_t)vi.pvip.vip_vi.vi_stat.vst_ino);
    KEY("path"); out_str(vi.pvip.vip_path, strnlen(vi.pvip.vip_path, sizeof vi.pvip.vip_path));
    line_flush();
  }
  free(fds);
}

// ----------------------------------------------------------------- boot ---

static void emit_boot(void) {
  struct timeval tv;
  size_t len = sizeof tv;
  int mib[2] = {CTL_KERN, KERN_BOOTTIME};
  if (sysctl(mib, 2, &tv, &len, NULL, 0) != 0) {
    fprintf(stderr, "nozeli-procinfo: KERN_BOOTTIME failed: %s\n", strerror(errno));
    exit(2);
  }
  line_begin();
  KEYFIRST("bootSec"); out_u64((uint64_t)tv.tv_sec);
  KEY("bootUsec"); out_u64((uint64_t)tv.tv_usec);
  line_flush();
}

// ----------------------------------------------------------------- scan ---

static int flag_present(int argc, char **argv, const char *flag) {
  for (int i = 1; i < argc; i++) if (!strcmp(argv[i], flag)) return 1;
  return 0;
}

static void emit_scan(int argc, char **argv) {
  int with_sessions = flag_present(argc, argv, "--sessions");
  int with_argv = flag_present(argc, argv, "--argv");
  int with_paths = flag_present(argc, argv, "--paths");
  int mib[3] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL};
  size_t len = 0;
  if (sysctl(mib, 3, NULL, &len, NULL, 0) != 0) {
    fprintf(stderr, "nozeli-procinfo: KERN_PROC_ALL sizing failed: %s\n", strerror(errno));
    exit(2);
  }
  struct kinfo_proc *procs = NULL;
  size_t count = 0;
  for (int round = 0; round < 4; round++) {
    if (len == 0) break;
    procs = malloc(len);
    if (!procs) exit(2);
    if (sysctl(mib, 3, procs, &len, NULL, 0) == 0) { count = len / sizeof(struct kinfo_proc); break; }
    free(procs); procs = NULL;
    if (errno != ENOMEM) {
      fprintf(stderr, "nozeli-procinfo: KERN_PROC_ALL failed: %s\n", strerror(errno));
      exit(2);
    }
  }
  uid_t me = getuid();
  for (size_t i = 0; i < count; i++) {
    struct kinfo_proc *k = &procs[i];
    pid_t pid = k->kp_proc.p_pid;
    if (pid <= 0) continue;
    int same_uid = k->kp_eproc.e_ucred.cr_uid == me || k->kp_eproc.e_pcred.p_ruid == me;
    int zombie = k->kp_proc.p_stat == SZOMB;
    line_begin();
    emit_facts(k);
    if (with_sessions) {
      long sid = -1;
      int sid_state = 0; // 0 ok, 1 denied, 2 unstable
      if (!zombie) {
        errno = 0;
        sid = getsid(pid);
        if (sid < 0) sid_state = 1;
        else {
          struct kinfo_proc recheck;
          if (kinfo_for_pid(pid, &recheck) != 0) sid_state = 1;
          else if (recheck.kp_proc.p_starttime.tv_sec != k->kp_proc.p_starttime.tv_sec ||
                   recheck.kp_proc.p_starttime.tv_usec != k->kp_proc.p_starttime.tv_usec)
            sid_state = 2;
        }
      }
      if (sid_state == 1) { KEY("sidDenied"); out_lit("true"); }
      else if (sid_state == 2) { KEY("sidUnstable"); out_lit("true"); }
      else { KEY("sid"); out_u64((uint64_t)sid); }
    }
    if (same_uid && !zombie && with_paths) {
      char pbuf[PROC_PIDPATHINFO_MAXSIZE];
      memset(pbuf, 0, sizeof pbuf);
      if (proc_pidpath(pid, pbuf, sizeof pbuf - 1) > 0) { KEY("path"); out_str(pbuf, strnlen(pbuf, sizeof pbuf - 1)); }
      else { KEY("pathDenied"); out_lit("true"); }
    }
    if (same_uid && !zombie) {
      struct argsblock a;
      int rc = procargs_split(pid, &a);
      if (rc == 0) {
        if (with_argv) {
          KEY("argv"); out_lit("[");
          for (int j = 0; j < a.argc; j++) { if (j) out_lit(","); out_str(a.argv[j], strlen(a.argv[j])); }
          out_lit("]");
        }
        KEY("env"); out_lit("[");
        for (int j = 0; j < a.envc; j++) { if (j) out_lit(","); out_str(a.env[j], strlen(a.env[j])); }
        out_lit("]");
        argsblock_free(&a);
      } else if (rc > 0) {
        KEY("envDenied"); out_lit("true");
      }
      // rc < 0: the process exited mid-scan; the facts line still stands and
      // the caller re-verifies every incarnation before signalling.
    }
    line_flush();
  }
  free(procs);
}

// ------------------------------------------------------------------ main ---

static void usage(void) {
  fprintf(stderr,
    "usage: nozeli-procinfo boot\n"
    "       nozeli-procinfo info <pid>\n"
    "       nozeli-procinfo stamps <pid> [pid ...]\n"
    "       nozeli-procinfo argsenv <pid>\n"
    "       nozeli-procinfo path <pid>\n"
    "       nozeli-procinfo session <pid>\n"
    "       nozeli-procinfo fds <pid>\n"
    "       nozeli-procinfo scan [--sessions] [--argv] [--paths]\n"
    "       nozeli-procinfo selfcheck\n");
  exit(1);
}

static pid_t parse_pid(const char *s) {
  char *end = NULL;
  long v = strtol(s, &end, 10);
  if (!end || *end != '\0' || v <= 0 || v > 9999999) return -1;
  return (pid_t)v;
}

static void emit_path(pid_t pid) {
  line_begin();
  char buf[PROC_PIDPATHINFO_MAXSIZE];
  memset(buf, 0, sizeof buf);
  int rv = proc_pidpath(pid, buf, sizeof buf - 1);
  line_begin();
  KEYFIRST("pid"); out_u64((uint64_t)pid);
  if (rv > 0) { KEY("path"); out_str(buf, strnlen(buf, sizeof buf - 1)); }
  else if (errno == ESRCH || errno == ENOENT) { KEY("gone"); out_lit("true"); }
  else { KEY("denied"); out_lit("true"); }
  line_flush();
}

int main(int argc, char **argv) {
  if (argc < 2) usage();
  const char *cmd = argv[1];
  if (!strcmp(cmd, "boot")) { emit_boot(); return 0; }
  if (!strcmp(cmd, "info")) {
    if (argc != 3) usage();
    pid_t pid = parse_pid(argv[2]);
    if (pid < 0) usage();
    struct kinfo_proc k;
    if (kinfo_for_pid(pid, &k) != 0) { line_begin(); KEYFIRST("pid"); out_u64((uint64_t)pid); KEY("gone"); out_lit("true"); line_flush(); return 0; }
    line_begin();
    emit_facts(&k);
    line_flush();
    return 0;
  }
  if (!strcmp(cmd, "stamps")) {
    if (argc < 3) usage();
    for (int i = 2; i < argc; i++) {
      pid_t pid = parse_pid(argv[i]);
      if (pid < 0) usage();
      struct kinfo_proc k;
      if (kinfo_for_pid(pid, &k) != 0) { line_begin(); KEYFIRST("pid"); out_u64((uint64_t)pid); KEY("gone"); out_lit("true"); line_flush(); continue; }
      line_begin();
      KEYFIRST("pid"); out_u64((uint64_t)pid);
      KEY("status"); out_u64((uint64_t)(unsigned char)k.kp_proc.p_stat);
      KEY("startSec"); out_u64((uint64_t)k.kp_proc.p_starttime.tv_sec);
      KEY("startUsec"); out_u64((uint64_t)k.kp_proc.p_starttime.tv_usec);
      line_flush();
    }
    return 0;
  }
  if (!strcmp(cmd, "argsenv")) {
    if (argc != 3) usage();
    pid_t pid = parse_pid(argv[2]);
    if (pid < 0) usage();
    emit_argsenv(pid);
    return 0;
  }
  if (!strcmp(cmd, "path")) {
    if (argc != 3) usage();
    pid_t pid = parse_pid(argv[2]);
    if (pid < 0) usage();
    emit_path(pid);
    return 0;
  }
  if (!strcmp(cmd, "session")) {
    if (argc != 3) usage();
    pid_t pid = parse_pid(argv[2]);
    if (pid < 0) usage();
    emit_session(pid);
    return 0;
  }
  if (!strcmp(cmd, "fds")) {
    if (argc != 3) usage();
    pid_t pid = parse_pid(argv[2]);
    if (pid < 0) usage();
    emit_fds(pid);
    return 0;
  }
  if (!strcmp(cmd, "scan")) { emit_scan(argc, argv); return 0; }
  if (!strcmp(cmd, "selfcheck")) {
    emit_boot();
    struct kinfo_proc k;
    if (kinfo_for_pid(getpid(), &k) != 0 || k.kp_proc.p_starttime.tv_sec == 0) { fprintf(stderr, "selfcheck: no self facts\n"); return 2; }
    line_begin();
    emit_facts(&k); line_flush();
    emit_argsenv(getpid());
    emit_path(getpid());
    long sid = getsid(0);
    if (sid < 0) { fprintf(stderr, "selfcheck: getsid(self) failed: %s\n", strerror(errno)); return 2; }
    return 0;
  }
  usage();
  return 1;
}
