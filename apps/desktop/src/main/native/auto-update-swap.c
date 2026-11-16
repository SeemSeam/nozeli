// Atomic same-volume bundle exchange; no shell, privilege change or data migration.
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stdio.h>
#include <stdlib.h>
#include <inttypes.h>
#include <sys/stat.h>
#include <unistd.h>
static int matches(const char *file, const char *device, const char *inode) {
  struct stat st;
  char *end;
  errno = 0;
  uintmax_t dev = strtoumax(device, &end, 10);
  if (errno || !*device || *end) return 0;
  uintmax_t ino = strtoumax(inode, &end, 10);
  if (errno || !*inode || *end) return 0;
  return lstat(file, &st) == 0 && S_ISDIR(st.st_mode) && st.st_uid == getuid()
    && !(st.st_mode & 06022) && (uintmax_t)st.st_dev == dev && (uintmax_t)st.st_ino == ino;
}
int main(int argc, char **argv) {
  if (argc != 7) return 64;
  if (!matches(argv[1], argv[3], argv[4]) || !matches(argv[2], argv[5], argv[6])) {
    fputs("bundle exchange identity changed\n", stderr);
    return 1;
  }
  if (renameatx_np(AT_FDCWD, argv[1], AT_FDCWD, argv[2], RENAME_SWAP) != 0) {
    fprintf(stderr, "bundle exchange: %s\n", strerror(errno));
    return 1;
  }
  return 0;
}
