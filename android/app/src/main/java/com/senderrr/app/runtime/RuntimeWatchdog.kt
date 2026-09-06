package com.senderrr.app.runtime

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log

/**
 * Brings the runtime process back when it dies unexpectedly (PRD commit 9,
 * ADR-4).
 *
 * This is what the Termux deployment gets free from `pm2 resurrect` today. An
 * in-process embed has no equivalent: `node::Start()` can terminate the
 * `:noderuntime` process outright, bypassing Android's lifecycle entirely, and
 * nothing would notice. So the UI process binds to the service and registers a
 * death recipient on its binder — the only signal that reliably fires however
 * the process went away.
 *
 * Restarts back off, because a runtime that crashes on startup would otherwise
 * be relaunched in a tight loop that flattens the battery without ever
 * succeeding — and the client would see a phone that is hot, dead by noon, and
 * still not serving.
 */
class RuntimeWatchdog(private val context: Context) {

    private val preferences = RuntimePreferences(context)
    private val handler = Handler(Looper.getMainLooper())

    private var boundBinder: IBinder? = null
    private var consecutiveCrashes = 0

    private val deathRecipient = IBinder.DeathRecipient {
        // Called on a binder thread; every decision below belongs on main.
        handler.post(::onRuntimeProcessDied)
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            boundBinder = binder?.also { it.linkToDeath(deathRecipient, 0) }
            // Surviving long enough to connect is the only evidence we get that
            // the last restart actually worked, so the backoff resets here.
            consecutiveCrashes = 0
            Log.i(TAG, "Runtime process is up; watching it.")
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            // The death recipient above owns the recovery decision; this only
            // records that the framework saw the same event.
            Log.w(TAG, "Runtime process disconnected.")
        }
    }

    /** Starts watching. Binding with no flags observes the service without creating it. */
    fun start() {
        context.bindService(Intent(context, NodeService::class.java), connection, 0)
    }

    fun stop() {
        unlinkBinder()
        runCatching { context.unbindService(connection) }
    }

    private fun onRuntimeProcessDied() {
        unlinkBinder()

        if (!preferences.shouldRun) {
            Log.i(TAG, "Runtime process ended and the client had stopped it. Leaving it down.")
            return
        }

        consecutiveCrashes++
        val delayMillis = restartDelayMillis(consecutiveCrashes)
        Log.w(
            TAG,
            "Runtime process died unexpectedly (crash #$consecutiveCrashes). " +
                "Restarting it in ${delayMillis / 1000}s.",
        )

        handler.postDelayed({
            if (preferences.shouldRun) {
                NodeService.start(context)
                context.bindService(Intent(context, NodeService::class.java), connection, 0)
            }
        }, delayMillis)
    }

    private fun unlinkBinder() {
        boundBinder?.let { runCatching { it.unlinkToDeath(deathRecipient, 0) } }
        boundBinder = null
    }

    /** 2s, 4s, 8s… capped at a minute, so a permanently broken bundle idles instead of thrashing. */
    private fun restartDelayMillis(crashCount: Int): Long =
        (FIRST_RESTART_DELAY_MS shl (crashCount - 1).coerceAtMost(5))
            .coerceAtMost(MAX_RESTART_DELAY_MS)

    private companion object {
        const val TAG = "SenderrrWatchdog"
        const val FIRST_RESTART_DELAY_MS = 2_000L
        const val MAX_RESTART_DELAY_MS = 60_000L
    }
}
