package com.senderrr.app.runtime

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Brings the server back after the phone reboots (PRD commit 11).
 *
 * A phone that reboots overnight — an OS update, a flat battery, a power cut —
 * must not need the client to notice and reopen the app. The Termux deployment
 * needs Termux:Boot installed and configured by hand for this; here it is one
 * manifest entry.
 *
 * It restarts only what the client asked to have running, so a server they
 * deliberately stopped stays stopped across a reboot.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        if (!RuntimePreferences(context).shouldRun) {
            Log.i(TAG, "Booted, and the client had stopped the server. Leaving it stopped.")
            return
        }

        Log.i(TAG, "Booted; restarting the server.")
        NodeService.start(context)
    }

    private companion object {
        const val TAG = "SenderrrBoot"
    }
}
