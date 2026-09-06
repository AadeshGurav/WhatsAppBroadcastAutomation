package com.senderrr.app.runtime

import android.content.Context
import android.util.Log
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Paths
import java.util.zip.ZipInputStream

/**
 * Unpacks the Senderrr application bundle shipped inside the APK into app
 * storage, on first run and after an APK update (PRD commit 10).
 *
 * This is the install path only. Downloading and swapping a newer bundle
 * without reinstalling the APK is the updater's job (ADR-6, PRD commits 23-25);
 * both write into the same [BundleLayout], which is why the layout owns the
 * paths and neither of them invents its own.
 */
class BundleInstaller(private val context: Context) {

    private val layout = BundleLayout(context)

    sealed interface Result {
        data object AlreadyInstalled : Result
        data class Installed(val version: String) : Result
        data class Failed(val reason: String) : Result
    }

    fun install(): Result {
        val version = readPackagedVersion()
            ?: return Result.Failed("This build has no server software packaged in it.")

        if (layout.isInstalled && layout.versionMarker.takeIf { it.isFile }?.readText() == version) {
            return Result.AlreadyInstalled
        }

        return try {
            Log.i(TAG, "Installing bundle $version")
            layout.staging.deleteRecursively()
            extractPackagedBundle(into = layout.staging)
            swapIntoPlace()
            linkWorkingDirectory()
            layout.versionMarker.writeText(version)
            Log.i(TAG, "Bundle $version installed.")
            Result.Installed(version)
        } catch (error: IOException) {
            // Leave whatever was working in place rather than half-replacing it:
            // a client on an older bundle is far better off than one on none.
            Log.e(TAG, "Bundle install failed; keeping the previous one.", error)
            layout.staging.deleteRecursively()
            Result.Failed(error.message ?: "the server software could not be unpacked")
        }
    }

    private fun readPackagedVersion(): String? = runCatching {
        context.assets.open(VERSION_ASSET).bufferedReader().use { it.readText().trim() }
    }.getOrNull()?.takeIf { it.isNotEmpty() }

    private fun extractPackagedBundle(into: File) {
        into.mkdirs()
        val root = into.canonicalFile

        context.assets.open(BUNDLE_ASSET).use { asset ->
            ZipInputStream(asset.buffered()).use { zip ->
                generateSequence { zip.nextEntry }.forEach { entry ->
                    val target = File(into, entry.name).canonicalFile

                    // A zip entry naming "../" would otherwise write anywhere the
                    // app can reach. The bundle is ours, but an OTA one may not
                    // stay that way, and this installer is the shared path.
                    if (!target.path.startsWith(root.path + File.separator)) {
                        throw IOException("Bundle entry escapes its directory: ${entry.name}")
                    }

                    if (entry.isDirectory) {
                        target.mkdirs()
                    } else {
                        target.parentFile?.mkdirs()
                        target.outputStream().buffered().use { zip.copyTo(it) }
                    }
                    zip.closeEntry()
                }
            }
        }
    }

    /** Rename, never copy over a live directory: a swap is atomic, a copy is not. */
    private fun swapIntoPlace() {
        layout.previous.deleteRecursively()
        if (layout.current.exists() && !layout.current.renameTo(layout.previous)) {
            throw IOException("Could not set the current bundle aside.")
        }
        if (!layout.staging.renameTo(layout.current)) {
            layout.previous.renameTo(layout.current)  // put back what was working
            throw IOException("Could not move the new bundle into place.")
        }
    }

    /**
     * Points the working directory at the bundle by name. Relative links, so a
     * later swap of `current` needs no relinking.
     */
    private fun linkWorkingDirectory() {
        layout.workingDirectory.mkdirs()

        layout.linkedEntries.forEach { name ->
            val link = Paths.get(layout.workingDirectory.path, name)
            Files.deleteIfExists(link)
            Files.createSymbolicLink(link, Paths.get("../bundle/current", name))
        }
    }

    private companion object {
        const val TAG = "SenderrrBundle"
        const val BUNDLE_ASSET = "bundle.zip"
        const val VERSION_ASSET = "bundle.version"
    }
}
