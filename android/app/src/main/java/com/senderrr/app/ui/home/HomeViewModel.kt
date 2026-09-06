package com.senderrr.app.ui.home

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.senderrr.app.runtime.BatteryExemption
import com.senderrr.app.runtime.NodeService
import com.senderrr.app.runtime.RuntimePreferences
import com.senderrr.app.runtime.RuntimeState
import com.senderrr.app.runtime.RuntimeStatusStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class HomeUiState(
    val runtime: RuntimeState = RuntimeState.Stopped,
    val isBatteryExemptionGranted: Boolean = true,
)

/**
 * The Home screen's state: what the server is doing, and whether anything is
 * standing in the way of it staying up.
 *
 * The battery exemption is part of this state rather than a one-off prompt at
 * install time, because it can be revoked later — by the client, or by an OEM's
 * own battery manager — and a server quietly killed weeks after setup is this
 * deployment's worst failure. If it is missing, Home says so, every time.
 */
class HomeViewModel(application: Application) : AndroidViewModel(application) {

    private val preferences = RuntimePreferences(application)
    private val statusStore = RuntimeStatusStore(application)

    private val _uiState = MutableStateFlow(HomeUiState())
    val uiState: StateFlow<HomeUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            statusStore.observe().collect { state -> _uiState.update { it.copy(runtime = state) } }
        }
    }

    /** Called whenever the screen comes forward: permissions change outside the app. */
    fun refreshPermissions() {
        _uiState.update {
            it.copy(isBatteryExemptionGranted = BatteryExemption.isGranted(getApplication()))
        }
    }

    fun startServer() {
        // Recorded before starting, so the watchdog and the boot receiver know
        // this was wanted even if the very first start fails.
        preferences.shouldRun = true
        NodeService.start(getApplication())
    }

    fun stopServer() {
        preferences.shouldRun = false
        NodeService.stop(getApplication())
    }
}
