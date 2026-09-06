package com.senderrr.app

import android.app.Application
import com.senderrr.app.runtime.RuntimeWatchdog

/**
 * Application entry point for both of the app's processes.
 *
 * The watchdog belongs to the UI process only. Starting it in `:noderuntime`
 * would put the thing that recovers from a crash inside the process that
 * crashes — which is the failure ADR-4 split the processes to avoid in the
 * first place.
 */
class SenderrrApplication : Application() {

    lateinit var watchdog: RuntimeWatchdog
        private set

    override fun onCreate() {
        super.onCreate()
        if (isRuntimeProcess()) return

        watchdog = RuntimeWatchdog(this)
        watchdog.start()
    }

    private fun isRuntimeProcess(): Boolean =
        getProcessName().endsWith(RUNTIME_PROCESS_SUFFIX)

    private companion object {
        const val RUNTIME_PROCESS_SUFFIX = ":noderuntime"
    }
}
