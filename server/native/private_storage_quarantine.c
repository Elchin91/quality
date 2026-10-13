#define _GNU_SOURCE

#include "private_storage_quarantine.h"

#include "private_storage_coordination.h"

#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

#include <sys/syscall.h>
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif

#define MAX_CLEANUP_PASSES 4096

static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int rename_exclusive(int source_directory_fd, const char *source,
                            int target_directory_fd, const char *target) {
  return (int)syscall(SYS_renameat2, source_directory_fd, source,
                      target_directory_fd, target, RENAME_NOREPLACE);
}

static int quarantine_candidate(napi_env env, int directory_fd,
                                int quarantine_directory_fd, const char *source,
                                const struct stat *owned, unsigned int *sequence,
                                int *removed) {
  char quarantine[NAME_MAX + 1];
  int renamed = 0;
  for (int attempt = 0; attempt < MAX_CLEANUP_PASSES; attempt++) {
    const int length = snprintf(
        quarantine, sizeof(quarantine), ".pending-%016llx-%016llx-%08x",
        (unsigned long long)(uint64_t)owned->st_dev,
        (unsigned long long)(uint64_t)owned->st_ino, (*sequence)++);
    if (length < 0 || (size_t)length >= sizeof(quarantine)) {
      errno = EIO;
      return -1;
    }
    if (!private_storage_invoke_test_hook(env, "cleanup-before-quarantine"))
      return -1;
    if (rename_exclusive(directory_fd, source, quarantine_directory_fd, quarantine) == 0) {
      renamed = 1;
      break;
    }
    if (errno == EEXIST) continue;
    if (errno == ENOENT) return 1;
    return -1;
  }
  if (!renamed) {
    errno = EBUSY;
    return -1;
  }

  struct stat quarantined;
  if (fstatat(quarantine_directory_fd, quarantine, &quarantined,
              AT_SYMLINK_NOFOLLOW) < 0)
    return -1;
  if (!S_ISREG(quarantined.st_mode) || !same_identity(&quarantined, owned)) {
    if (rename_exclusive(quarantine_directory_fd, quarantine, directory_fd, source) < 0 &&
        errno != EEXIST)
      return -1;
    return 1;
  }

  struct stat confirmed;
  if (fstatat(quarantine_directory_fd, quarantine, &confirmed,
              AT_SYMLINK_NOFOLLOW) < 0 ||
      !same_identity(&confirmed, owned))
    return 1;
  if (fsync(quarantine_directory_fd) < 0 || fsync(directory_fd) < 0) return -1;
  if (!private_storage_invoke_test_hook(env, "cleanup-before-unlink")) return -1;
  if (unlinkat(quarantine_directory_fd, quarantine, 0) < 0) return -1;
  (*removed)++;
  return 1;
}

int private_storage_cleanup_owned_links(napi_env env, int directory_fd,
                                        int quarantine_directory_fd, int owned_fd) {
  struct stat directory;
  struct stat quarantine_directory;
  struct stat owned;
  if (fstat(directory_fd, &directory) < 0 ||
      fstat(quarantine_directory_fd, &quarantine_directory) < 0 ||
      fstat(owned_fd, &owned) < 0)
    return -1;
  if (!S_ISDIR(directory.st_mode) || !S_ISDIR(quarantine_directory.st_mode) ||
      !S_ISREG(owned.st_mode) || directory.st_dev != quarantine_directory.st_dev) {
    errno = EINVAL;
    return -1;
  }

  int removed = 0;
  int stable_passes = 0;
  unsigned int sequence = 0;
  for (int pass = 0; pass < MAX_CLEANUP_PASSES && stable_passes < 2; pass++) {
    const int scan_fd = openat(directory_fd, ".",
                               O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (scan_fd < 0) return -1;
    DIR *stream = fdopendir(scan_fd);
    if (stream == NULL) {
      close(scan_fd);
      return -1;
    }
    int found_owned = 0;
    int restart = 0;
    for (;;) {
      errno = 0;
      struct dirent *entry = readdir(stream);
      if (entry == NULL) {
        const int saved_errno = errno;
        if (saved_errno == 0 &&
            !private_storage_invoke_test_hook(env, "cleanup-scan-eof")) {
          closedir(stream);
          return -1;
        }
        if (closedir(stream) < 0 && saved_errno == 0) return -1;
        if (saved_errno != 0) {
          errno = saved_errno;
          return -1;
        }
        break;
      }
      if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0)
        continue;
      struct stat current;
      if (fstatat(directory_fd, entry->d_name, &current,
                  AT_SYMLINK_NOFOLLOW) < 0 ||
          !S_ISREG(current.st_mode) || !same_identity(&current, &owned))
        continue;
      found_owned = 1;
      const int result = quarantine_candidate(env, directory_fd,
                                              quarantine_directory_fd,
                                              entry->d_name, &owned, &sequence,
                                              &removed);
      if (result < 0) {
        const int saved_errno = errno;
        closedir(stream);
        errno = saved_errno;
        return -1;
      }
      restart = 1;
      closedir(stream);
      break;
    }
    if (restart || found_owned) {
      stable_passes = 0;
      continue;
    }
    stable_passes++;
  }
  if (stable_passes < 2) {
    errno = EBUSY;
    return -1;
  }
  if (fsync(quarantine_directory_fd) < 0 || fsync(directory_fd) < 0) return -1;
  return removed;
}

static int is_uuid_temp_leaf(const char *name) {
  if (name == NULL || strlen(name) != 41 || strcmp(name + 36, ".part") != 0)
    return 0;
  for (int index = 0; index < 36; index++) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (name[index] != '-') return 0;
    } else if (!isxdigit((unsigned char)name[index])) {
      return 0;
    }
  }
  return 1;
}

static int lowercase_hex(const char *value, size_t length) {
  for (size_t index = 0; index < length; index++) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f')))
      return 0;
  }
  return 1;
}

static int pending_identity(const char *name, uint64_t *device, uint64_t *inode) {
  if (name == NULL || strlen(name) != 51 || strncmp(name, ".pending-", 9) != 0 ||
      name[25] != '-' || name[42] != '-' ||
      !lowercase_hex(name + 9, 16) || !lowercase_hex(name + 26, 16) ||
      !lowercase_hex(name + 43, 8))
    return 0;
  char device_hex[17];
  char inode_hex[17];
  memcpy(device_hex, name + 9, 16);
  memcpy(inode_hex, name + 26, 16);
  device_hex[16] = '\0';
  inode_hex[16] = '\0';
  errno = 0;
  const unsigned long long parsed_device = strtoull(device_hex, NULL, 16);
  const unsigned long long parsed_inode = strtoull(inode_hex, NULL, 16);
  if (errno != 0) return 0;
  *device = (uint64_t)parsed_device;
  *inode = (uint64_t)parsed_inode;
  return 1;
}

int private_storage_recover_quarantine_files(int quarantine_directory_fd) {
  int removed = 0;
  int stable_passes = 0;
  for (int pass = 0; pass < MAX_CLEANUP_PASSES && stable_passes < 2; pass++) {
    const int scan_fd = openat(quarantine_directory_fd, ".",
                               O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (scan_fd < 0) return -1;
    DIR *stream = fdopendir(scan_fd);
    if (stream == NULL) {
      close(scan_fd);
      return -1;
    }
    int candidate_fd = -1;
    char candidate_name[NAME_MAX + 1] = {0};
    for (;;) {
      errno = 0;
      struct dirent *entry = readdir(stream);
      if (entry == NULL) break;
      uint64_t expected_device;
      uint64_t expected_inode;
      if (!pending_identity(entry->d_name, &expected_device, &expected_inode)) continue;
      struct stat entry_metadata;
      if (fstatat(quarantine_directory_fd, entry->d_name, &entry_metadata,
                  AT_SYMLINK_NOFOLLOW) < 0) {
        if (errno == ENOENT) continue;
        break;
      }
      if (!S_ISREG(entry_metadata.st_mode) || (entry_metadata.st_mode & 0777) != 0600 ||
          entry_metadata.st_nlink != 1 ||
          (uint64_t)entry_metadata.st_dev != expected_device ||
          (uint64_t)entry_metadata.st_ino != expected_inode)
        continue;
      candidate_fd = openat(quarantine_directory_fd, entry->d_name,
                            O_RDWR | O_NOFOLLOW | O_CLOEXEC);
      if (candidate_fd < 0) {
        if (errno == ENOENT) continue;
        break;
      }
      if (flock(candidate_fd, LOCK_EX | LOCK_NB) < 0) {
        const int lock_error = errno;
        close(candidate_fd);
        candidate_fd = -1;
        if (lock_error == EWOULDBLOCK || lock_error == EAGAIN) {
          errno = 0;
          continue;
        }
        errno = lock_error;
        break;
      }
      struct stat opened;
      if (fstat(candidate_fd, &opened) < 0 || !same_identity(&opened, &entry_metadata)) break;
      snprintf(candidate_name, sizeof(candidate_name), "%s", entry->d_name);
      break;
    }
    const int scan_error = errno;
    if (closedir(stream) < 0 && scan_error == 0) {
      if (candidate_fd >= 0) close(candidate_fd);
      return -1;
    }
    if (scan_error != 0) {
      if (candidate_fd >= 0) close(candidate_fd);
      errno = scan_error;
      return -1;
    }
    if (candidate_fd < 0) {
      stable_passes++;
      continue;
    }
    stable_passes = 0;
    struct stat confirmed;
    struct stat opened;
    const int valid = fstat(candidate_fd, &opened) == 0 &&
                      fstatat(quarantine_directory_fd, candidate_name, &confirmed,
                              AT_SYMLINK_NOFOLLOW) == 0 &&
                      S_ISREG(confirmed.st_mode) && confirmed.st_nlink == 1 &&
                      same_identity(&opened, &confirmed);
    if (!valid || unlinkat(quarantine_directory_fd, candidate_name, 0) < 0) {
      const int saved_errno = errno == 0 ? EINVAL : errno;
      close(candidate_fd);
      errno = saved_errno;
      return -1;
    }
    close(candidate_fd);
    removed++;
    if (fsync(quarantine_directory_fd) < 0) return -1;
  }
  if (stable_passes < 2) {
    errno = EBUSY;
    return -1;
  }
  return removed;
}

int private_storage_recover_temp_files(napi_env env, int directory_fd,
                                       int quarantine_directory_fd) {
  int removed = 0;
  int stable_passes = 0;
  for (int pass = 0; pass < MAX_CLEANUP_PASSES && stable_passes < 2; pass++) {
    const int scan_fd = openat(directory_fd, ".",
                               O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (scan_fd < 0) return -1;
    DIR *stream = fdopendir(scan_fd);
    if (stream == NULL) {
      close(scan_fd);
      return -1;
    }
    int owned_fd = -1;
    for (;;) {
      errno = 0;
      struct dirent *entry = readdir(stream);
      if (entry == NULL) break;
      if (!is_uuid_temp_leaf(entry->d_name)) continue;
      owned_fd = openat(directory_fd, entry->d_name,
                        O_RDWR | O_NOFOLLOW | O_CLOEXEC);
      if (owned_fd < 0 && errno == ENOENT) continue;
      if (owned_fd >= 0 && flock(owned_fd, LOCK_EX | LOCK_NB) < 0) {
        const int lock_error = errno;
        close(owned_fd);
        owned_fd = -1;
        if (lock_error == EWOULDBLOCK || lock_error == EAGAIN) {
          errno = 0;
          continue;
        }
        errno = lock_error;
      }
      break;
    }
    const int scan_error = errno;
    if (closedir(stream) < 0 && scan_error == 0) return -1;
    if (scan_error != 0) {
      if (owned_fd >= 0) close(owned_fd);
      errno = scan_error;
      return -1;
    }
    if (owned_fd < 0) {
      stable_passes++;
      continue;
    }
    stable_passes = 0;
    struct stat owned;
    if (fstat(owned_fd, &owned) < 0 || !S_ISREG(owned.st_mode)) {
      const int saved_errno = errno == 0 ? EINVAL : errno;
      close(owned_fd);
      errno = saved_errno;
      return -1;
    }
    const int current = private_storage_cleanup_owned_links(
        env, directory_fd, quarantine_directory_fd, owned_fd);
    const int saved_errno = errno;
    close(owned_fd);
    if (current < 0) {
      errno = saved_errno;
      return -1;
    }
    removed += current;
  }
  if (stable_passes < 2) {
    errno = EBUSY;
    return -1;
  }
  return removed;
}
