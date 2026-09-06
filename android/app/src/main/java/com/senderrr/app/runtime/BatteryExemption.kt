package com.senderrr.app.runtime

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/**
 * The one system permission this app genuinely cannot work without (PRD
 * commit 11).
 *
 * Android's battery optimiser will eventually stop a background process that
 * runs all day, and an OEM's own manager is more aggressive still. Without the
 * exemption the client's server dies quietly some hours after they stop looking
 * at it, which is the single worst failure this deployment can have: it looks
 * exactly like everything being fine.
 *
 * `setup-android.sh` walks a Termux user through the Settings screens by hand.
 * Here the system asks in one dialog.
 */
object BatteryExemption {

    fun isGranted(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java)
            .isIgnoringBatteryOptimizations(context.packageName)

    /**
     * The system's own request dialog. Not a link into Settings: a dialog the
     * client can answer where they are is the difference between a step that
     * gets done and one that gets abandoned.
     */
    @SuppressLint("BatteryLife")  // Play policy; this app is sideloaded (ADR-7).
    fun requestIntent(context: Context): Intent =
        Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.fromParts("package", context.packageName, null),
        )
}
