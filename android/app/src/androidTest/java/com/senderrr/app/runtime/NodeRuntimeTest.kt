package com.senderrr.app.runtime

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * PRD commit 4's acceptance test, and commit 7's: prove that a script handed to
 * the JNI bridge actually executes inside the cross-compiled libnode.so on a
 * real device, and that its stdout is captured.
 *
 * `node::Start()` can only be called once per process, so this is deliberately
 * a single test: a second one would run in the same instrumentation process and
 * fail for reasons that have nothing to do with what it was checking.
 */
@RunWith(AndroidJUnit4::class)
class NodeRuntimeTest {

    @Test
    fun runsAScriptAndPrintsToLogcat() {
        assertTrue(
            "libnode.so did not load — run scripts/build-libnode.sh first. " +
                "Cause: ${NodeRuntime.loadFailure}",
            NodeRuntime.isAvailable,
        )

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val marker = "hello from libnode ${System.nanoTime()}"
        val script = File(context.cacheDir, "hello.js").apply {
            writeText(
                """
                console.log(${"\"" + marker.replace("\"", "") + "\""});
                console.log('node ' + process.versions.node + ' on ' + process.platform + '/' + process.arch);
                process.exitCode = 0;
                """.trimIndent()
            )
        }

        val logFile = File(context.cacheDir, "runtime-test.log").apply { delete() }

        val exitCode = NodeRuntime.runScript(
            scriptPath = script.absolutePath,
            workingDirectory = context.cacheDir.absolutePath,
            logFile = logFile.absolutePath,
        )

        assertEquals("Node exited non-zero", 0, exitCode)
        assertTrue("'$marker' was never captured from Node's output", logContains(logFile, marker))
    }

    /**
     * Checks the file the bridge writes Node's output to — not logcat, which an
     * app cannot reliably read on an OEM device (see LogTail).
     */
    private fun logContains(logFile: File, needle: String): Boolean {
        // The pump thread forwards Node's stdout asynchronously; give it a
        // moment rather than racing it.
        TimeUnit.MILLISECONDS.sleep(500)
        return logFile.isFile && logFile.readText().contains(needle)
    }
}
