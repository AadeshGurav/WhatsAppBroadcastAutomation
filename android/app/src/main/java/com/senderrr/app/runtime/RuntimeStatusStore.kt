package com.senderrr.app.runtime

import android.content.Context
import android.os.FileObserver
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import java.io.File

/**
 * Carries the runtime's state from the `:noderuntime` process to the UI process.
 *
 * A single small file, written by the runtime and watched by the UI. That is
 * deliberately less machinery than a bound AIDL interface, and it earns the
 * difference: there is exactly one writer and one reader, the payload is one
 * line, the value survives either process being restarted — which a live binder
 * does not — and when something looks wrong the file can simply be read.
 *
 * The binder the watchdog holds answers a different question: whether the
 * runtime process is *alive*. This answers what it is *doing*.
 */
class RuntimeStatusStore(context: Context) {

    private val file = File(context.filesDir, FILE_NAME)

    fun publish(state: RuntimeState) {
        val line = when (state) {
            RuntimeState.Stopped -> "stopped"
            RuntimeState.Starting -> "starting"
            RuntimeState.Running -> "running"
            is RuntimeState.Failed -> "failed\n${state.reason}"
        }
        // Write then rename, so a reader never sees a half-written state.
        val pending = File(file.parentFile, "$FILE_NAME.pending")
        pending.writeText(line)
        pending.renameTo(file)
    }

    fun read(): RuntimeState {
        if (!file.isFile) return RuntimeState.Stopped
        val lines = runCatching { file.readLines() }.getOrDefault(emptyList())
        return when (lines.firstOrNull()) {
            "starting" -> RuntimeState.Starting
            "running" -> RuntimeState.Running
            "failed" -> RuntimeState.Failed(lines.drop(1).joinToString("\n").ifEmpty { "unknown" })
            else -> RuntimeState.Stopped
        }
    }

    /** Emits the current state, then every change to it. */
    fun observe(): Flow<RuntimeState> = callbackFlow {
        trySend(read())

        // The File-taking constructor is API 29; this app supports 28 (ADR-3),
        // so it uses the older path-taking one, which behaves identically.
        @Suppress("DEPRECATION")
        val observer = object : FileObserver(file.parent!!, MOVED_TO or CLOSE_WRITE) {
            override fun onEvent(event: Int, path: String?) {
                if (path == FILE_NAME) trySend(read())
            }
        }
        observer.startWatching()
        awaitClose { observer.stopWatching() }
    }

    private companion object {
        const val FILE_NAME = "runtime.state"
    }
}
