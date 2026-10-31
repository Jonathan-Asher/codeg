/*
 * codeg-talk, for builds that can't run Talk on the Mac (an Intel or
 * universal Intel slice, or CODEG_SKIP_TALK_SIDECAR=1). It speaks enough of
 * the helper's protocol for codeg to see Talk is unavailable: --probe says
 * so ("stub": true, "whisperLoads": false), and a normal start says hello,
 * then ends with the reason, and exits.
 */
#include <stdio.h>
#include <string.h>
#include <sys/sysctl.h>

static void macos_version(char *out, size_t size) {
    size_t len = size;
    if (sysctlbyname("kern.osproductversion", out, &len, NULL, 0) != 0) {
        snprintf(out, size, "unknown");
    }
}

int main(int argc, char **argv) {
#if defined(__arm64__)
    const char *arm64 = "true";
#else
    const char *arm64 = "false";
#endif
    char version[64] = {0};
    macos_version(version, sizeof(version));
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--version") == 0) {
            printf("codeg-talk stub, protocol 1\n");
            return 0;
        }
        if (strcmp(argv[i], "--probe") == 0) {
            printf("{\"arm64\":%s,\"macos\":\"%s\",\"mic\":\"undetermined\",\"protocol\":1,"
                   "\"stub\":true,\"version\":\"stub\",\"whisperLoads\":false}\n", arm64, version);
            return 0;
        }
    }
    printf("{\"mic\":\"undetermined\",\"protocol\":1,\"type\":\"hello\",\"version\":\"stub\"}\n");
    printf("{\"error\":\"This build of codeg has no Talk on the Mac (it needs Apple Silicon and macOS 15).\","
           "\"reason\":\"failed\",\"type\":\"ended\"}\n");
    fflush(stdout);
    return 3;
}
