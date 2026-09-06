package com.senderrr.app.runtime

import android.util.Log

/**
 * The Kotlin side of the JNI bridge into the embedded Node runtime (PRD ADR-3).
 *
 * [runScript] blocks for as long as Node's event loop has work — which, for the
 * Senderrr server, is forever. Call it from a dedicated thread in the
 * `:noderuntime` process, never from the main thread.
 *
 * One start per process. V8 and libuv are initialised process-globally by
 * `node::Start()`, and Node may terminate the process outright on a fatal error
 * rather than returning (ADR-4) — which is exactly why restarting the runtime
 * means restarting that process, a job for the watchdog (PRD commit 9), not for
 * a retry loop here.
 */
object NodeRuntime {

    private const val TAG = "SenderrrNode"

    /**
     * Null once both libraries are in memory; otherwise the reason they aren't,
     * kept so callers can show the client something better than a crash.
     */
    val loadFailure: Throwable?

    init {
        loadFailure = try {
            // libnode first: the bridge links against it, so it has to be
            // resolvable before the bridge itself loads.
            System.loadLibrary("node")
            System.loadLibrary("senderrr_node")
            null
        } catch (error: UnsatisfiedLinkError) {
            Log.e(TAG, "The Node runtime library could not be loaded.", error)
            error
        }
    }

    val isAvailable: Boolean get() = loadFailure == null

    /**
     * Runs [scriptPath] to completion in the embedded runtime and returns Node's
     * exit code, or throws if the native libraries never loaded.
     *
     * [workingDirectory] becomes the process's cwd before Node starts, because
     * the server resolves its config, database and media paths against it.
     * [logFile] receives everything Node prints, which is what the Advanced
     * screen tails.
     *
     * [nodeOptions] are passed to Node itself (before the script path);
     * [scriptArgs] reach the script as `process.argv` entries after it.
     */
    fun runScript(
        scriptPath: String,
        workingDirectory: String,
        logFile: String,
        nodeOptions: List<String> = emptyList(),
        scriptArgs: List<String> = emptyList(),
    ): Int {
        loadFailure?.let { throw IllegalStateException("Node runtime unavailable", it) }

        // argv[0] is the program name Node reports as process.execPath.
        val argv = buildList {
            add("node")
            addAll(nodeOptions)
            add(scriptPath)
            addAll(scriptArgs)
        }

        Log.i(TAG, "Starting Node with script $scriptPath in $workingDirectory")
        return nativeStart(workingDirectory, logFile, argv.toTypedArray())
    }

    private external fun nativeStart(
        workingDirectory: String,
        logFile: String,
        argv: Array<String>,
    ): Int
}
