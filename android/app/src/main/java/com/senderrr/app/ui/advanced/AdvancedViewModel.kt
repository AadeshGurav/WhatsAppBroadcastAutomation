package com.senderrr.app.ui.advanced

import android.app.Application
import android.content.ClipData
import android.content.ClipboardManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.senderrr.app.runtime.LogTail
import com.senderrr.app.runtime.NodeService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * State for the Advanced screen: the warning gate, and the live log tail behind
 * it.
 *
 * The warning is accepted per visit, not remembered. Someone who saw it once a
 * month ago is no more prepared for what is here than someone who never has.
 */
class AdvancedViewModel(application: Application) : AndroidViewModel(application) {

    private val _isWarningAccepted = MutableStateFlow(false)
    val isWarningAccepted: StateFlow<Boolean> = _isWarningAccepted.asStateFlow()

    private val _logLines = MutableStateFlow<List<String>>(emptyList())
    val logLines: StateFlow<List<String>> = _logLines.asStateFlow()

    fun acceptWarning() {
        if (_isWarningAccepted.value) return
        _isWarningAccepted.value = true
        streamLogs()
    }

    fun restartServer() {
        NodeService.stop(getApplication())
        NodeService.start(getApplication())
    }

    fun copyLogs() {
        val text = _logLines.value.joinToString("\n")
        getApplication<Application>().getSystemService(ClipboardManager::class.java)
            .setPrimaryClip(ClipData.newPlainText("Senderrr logs", text))
    }

    private fun streamLogs() {
        viewModelScope.launch {
            LogTail(getApplication()).stream().collect { lines -> _logLines.value = lines }
        }
    }
}
