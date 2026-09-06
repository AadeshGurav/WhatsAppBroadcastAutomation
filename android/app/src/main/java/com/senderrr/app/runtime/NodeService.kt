package com.senderrr.app.runtime

import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.ServiceCompat
import com.senderrr.app.R
import kotlin.concurrent.thread

/**
 * Hosts the embedded Node runtime for as long as the client wants their server
 * up (PRD commit 8).
 *
 * It runs in its own `:noderuntime` process, declared in the manifest. That is
 * ADR-4's decision, and the reason is specific: `node::Start()` may terminate
 * the process outright on a fatal error, so sharing a process with the UI would
 * mean a Node-side crash takes away the very screen the client needs to see
 * that something went wrong. Isolated, a crash costs the runtime only, and the
 * watchdog in the UI process brings it back (PRD commit 9).
 */
class NodeService : Service() {

    private lateinit var bundle: BundleLayout
    private var wakeLock: PowerManager.WakeLock? = null

    @Volatile
    private var state: RuntimeState = RuntimeState.Stopped

    override fun onCreate() {
        super.onCreate()
        bundle = BundleLayout(this)
        RuntimeNotifications.ensureChannel(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopRuntime()
                return START_NOT_STICKY
            }
            else -> startRuntime()
        }
        // START_STICKY so Android's own restart-after-kill applies too; the
        // watchdog covers the cases it does not (ADR-4).
        return START_STICKY
    }

    /**
     * The watchdog binds purely to hold a death recipient on this token: when
     * the `:noderuntime` process goes away, however it goes away, the binder
     * dies with it and the UI process finds out (ADR-4). There is deliberately
     * no method on it — cross-process status reporting arrives with the Home
     * screen, and an interface invented before it has a caller would be guessed,
     * not designed.
     */
    override fun onBind(intent: Intent?): IBinder = lifetimeToken

    private val lifetimeToken = Binder()

    private fun startRuntime() {
        if (state.isActive) return

        moveToState(RuntimeState.Starting, foreground = true)

        if (!NodeRuntime.isAvailable) {
            fail(getString(R.string.runtime_error_no_library))
            return
        }
        if (!bundle.isInstalled) {
            // Expected on a fresh install until the bundle loader lands
            // (PRD commit 10) — a plain statement, not a crash.
            fail(getString(R.string.runtime_error_no_bundle))
            return
        }

        acquireWakeLock()

        // node::Start() blocks for the life of the server, so it gets its own
        // thread; the service's main looper stays free to handle stop intents.
        thread(name = "senderrr-node", isDaemon = false) {
            val exitCode = try {
                moveToState(RuntimeState.Running)
                NodeRuntime.runScript(bundle.entryPoint.absolutePath)
            } catch (error: Throwable) {
                Log.e(TAG, "The Node runtime stopped with an error.", error)
                fail(error.message ?: error::class.java.simpleName)
                return@thread
            }

            // Reaching here at all means Node's event loop drained, which for a
            // long-running server is itself the failure worth reporting.
            Log.w(TAG, "Node exited with code $exitCode")
            fail(getString(R.string.runtime_error_exited, exitCode))
        }
    }

    private fun stopRuntime() {
        moveToState(RuntimeState.Stopped)
        releaseWakeLock()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun fail(reason: String) {
        Log.e(TAG, "Runtime failed: $reason")
        moveToState(RuntimeState.Failed(reason))
        releaseWakeLock()
        // The notification stays: a server that stopped is exactly when the
        // client most needs to be told, and a silently dismissed notification
        // reads as "everything is fine".
    }

    private fun moveToState(next: RuntimeState, foreground: Boolean = false) {
        state = next
        val notification = RuntimeNotifications.build(this, next)

        if (foreground) {
            ServiceCompat.startForeground(
                this,
                RuntimeNotifications.NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            getSystemService(android.app.NotificationManager::class.java)
                .notify(RuntimeNotifications.NOTIFICATION_ID, notification)
        }
    }

    /**
     * Keeps the CPU awake while the server is meant to be serving. Without it
     * the phone sleeps and the client's broadcasts stop at 2am with no error
     * anywhere — the failure this whole deployment exists to avoid.
     *
     * Held without a timeout on purpose, against lint's default advice: a
     * timeout is the right answer for work that finishes, and this work does
     * not. The bound on it is the service's own lifetime — every exit path
     * below releases it.
     */
    @SuppressLint("WakelockTimeout")
    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG)
            .apply { setReferenceCounted(false); acquire() }
    }

    private fun releaseWakeLock() {
        wakeLock?.takeIf { it.isHeld }?.release()
        wakeLock = null
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "SenderrrService"
        private const val WAKE_LOCK_TAG = "Senderrr:NodeRuntime"

        const val ACTION_START = "com.senderrr.app.action.START_RUNTIME"
        const val ACTION_STOP = "com.senderrr.app.action.STOP_RUNTIME"

        fun start(context: Context) {
            context.startForegroundService(
                Intent(context, NodeService::class.java).setAction(ACTION_START)
            )
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, NodeService::class.java).setAction(ACTION_STOP)
            )
        }
    }
}
