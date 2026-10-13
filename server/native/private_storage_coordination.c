#define _GNU_SOURCE
#define NAPI_VERSION 8

#include "private_storage_coordination.h"
#include "private_storage_quarantine.h"

#include <dirent.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *coordination_errno_name(int value) {
  switch (value) {
    case EACCES: return "EACCES";
    case EBADF: return "EBADF";
    case EBUSY: return "EBUSY";
    case EEXIST: return "EEXIST";
    case EINVAL: return "EINVAL";
    case ELOOP: return "ELOOP";
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case EPERM: return "EPERM";
    default: return "EIO";
  }
}

static napi_value coordination_throw_code(napi_env env, const char *code) {
  napi_value message;
  napi_value error;
  napi_value code_value;
  if (napi_create_string_utf8(env, "private storage operation failed", NAPI_AUTO_LENGTH,
                              &message) != napi_ok)
    return NULL;
  if (napi_create_error(env, NULL, message, &error) != napi_ok) return NULL;
  if (napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &code_value) != napi_ok)
    return NULL;
  if (napi_set_named_property(env, error, "code", code_value) != napi_ok) return NULL;
  if (napi_throw(env, error) != napi_ok) return NULL;
  return NULL;
}

static napi_value coordination_throw_errno(napi_env env) {
  const int saved_errno = errno;
  return coordination_throw_code(env, coordination_errno_name(saved_errno));
}

static int coordination_exact_args(napi_env env, napi_callback_info info,
                                   size_t expected, napi_value *argv) {
  size_t actual = 0;
  if (napi_get_cb_info(env, info, &actual, NULL, NULL, NULL) != napi_ok ||
      actual != expected) {
    coordination_throw_code(env, "EINVAL");
    return 0;
  }
  actual = expected;
  if (napi_get_cb_info(env, info, &actual, argv, NULL, NULL) != napi_ok ||
      actual != expected) {
    coordination_throw_code(env, "EINVAL");
    return 0;
  }
  return 1;
}

static int coordination_integer_arg(napi_env env, napi_value value, int *result) {
  napi_valuetype type;
  double candidate;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &candidate) != napi_ok || !isfinite(candidate) ||
      candidate < 0 || candidate > INT_MAX || trunc(candidate) != candidate) {
    coordination_throw_code(env, "EINVAL");
    return 0;
  }
  *result = (int)candidate;
  return 1;
}

static napi_value coordination_number(napi_env env, int value) {
  napi_value result;
  if (napi_create_int32(env, value, &result) != napi_ok)
    return coordination_throw_code(env, "EIO");
  return result;
}

static napi_value coordination_undefined(napi_env env) {
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok)
    return coordination_throw_code(env, "EIO");
  return result;
}

static napi_value coordination_owned_fd_number(napi_env env, int fd,
                                                const char *stage) {
  if (!private_storage_invoke_test_hook(env, stage)) {
    close(fd);
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) return NULL;
    return coordination_throw_code(env, "EIO");
  }
  napi_value result;
  if (napi_create_int32(env, fd, &result) != napi_ok) {
    close(fd);
    return coordination_throw_code(env, "EIO");
  }
  return result;
}

int private_storage_validate_lock(int lock_fd) {
  struct stat directory;
  if (fstat(lock_fd, &directory) < 0) return -1;
  if (!S_ISDIR(directory.st_mode)) {
    errno = EINVAL;
    return -1;
  }
  if (flock(lock_fd, LOCK_EX | LOCK_NB) < 0) {
    if (errno == EAGAIN) errno = EBUSY;
    return -1;
  }
  return 0;
}

napi_value private_storage_lock_directory(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int directory_fd;
  if (!coordination_exact_args(env, info, 1, argv) ||
      !coordination_integer_arg(env, argv[0], &directory_fd))
    return NULL;
  struct stat directory;
  if (fstat(directory_fd, &directory) < 0) return coordination_throw_errno(env);
  if (!S_ISDIR(directory.st_mode)) return coordination_throw_code(env, "EINVAL");
  const int lock_fd = openat(directory_fd, ".",
                             O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (lock_fd < 0) return coordination_throw_errno(env);
  if (private_storage_validate_lock(lock_fd) < 0) {
    const int saved_errno = errno;
    close(lock_fd);
    errno = saved_errno == EAGAIN ? EBUSY : saved_errno;
    return coordination_throw_errno(env);
  }
  return coordination_owned_fd_number(env, lock_fd, "lock-directory-result");
}

napi_value private_storage_lock_temp_file(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int file_fd;
  if (!coordination_exact_args(env, info, 1, argv) ||
      !coordination_integer_arg(env, argv[0], &file_fd))
    return NULL;
  struct stat file;
  if (fstat(file_fd, &file) < 0) return coordination_throw_errno(env);
  if (!S_ISREG(file.st_mode) || (file.st_mode & 0777) != 0600)
    return coordination_throw_code(env, "EINVAL");
  if (flock(file_fd, LOCK_EX | LOCK_NB) < 0) {
    if (errno == EWOULDBLOCK || errno == EAGAIN) errno = EBUSY;
    return coordination_throw_errno(env);
  }
  return coordination_undefined(env);
}

napi_value private_storage_unlink_owned_at(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  int lock_fd;
  int directory_fd;
  int quarantine_directory_fd;
  int owned_fd;
  if (!coordination_exact_args(env, info, 4, argv) ||
      !coordination_integer_arg(env, argv[0], &lock_fd) ||
      !coordination_integer_arg(env, argv[1], &directory_fd) ||
      !coordination_integer_arg(env, argv[2], &quarantine_directory_fd) ||
      !coordination_integer_arg(env, argv[3], &owned_fd))
    return NULL;
  if (private_storage_validate_lock(lock_fd) < 0)
    return coordination_throw_errno(env);
  const int removed = private_storage_cleanup_owned_links(
      env, directory_fd, quarantine_directory_fd, owned_fd);
  if (removed < 0) return coordination_throw_errno(env);
  return coordination_number(env, removed);
}

napi_value private_storage_recover_temp_at(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  int lock_fd;
  int directory_fd;
  int quarantine_directory_fd;
  if (!coordination_exact_args(env, info, 3, argv) ||
      !coordination_integer_arg(env, argv[0], &lock_fd) ||
      !coordination_integer_arg(env, argv[1], &directory_fd) ||
      !coordination_integer_arg(env, argv[2], &quarantine_directory_fd))
    return NULL;
  struct stat directory;
  struct stat quarantine;
  if (private_storage_validate_lock(lock_fd) < 0 ||
      fstat(directory_fd, &directory) < 0 ||
      fstat(quarantine_directory_fd, &quarantine) < 0)
    return coordination_throw_errno(env);
  if (!S_ISDIR(directory.st_mode) || !S_ISDIR(quarantine.st_mode) ||
      directory.st_dev != quarantine.st_dev)
    return coordination_throw_code(env, "EINVAL");
  const int recovered_quarantine =
      private_storage_recover_quarantine_files(quarantine_directory_fd);
  if (recovered_quarantine < 0) return coordination_throw_errno(env);
  const int recovered_directory = private_storage_recover_temp_files(
      env, directory_fd, quarantine_directory_fd);
  if (recovered_directory < 0) return coordination_throw_errno(env);
  if (fsync(quarantine_directory_fd) < 0 || fsync(directory_fd) < 0 ||
      fsync(lock_fd) < 0)
    return coordination_throw_errno(env);
  return coordination_number(env, recovered_quarantine + recovered_directory);
}
