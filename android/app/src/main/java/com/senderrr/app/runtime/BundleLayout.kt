package com.senderrr.app.runtime

import android.content.Context
import java.io.File

/**
 * Where the Senderrr application bundle — the compiled `dist/` plus
 * `node_modules` — lives on the device, and nothing about how it gets there.
 *
 * The PRD's four layers keep separate lifecycles (§4): the shell is replaced by
 * an APK install, the bundle by an OTA swap, the data never. Keeping the paths
 * in one place is what lets the updater (PRD commit 24) swap [current] by
 * renaming a directory instead of copying over a running one.
 */
class BundleLayout(context: Context) {

    private val root = File(context.filesDir, "bundle")

    /** The live bundle the runtime executes from. */
    val current: File = File(root, "current")

    /** Where an update is unpacked and verified before it is swapped in. */
    val staging: File = File(root, "staging")

    /** The bundle [current] replaced, kept so a failed health check can roll back. */
    val previous: File = File(root, "previous")

    /** The script handed to `node`, i.e. the NestJS app's compiled entry point. */
    val entryPoint: File = File(current, "dist/main.js")

    val isInstalled: Boolean get() = entryPoint.isFile
}
