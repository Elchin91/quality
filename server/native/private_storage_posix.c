#define _GNU_SOURCE
#define NAPI_VERSION 8

#include <node_api.h>

#include "private_storage_coordination.h"
#include "private_storage_quarantine.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifdef PRIVATE_STORAGE_TEST_HOOKS
typedef struct {
  napi_ref test_hook;
} addon_state;

static addon_state *get_state(napi_env env) {
  addon_state *state = NULL;
  if (napi_get_instance_data(env, (void **)&state) != napi_ok) return NULL;
  return state;
}
#endif

int private_storage_invoke_test_hook(napi_env env, const char *stage) {
#ifdef PRIVATE_STORAGE_TEST_HOOKS
  addon_state *state = get_state(env);
  if (state == NULL || state->test_hook == NULL) return 1;
  napi_value callback;
  napi_value global;
  napi_value argument;
  napi_value result;
  if (napi_get_reference_value(env, state->test_hook, &callback) != napi_ok ||
      napi_get_global(env, &global) != napi_ok ||
      napi_create_string_utf8(env, stage, NAPI_AUTO_LENGTH, &argument) != napi_ok ||
      napi_call_function(env, global, callback, 1, &argument, &result) != napi_ok)
    return 0;
  napi_valuetype type;
  bool allowed = true;
  if (napi_typeof(env, result, &type) != napi_ok) return 0;
  if (type == napi_boolean && napi_get_value_bool(env, result, &allowed) != napi_ok)
    return 0;
  if (!allowed) return 0;
#else
  (void)env;
  (void)stage;
#endif
  return 1;
}

#ifdef PRIVATE_STORAGE_TEST_HOOKS
static void finalize_state(napi_env env, void *data, void *hint) {
  (void)hint;
  addon_state *state = data;
  if (state->test_hook != NULL) napi_delete_reference(env, state->test_hook);
  free(state);
}
#endif

static const char *errno_name(int value) {
  switch (value) {
    case EACCES: return "EACCES";
    case EBADF: return "EBADF";
    case EEXIST: return "EEXIST";
    case EINVAL: return "EINVAL";
    case ELOOP: return "ELOOP";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case ENOENT: return "ENOENT";
    case ENOTDIR: return "ENOTDIR";
    case EPERM: return "EPERM";
    case EXDEV: return "EXDEV";
    default: return "EIO";
  }
}

static napi_value throw_code(napi_env env, const char *code) {
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

static napi_value throw_errno(napi_env env) {
  const int saved_errno = errno;
  return throw_code(env, errno_name(saved_errno));
}

static int exact_args(napi_env env, napi_callback_info info, size_t expected,
                      napi_value *argv) {
  size_t actual = 0;
  if (napi_get_cb_info(env, info, &actual, NULL, NULL, NULL) != napi_ok ||
      actual != expected) {
    throw_code(env, "EINVAL");
    return 0;
  }
  actual = expected;
  if (napi_get_cb_info(env, info, &actual, argv, NULL, NULL) != napi_ok ||
      actual != expected) {
    throw_code(env, "EINVAL");
    return 0;
  }
  return 1;
}

static int integer_arg(napi_env env, napi_value value, int maximum, int *result) {
  napi_valuetype type;
  double candidate;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &candidate) != napi_ok || !isfinite(candidate) ||
      candidate < 0 || candidate > maximum || trunc(candidate) != candidate) {
    throw_code(env, "EINVAL");
    return 0;
  }
  *result = (int)candidate;
  return 1;
}

static int string_arg(napi_env env, napi_value value, size_t maximum, char **result) {
  napi_valuetype type;
  size_t length = 0;
  size_t copied = 0;
  *result = NULL;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length > maximum) {
    throw_code(env, "EINVAL");
    return 0;
  }
  char *buffer = malloc(length + 1);
  if (buffer == NULL) {
    throw_code(env, "EIO");
    return 0;
  }
  if (napi_get_value_string_utf8(env, value, buffer, length + 1, &copied) != napi_ok ||
      copied != length || buffer[length] != '\0' || memchr(buffer, '\0', length) != NULL) {
    free(buffer);
    throw_code(env, "EINVAL");
    return 0;
  }
  *result = buffer;
  return 1;
}

static int safe_leaf(const char *name) {
  return name != NULL && name[0] != '\0' && strcmp(name, ".") != 0 &&
         strcmp(name, "..") != 0 && strchr(name, '/') == NULL;
}

static int leaf_arg(napi_env env, napi_value value, char **result) {
  if (!string_arg(env, value, NAME_MAX, result)) return 0;
  if (!safe_leaf(*result)) {
    free(*result);
    *result = NULL;
    throw_code(env, "EINVAL");
    return 0;
  }
  return 1;
}

static int safe_open_arguments(int flags, int mode) {
  const int allowed = O_ACCMODE | O_CREAT | O_EXCL | O_DIRECTORY | O_NOFOLLOW;
  const int access = flags & O_ACCMODE;
  if ((flags & ~allowed) != 0 || (access != O_RDONLY && access != O_RDWR) ||
      (flags & O_NOFOLLOW) == 0) {
    return 0;
  }
  if ((flags & O_DIRECTORY) != 0)
    return access == O_RDONLY && (flags & (O_CREAT | O_EXCL)) == 0 && mode == 0;
  if ((flags & O_CREAT) != 0)
    return access == O_RDWR && (flags & O_EXCL) != 0 && mode == 0600;
  return (flags & O_EXCL) == 0 && mode == 0;
}

static napi_value owned_fd_number(napi_env env, int fd, const char *stage) {
  napi_value result;
  if (!private_storage_invoke_test_hook(env, stage)) {
    close(fd);
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) return NULL;
    return throw_code(env, "EIO");
  }
  if (napi_create_double(env, (double)fd, &result) != napi_ok) {
    close(fd);
    return throw_code(env, "EIO");
  }
  return result;
}

static napi_value undefined(napi_env env) {
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return throw_code(env, "EIO");
  return result;
}

static napi_value open_directory_path(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  char *absolute_path = NULL;
  if (!exact_args(env, info, 1, argv) ||
      !string_arg(env, argv[0], PATH_MAX, &absolute_path))
    return NULL;
  if (absolute_path[0] != '/') {
    free(absolute_path);
    return throw_code(env, "EINVAL");
  }

  int current = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (current < 0) {
    free(absolute_path);
    return throw_errno(env);
  }
  char *save = NULL;
  char *component = strtok_r(absolute_path, "/", &save);
  while (component != NULL) {
    if (!safe_leaf(component)) {
      close(current);
      free(absolute_path);
      return throw_code(env, "EINVAL");
    }
    const int next = openat(
        current, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) {
      close(current);
      free(absolute_path);
      return throw_errno(env);
    }
    close(current);
    current = next;
    component = strtok_r(NULL, "/", &save);
  }
  free(absolute_path);
  return owned_fd_number(env, current, "open-directory-result");
}

static napi_value open_at(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  int directory_fd;
  int flags;
  int mode;
  char *name = NULL;
  if (!exact_args(env, info, 4, argv) ||
      !integer_arg(env, argv[0], INT_MAX, &directory_fd) ||
      !leaf_arg(env, argv[1], &name) ||
      !integer_arg(env, argv[2], INT_MAX, &flags) ||
      !integer_arg(env, argv[3], 0777, &mode)) {
    free(name);
    return NULL;
  }
  if (!safe_open_arguments(flags, mode)) {
    free(name);
    return throw_code(env, "EINVAL");
  }
  const int fd = openat(directory_fd, name, flags | O_CLOEXEC, mode);
  free(name);
  if (fd < 0) return throw_errno(env);
  return owned_fd_number(env, fd, "open-at-result");
}

static napi_value mkdir_at(napi_env env, napi_callback_info info) {
  napi_value argv[3];
  int directory_fd;
  int mode;
  char *name = NULL;
  if (!exact_args(env, info, 3, argv) ||
      !integer_arg(env, argv[0], INT_MAX, &directory_fd) ||
      !leaf_arg(env, argv[1], &name) ||
      !integer_arg(env, argv[2], 0777, &mode)) {
    free(name);
    return NULL;
  }
  if (mode != 0700) {
    free(name);
    return throw_code(env, "EINVAL");
  }
  const int result = mkdirat(directory_fd, name, (mode_t)mode);
  free(name);
  if (result < 0) return throw_errno(env);
  return undefined(env);
}

#ifdef PRIVATE_STORAGE_TEST_HOOKS
static napi_value set_test_hook(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  if (!exact_args(env, info, 1, argv)) return NULL;
  addon_state *state = get_state(env);
  napi_valuetype type;
  napi_value null_value;
  bool is_null = false;
  if (state == NULL || napi_typeof(env, argv[0], &type) != napi_ok ||
      napi_get_null(env, &null_value) != napi_ok ||
      napi_strict_equals(env, argv[0], null_value, &is_null) != napi_ok ||
      (!is_null && type != napi_function))
    return throw_code(env, "EINVAL");
  if (state->test_hook != NULL) {
    napi_delete_reference(env, state->test_hook);
    state->test_hook = NULL;
  }
  if (!is_null && napi_create_reference(env, argv[0], 1, &state->test_hook) != napi_ok)
    return throw_code(env, "EIO");
  return undefined(env);
}
#endif

static napi_value publish_at(napi_env env, napi_callback_info info) {
  napi_value argv[5];
  int lock_fd;
  int source_fd;
  int target_directory_fd;
  int quarantine_directory_fd;
  char *target = NULL;
  if (!exact_args(env, info, 5, argv) ||
      !integer_arg(env, argv[0], INT_MAX, &lock_fd) ||
      !integer_arg(env, argv[1], INT_MAX, &source_fd) ||
      !integer_arg(env, argv[2], INT_MAX, &target_directory_fd) ||
      !integer_arg(env, argv[3], INT_MAX, &quarantine_directory_fd) ||
      !leaf_arg(env, argv[4], &target)) {
    free(target);
    return NULL;
  }
  struct stat source;
  struct stat target_directory;
  struct stat quarantine_directory;
  if (private_storage_validate_lock(lock_fd) < 0 || fstat(source_fd, &source) < 0 ||
      fstat(target_directory_fd, &target_directory) < 0 ||
      fstat(quarantine_directory_fd, &quarantine_directory) < 0) {
    free(target);
    return throw_errno(env);
  }
  if (!S_ISREG(source.st_mode) || source.st_size < 0 ||
      !S_ISDIR(target_directory.st_mode) ||
      !S_ISDIR(quarantine_directory.st_mode) ||
      target_directory.st_dev != quarantine_directory.st_dev ||
      (source.st_mode & 0777) != 0600) {
    free(target);
    return throw_code(env, "EINVAL");
  }
  const int retained_fd = openat(target_directory_fd, target,
                                 O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                                 0600);
  if (retained_fd < 0) {
    free(target);
    return throw_errno(env);
  }
  if (!private_storage_invoke_test_hook(env, "publish-created")) {
    private_storage_cleanup_owned_links(env, target_directory_fd,
                                        quarantine_directory_fd, retained_fd);
    close(retained_fd);
    free(target);
    return NULL;
  }
  struct stat retained;
  int publication_error = 0;
  if (fstat(retained_fd, &retained) < 0)
    publication_error = errno;
  else if (!S_ISREG(retained.st_mode) || retained.st_size != 0 ||
           (retained.st_mode & 0777) != 0600)
    publication_error = EINVAL;
  if (publication_error != 0) {
    private_storage_cleanup_owned_links(env, target_directory_fd,
                                        quarantine_directory_fd, retained_fd);
    close(retained_fd);
    free(target);
    errno = publication_error;
    return throw_errno(env);
  }
  free(target);
  if (!private_storage_invoke_test_hook(env, "publish-result")) {
    private_storage_cleanup_owned_links(env, target_directory_fd,
                                        quarantine_directory_fd, retained_fd);
    close(retained_fd);
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && pending) return NULL;
    return throw_code(env, "EIO");
  }
  napi_value result_value;
  if (napi_create_double(env, (double)retained_fd, &result_value) != napi_ok) {
    private_storage_cleanup_owned_links(env, target_directory_fd,
                                        quarantine_directory_fd, retained_fd);
    close(retained_fd);
    return throw_code(env, "EIO");
  }
  return result_value;
}

static napi_value unlink_at(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  int directory_fd;
  char *name = NULL;
  if (!exact_args(env, info, 2, argv) ||
      !integer_arg(env, argv[0], INT_MAX, &directory_fd) ||
      !leaf_arg(env, argv[1], &name)) {
    free(name);
    return NULL;
  }
  const int result = unlinkat(directory_fd, name, 0);
  free(name);
  if (result < 0) return throw_errno(env);
  return undefined(env);
}

static int set_number_property(napi_env env, napi_value object, const char *name,
                               double value) {
  napi_value property;
  if (napi_create_double(env, value, &property) != napi_ok ||
      napi_set_named_property(env, object, name, property) != napi_ok) {
    throw_code(env, "EIO");
    return 0;
  }
  return 1;
}

static int set_bigint_property(napi_env env, napi_value object, const char *name,
                               uint64_t value) {
  napi_value property;
  if (napi_create_bigint_uint64(env, value, &property) != napi_ok ||
      napi_set_named_property(env, object, name, property) != napi_ok) {
    throw_code(env, "EIO");
    return 0;
  }
  return 1;
}

static napi_value stat_at(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  int directory_fd;
  char *name = NULL;
  if (!exact_args(env, info, 2, argv) ||
      !integer_arg(env, argv[0], INT_MAX, &directory_fd) ||
      !leaf_arg(env, argv[1], &name)) {
    free(name);
    return NULL;
  }
  struct stat metadata;
  const int result = fstatat(directory_fd, name, &metadata, AT_SYMLINK_NOFOLLOW);
  free(name);
  if (result < 0) return throw_errno(env);

  napi_value object;
  if (napi_create_object(env, &object) != napi_ok ||
      !set_bigint_property(env, object, "dev", (uint64_t)metadata.st_dev) ||
      !set_bigint_property(env, object, "ino", (uint64_t)metadata.st_ino) ||
      !set_number_property(env, object, "size", (double)metadata.st_size) ||
      !set_number_property(env, object, "links", (double)metadata.st_nlink) ||
      !set_number_property(env, object, "mode", (double)metadata.st_mode))
    return NULL;
  return object;
}

static napi_value initialize(napi_env env, napi_value exports) {
#ifdef PRIVATE_STORAGE_TEST_HOOKS
  addon_state *state = calloc(1, sizeof(*state));
  if (state == NULL ||
      napi_set_instance_data(env, state, finalize_state, NULL) != napi_ok) {
    free(state);
    return throw_code(env, "EIO");
  }
#endif
  napi_property_descriptor properties[] = {
      {"openDirectoryPath", NULL, open_directory_path, NULL, NULL, NULL, napi_default, NULL},
      {"openAt", NULL, open_at, NULL, NULL, NULL, napi_default, NULL},
      {"mkdirAt", NULL, mkdir_at, NULL, NULL, NULL, napi_default, NULL},
      {"publishAt", NULL, publish_at, NULL, NULL, NULL, napi_default, NULL},
      {"lockDirectory", NULL, private_storage_lock_directory, NULL, NULL, NULL,
       napi_default, NULL},
      {"lockTempFile", NULL, private_storage_lock_temp_file, NULL, NULL, NULL,
       napi_default, NULL},
      {"unlinkOwnedAt", NULL, private_storage_unlink_owned_at, NULL, NULL, NULL,
       napi_default, NULL},
      {"recoverTempAt", NULL, private_storage_recover_temp_at, NULL, NULL, NULL,
       napi_default, NULL},
      {"unlinkAt", NULL, unlink_at, NULL, NULL, NULL, napi_default, NULL},
      {"statAt", NULL, stat_at, NULL, NULL, NULL, napi_default, NULL},
#ifdef PRIVATE_STORAGE_TEST_HOOKS
      {"setTestHook", NULL, set_test_hook, NULL, NULL, NULL, napi_default, NULL},
#endif
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]),
                             properties) != napi_ok)
    return throw_code(env, "EIO");
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
