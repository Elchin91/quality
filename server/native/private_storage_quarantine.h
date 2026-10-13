#ifndef PRIVATE_STORAGE_QUARANTINE_H
#define PRIVATE_STORAGE_QUARANTINE_H

#include <node_api.h>

int private_storage_cleanup_owned_links(napi_env env, int directory_fd,
                                        int quarantine_directory_fd, int owned_fd);
int private_storage_recover_quarantine_files(int quarantine_directory_fd);
int private_storage_recover_temp_files(napi_env env, int directory_fd,
                                       int quarantine_directory_fd);

#endif
