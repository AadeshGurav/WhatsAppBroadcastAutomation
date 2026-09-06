package com.senderrr.app.runtime

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlin.coroutines.coroutineContext

/**
 * A live read-only tail of what the embedded Node runtime is printing.
 *
 * The JNI bridge pipes Node's stdout and stderr into logcat under one tag, so
 * the tail is `logcat` filtered to that tag — no second log pipeline, and the
 * same stream anyone debugging with `adb` would see.
 *
 * Read-only by design (ADR-8): the Advanced screen shows what is happening and
 * offers a few named actions. It is not a shell. A real interactive terminal on
 * a client's phone is a security surface this does not need, and the decision to
 * revisit it later is recorded in the ADR rather than quietly pre-empted here.
 */
object LogTail {

    private const val RUNTIME_TAG = "SenderrrNode"
    private const val MAX_LINES = 500

    /** Emits the recent history, then each new line as it is printed. */
    fun stream(): Flow<String> = flow {
        val process = ProcessBuilder(
            "logcat", "-T", MAX_LINES.toString(), "-s", "$RUNTIME_TAG:V",
        ).redirectErrorStream(true).start()

        try {
            process.inputStream.bufferedReader().useLines { lines ->
                for (line in lines) {
                    if (!coroutineContext.isActive) break
                    emit(line)
                }
            }
        } finally {
            process.destroy()
        }
    }.flowOn(Dispatchers.IO)
}
