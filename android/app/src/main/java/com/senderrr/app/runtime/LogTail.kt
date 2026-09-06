package com.senderrr.app.runtime

import android.content.Context
import android.os.FileObserver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import java.io.File

/**
 * A live read-only tail of what the embedded Node runtime is printing.
 *
 * It reads the rolling file the JNI bridge writes, not `logcat`. That was the
 * obvious first choice and it does not work: an app may only read its own
 * logcat buffer, and OEM builds refuse even that — on this project's own Vivo
 * test device `logcat` exits immediately with "Unexpected EOF", so the screen
 * showed nothing but reconnect notices. A file the app writes itself is
 * readable on every device, survives both processes restarting, keeps more
 * history than the shared log buffer, and gives "Copy logs" something real to
 * copy.
 *
 * Read-only by design (ADR-8): the Advanced screen shows what is happening and
 * offers a few named actions. It is not a shell. A real interactive terminal on
 * a client's phone is a security surface this does not need, and the decision to
 * revisit it later is recorded in the ADR rather than quietly pre-empted here.
 */
class LogTail(context: Context) {

    private val logFile: File = BundleLayout(context).logFile

    /** Emits the tail of the log, then the whole tail again on every change. */
    fun stream(): Flow<List<String>> = callbackFlow {
        trySend(readTail())

        // The runtime writes from its own process, so this watches the
        // directory: the file may not exist yet when the screen opens, and it
        // is replaced outright when it rotates.
        val directory = logFile.parentFile ?: return@callbackFlow
        directory.mkdirs()

        @Suppress("DEPRECATION")  // File-taking constructor is API 29; minSdk is 28.
        val observer = object : FileObserver(directory.path, MODIFY or CREATE or MOVED_TO) {
            override fun onEvent(event: Int, path: String?) {
                if (path == logFile.name) trySend(readTail())
            }
        }
        observer.startWatching()
        awaitClose { observer.stopWatching() }
    }.flowOn(Dispatchers.IO)

    private fun readTail(): List<String> =
        runCatching { logFile.readLines().takeLast(MAX_LINES) }.getOrDefault(emptyList())

    private companion object {
        const val MAX_LINES = 500
    }
}
