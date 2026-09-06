package com.senderrr.app.runtime

/**
 * What the embedded Node runtime is doing, in the terms the Home screen shows
 * the client (PRD commit 12) and the watchdog acts on (commit 9).
 *
 * [Failed] carries a reason because a stopped server the client cannot explain
 * is the worst state this app can be in — worse than a crash, which at least
 * says something.
 */
sealed interface RuntimeState {
    data object Stopped : RuntimeState
    data object Starting : RuntimeState
    data object Running : RuntimeState
    data class Failed(val reason: String) : RuntimeState

    val isActive: Boolean get() = this is Starting || this is Running
}
