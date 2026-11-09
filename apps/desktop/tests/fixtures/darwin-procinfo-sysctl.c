// Compile only on macOS: real Darwin ABI and production helper, with sysctl
// replaced at this translation-unit boundary for deterministic kernel failures.
#include <sys/types.h>
#include <sys/sysctl.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int fixture_sysctl(int *, unsigned int, void *, size_t *, void *, size_t);
#define sysctl fixture_sysctl
#define main procinfo_main
#include "../../native/nozeli-procinfo.c"
#undef main
#undef sysctl

static int fixture_sysctl(int *mib, unsigned int count, void *data,
                          size_t *len, void *new_data, size_t new_len) {
  (void)new_data; (void)new_len;
  const char *scenario = getenv("NOZELI_PROCINFO_SCENARIO");
  if (!scenario) scenario = "present";
  static int reads = 0;
  if (count == 2 && mib[1] == KERN_BOOTTIME) {
    struct timeval *tv = data;
    memset(tv, 0, sizeof *tv);
    tv->tv_sec = 123;
    *len = sizeof *tv;
    return 0;
  }
  if (count == 3 && mib[1] == KERN_PROC && mib[2] == KERN_PROC_ALL) {
    if (!data) {
      if (!strcmp(scenario, "scan-sizing-error")) { errno = EIO; return -1; }
      *len = !strcmp(scenario, "scan-zero-sizing") ? 0 : sizeof(struct kinfo_proc);
      return 0;
    }
    reads++;
    if (!strcmp(scenario, "scan-enomem") ||
        (!strcmp(scenario, "scan-retry-success") && reads < 4)) {
      errno = ENOMEM; return -1;
    }
    if (!strcmp(scenario, "scan-read-error")) { errno = EIO; return -1; }
    if (!strcmp(scenario, "scan-zero-data")) { *len = 0; return 0; }
    if (!strcmp(scenario, "scan-short")) { *len = sizeof(struct kinfo_proc) - 1; return 0; }
    struct kinfo_proc *k = data;
    memset(k, 0, sizeof *k);
    k->kp_proc.p_pid = getppid();
    k->kp_proc.p_stat = 3;
    k->kp_proc.p_starttime.tv_sec = 123;
    *len = sizeof *k;
    return 0;
  }
  if (count == 4 && mib[1] == KERN_PROC && mib[2] == KERN_PROC_PID) {
    reads++;
    if (!strcmp(scenario, "absent-zero")) { *len = 0; return 0; }
    if (!strcmp(scenario, "absent-esrch")) { errno = ESRCH; return -1; }
    if (!strcmp(scenario, "absent-enoent")) { errno = ENOENT; return -1; }
    if (!strcmp(scenario, "pid-eio") ||
        (!strcmp(scenario, "later-error") && reads > 1) ||
        !strcmp(scenario, "scan-session-error")) { errno = EIO; return -1; }
    if (!strcmp(scenario, "pid-eperm")) { errno = EPERM; return -1; }
    if (!strcmp(scenario, "pid-enomem")) { errno = ENOMEM; return -1; }
    struct kinfo_proc *k = data;
    memset(k, 0, sizeof *k);
    k->kp_proc.p_pid = !strcmp(scenario, "pid-mismatch") ? mib[3] + 1 : mib[3];
    k->kp_proc.p_stat = 3;
    k->kp_proc.p_starttime.tv_sec = 123;
    *len = !strcmp(scenario, "pid-short") ? sizeof *k - 1 : sizeof *k;
    return 0;
  }
  // Optional argument/environment facts are intentionally withheld. All
  // identity and table interfaces above must execute their injected behavior.
  errno = EPERM;
  return -1;
}

int main(int argc, char **argv) { return procinfo_main(argc, argv); }
