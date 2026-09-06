package com.senderrr.app.runtime

import android.content.Context
import androidx.core.content.edit

/**
 * Whether the client wants their server running — as distinct from whether it
 * currently is.
 *
 * The watchdog needs that distinction: a runtime process that disappeared while
 * the client wanted it up is a crash to recover from, and the same event right
 * after they tapped Stop is the system working. Without a recorded intent the
 * two are indistinguishable, and the watchdog would fight the client's own Stop
 * button.
 */
class RuntimePreferences(context: Context) {

    private val store = context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    var shouldRun: Boolean
        get() = store.getBoolean(KEY_SHOULD_RUN, false)
        set(value) = store.edit { putBoolean(KEY_SHOULD_RUN, value) }

    private companion object {
        const val NAME = "senderrr.runtime"
        const val KEY_SHOULD_RUN = "should_run"
    }
}
