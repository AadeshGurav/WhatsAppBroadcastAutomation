package com.senderrr.app.runtime

import android.content.Context
import java.io.File

/**
 * Where the Senderrr application bundle lives on the device, and where the
 * server runs from — two different places, on purpose.
 *
 * The PRD's four layers keep separate lifecycles (§4): the shell is replaced by
 * an APK install, the bundle by an OTA swap, the data never. So the bundle
 * directory holds only replaceable code, and [workingDirectory] — the process's
 * cwd, where the server writes `data/`, its databases and its WhatsApp
 * credentials — sits outside it. An update renames [current] and the client's
 * data is not in the blast radius.
 *
 * [workingDirectory] reaches the bundle through relative symlinks, so a swap
 * needs no relinking: the names stay, the directory behind them changes.
 */
class BundleLayout(context: Context) {

    private val root = File(context.filesDir, "bundle")

    /** The live bundle the runtime executes. */
    val current: File = File(root, "current")

    /** Where an update is unpacked and verified before it is swapped in. */
    val staging: File = File(root, "staging")

    /** The bundle [current] replaced, kept so a failed health check can roll back. */
    val previous: File = File(root, "previous")

    /** Which bundle is installed, so a reinstall is skipped and an upgrade is not. */
    val versionMarker: File = File(root, "installed.version")

    /** The server's cwd. Everything the client would hate to lose is under here. */
    val workingDirectory: File = File(context.filesDir, "runtime")

    /**
     * The script handed to `node`, reached through [workingDirectory]'s `dist`
     * symlink. Node resolves the symlink before looking for `node_modules`, so
     * requires land in the bundle where the packages actually are.
     */
    val entryPoint: File = File(workingDirectory, "dist/src/main.js")

    /** The bundle entries [workingDirectory] links to, named as the server expects them. */
    val linkedEntries: List<String> = listOf("dist", "node_modules", "dashboard-ui", "package.json")

    val isInstalled: Boolean get() = entryPoint.isFile
}
