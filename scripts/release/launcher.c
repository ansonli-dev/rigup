#define _XOPEN_SOURCE 700
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>
#include <errno.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

int main(int argc, char **argv) {
    char root[PATH_MAX];
#ifdef __APPLE__
    char executable[PATH_MAX];
    uint32_t size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &size) != 0 || realpath(executable, root) == NULL) {
        fprintf(stderr, "rigup: cannot locate the portable installation\n"); return 127;
    }
#else
    ssize_t size = readlink("/proc/self/exe", root, sizeof(root) - 1);
    if (size < 0 || (size_t)size >= sizeof(root) - 1) {
        fprintf(stderr, "rigup: cannot locate the portable installation\n"); return 127;
    }
    root[size] = '\0';
#endif
    char *slash = strrchr(root, '/');
    if (slash == NULL) { fprintf(stderr, "rigup: invalid installation path\n"); return 127; }
    *slash = '\0';
    const char *runtime_suffix = "/lib/node/bin";
    const char *script_suffix = "/lib/app/dist/cli.js";
    size_t length = strlen(root) + strlen(runtime_suffix) + 1;
    char *runtime = malloc(length);
    char *node = malloc(length + 5);
    char *script = malloc(strlen(root) + strlen(script_suffix) + 1);
    if (!runtime || !node || !script) { fprintf(stderr, "rigup: out of memory\n"); return 127; }
    snprintf(runtime, length, "%s%s", root, runtime_suffix);
    snprintf(node, length + 5, "%s/node", runtime);
    sprintf(script, "%s%s", root, script_suffix);
    if (access(node, X_OK) != 0 || access(script, R_OK) != 0) {
        fprintf(stderr, "rigup: incomplete portable installation; keep rigup with its lib directory and extract the complete archive\n"); return 127;
    }
    const char *old_path = getenv("PATH");
    size_t path_length = strlen(runtime) + (old_path ? strlen(old_path) : 0) + 2;
    char *path = malloc(path_length);
    char **args = calloc((size_t)argc + 2, sizeof(char *));
    if (!path || !args) { fprintf(stderr, "rigup: out of memory\n"); return 127; }
    snprintf(path, path_length, "%s%s%s", runtime, old_path && *old_path ? ":" : "", old_path ? old_path : "");
    if (setenv("PATH", path, 1) != 0) { perror("rigup: PATH"); return 127; }
    args[0] = node; args[1] = script;
    for (int i = 1; i < argc; i++) args[i + 1] = argv[i];
    execv(node, args);
    fprintf(stderr, "rigup: cannot execute bundled runtime: %s\n", strerror(errno));
    return 127;
}
