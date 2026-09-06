package com.senderrr.app.runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.senderrr.app.MainActivity
import com.senderrr.app.R

/**
 * The persistent notification Android requires a foreground service to show.
 *
 * It is not a formality here: it is the only place the client sees whether
 * their server is up without opening the app, so it states the actual state
 * rather than a generic "Senderrr is running".
 */
object RuntimeNotifications {

    const val CHANNEL_ID = "senderrr.runtime"
    const val NOTIFICATION_ID = 1

    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.runtime_channel_name),
            // Low: this notification must be present, but it is a status line,
            // not something worth a sound at 3am.
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.runtime_channel_description)
            setShowBadge(false)
        }
        context.getSystemService(NotificationManager::class.java)
            .createNotificationChannel(channel)
    }

    fun build(context: Context, state: RuntimeState): Notification {
        val openApp = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(describe(context, state))
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(openApp)
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun describe(context: Context, state: RuntimeState): String = when (state) {
        RuntimeState.Starting -> context.getString(R.string.runtime_status_starting)
        RuntimeState.Running -> context.getString(R.string.runtime_status_running)
        RuntimeState.Stopped -> context.getString(R.string.runtime_status_stopped)
        is RuntimeState.Failed -> context.getString(R.string.runtime_status_failed, state.reason)
    }
}
