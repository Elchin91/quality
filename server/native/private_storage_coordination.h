#ifndef PRIVATE_STORAGE_COORDINATION_H
#define PRIVATE_STORAGE_COORDINATION_H

#include <node_api.h>

int private_storage_invoke_test_hook(napi_env env, const char *stage);
int private_storage_validate_lock(int lock_fd);
napi_value private_storage_lock_directory(napi_env env, napi_callback_info info);
napi_value private_storage_lock_temp_file(napi_env env, napi_callback_info info);
napi_value private_storage_unlink_owned_at(napi_env env, napi_callback_info info);
napi_value private_storage_recover_temp_at(napi_env env, napi_callback_info info);

#endif
