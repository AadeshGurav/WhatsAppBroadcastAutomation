// JNI bridge from Kotlin into the embedded Node runtime (PRD commit 7, ADR-3).
//
// Two jobs, nothing else:
//   1. Turn a Kotlin String[] argv into the (int, char**) node::Start() wants.
//   2. Make Node's stdout/stderr visible, since a shared library writing to fd
//      1 and 2 on Android writes into a void nobody can read.
//
// Node's own lifecycle assumptions do not fit Android's (ADR-4): node::Start()
// blocks until the event loop drains and Node may call exit() outright. That is
// why the service hosting this lives in its own :noderuntime process with a
// watchdog over it, rather than being made safe here.

#include <android/log.h>
#include <jni.h>
#include <pthread.h>
#include <unistd.h>

#include <string>
#include <vector>

#include "node.h"

namespace {

constexpr const char* kLogTag = "SenderrrNode";

// Reads one end of a pipe forever, forwarding whole lines to logcat.
void* PumpPipeToLogcat(void* arg) {
    const int read_fd = static_cast<int>(reinterpret_cast<intptr_t>(arg));
    std::string line;
    char chunk[512];

    ssize_t count;
    while ((count = read(read_fd, chunk, sizeof(chunk))) > 0) {
        line.append(chunk, static_cast<size_t>(count));

        size_t newline;
        while ((newline = line.find('\n')) != std::string::npos) {
            __android_log_print(ANDROID_LOG_INFO, kLogTag, "%s",
                                line.substr(0, newline).c_str());
            line.erase(0, newline + 1);
        }
    }

    if (!line.empty()) {
        __android_log_print(ANDROID_LOG_INFO, kLogTag, "%s", line.c_str());
    }
    return nullptr;
}

// Redirects fds 1 and 2 into a pipe drained by a logcat-forwarding thread.
// Safe to call more than once: only the first call takes effect, so a runtime
// restart in the same process does not leak a thread per attempt.
bool RedirectStdioToLogcat() {
    static bool redirected = false;
    if (redirected) return true;

    int pipe_fds[2];
    if (pipe(pipe_fds) != 0) {
        __android_log_print(ANDROID_LOG_ERROR, kLogTag,
                            "Could not create the stdout/stderr pipe; Node's "
                            "output will not reach logcat.");
        return false;
    }

    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    dup2(pipe_fds[1], STDOUT_FILENO);
    dup2(pipe_fds[1], STDERR_FILENO);

    pthread_t pump;
    if (pthread_create(&pump, nullptr, PumpPipeToLogcat,
                       reinterpret_cast<void*>(
                           static_cast<intptr_t>(pipe_fds[0]))) != 0) {
        __android_log_print(ANDROID_LOG_ERROR, kLogTag,
                            "Could not start the log pump thread.");
        return false;
    }
    pthread_detach(pump);

    redirected = true;
    return true;
}

std::vector<std::string> ReadJavaStringArray(JNIEnv* env, jobjectArray array) {
    std::vector<std::string> values;
    const jsize length = env->GetArrayLength(array);
    values.reserve(static_cast<size_t>(length));

    for (jsize i = 0; i < length; ++i) {
        auto element = static_cast<jstring>(env->GetObjectArrayElement(array, i));
        const char* chars = env->GetStringUTFChars(element, nullptr);
        values.emplace_back(chars);
        env->ReleaseStringUTFChars(element, chars);
        env->DeleteLocalRef(element);
    }
    return values;
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_com_senderrr_app_runtime_NodeRuntime_nativeStart(JNIEnv* env,
                                                      jobject /* this */,
                                                      jstring working_directory,
                                                      jobjectArray argv) {
    RedirectStdioToLogcat();

    // The server resolves its config, database and media paths against the
    // working directory, so it has to be set before Node starts rather than
    // left as whatever Android handed the process (which is "/").
    const char* cwd = env->GetStringUTFChars(working_directory, nullptr);
    const int chdir_result = chdir(cwd);
    if (chdir_result != 0) {
        __android_log_print(ANDROID_LOG_ERROR, kLogTag,
                            "Could not enter the working directory %s", cwd);
    }
    env->ReleaseStringUTFChars(working_directory, cwd);
    if (chdir_result != 0) return -1;

    std::vector<std::string> args = ReadJavaStringArray(env, argv);
    if (args.empty()) {
        __android_log_print(ANDROID_LOG_ERROR, kLogTag,
                            "Refusing to start: argv was empty, so there is no "
                            "script for Node to run.");
        return -1;
    }

    // node::Start() takes a mutable char** and may rewrite the argv strings in
    // place, so it gets pointers into our own copies, not into the JVM's.
    std::vector<char*> raw_argv;
    raw_argv.reserve(args.size());
    for (std::string& arg : args) {
        raw_argv.push_back(arg.data());
    }

    __android_log_print(ANDROID_LOG_INFO, kLogTag, "Starting Node: %s",
                        args.size() > 1 ? args[1].c_str() : "(no script)");

    const int exit_code =
        node::Start(static_cast<int>(raw_argv.size()), raw_argv.data());

    __android_log_print(ANDROID_LOG_INFO, kLogTag, "Node exited with code %d",
                        exit_code);
    return exit_code;
}
