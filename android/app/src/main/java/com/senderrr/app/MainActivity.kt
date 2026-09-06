package com.senderrr.app

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.senderrr.app.runtime.BatteryExemption
import com.senderrr.app.ui.home.HomeScreen
import com.senderrr.app.ui.home.HomeViewModel
import com.senderrr.app.ui.theme.SenderrrTheme

/**
 * The app's single Activity, hosting Home and the warned Advanced screen
 * (ADR-8: Home is the default surface; Advanced is reached deliberately).
 */
class MainActivity : ComponentActivity() {

    private val requestNotificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val requestBatteryExemption =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        askForNotificationPermission()

        setContent {
            SenderrrTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { insets ->
                    SenderrrApp(
                        modifier = Modifier.padding(insets),
                        onGrantBatteryExemption = {
                            requestBatteryExemption.launch(BatteryExemption.requestIntent(this))
                        },
                    )
                }
            }
        }
    }

    /**
     * The persistent notification is the only place the client sees server
     * status without opening the app, so it is worth asking for. It is asked
     * for on its own, not bundled with anything else.
     */
    private fun askForNotificationPermission() {
        val granted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) requestNotificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    @Composable
    private fun SenderrrApp(modifier: Modifier, onGrantBatteryExemption: () -> Unit) {
        val home: HomeViewModel = viewModel()

        // Permissions can be revoked outside the app, so Home re-checks every
        // time it comes forward rather than trusting what it saw at startup.
        LifecycleResumeEffect(home) {
            home.refreshPermissions()
            onPauseOrDispose { }
        }

        val homeState by home.uiState.collectAsStateWithLifecycle()

        HomeScreen(
            state = homeState,
            onStart = home::startServer,
            onStop = home::stopServer,
            onGrantBatteryExemption = onGrantBatteryExemption,
            // The Advanced screen arrives in the next commit (ADR-8).
            onOpenAdvanced = { },
            modifier = modifier,
        )
    }
}
