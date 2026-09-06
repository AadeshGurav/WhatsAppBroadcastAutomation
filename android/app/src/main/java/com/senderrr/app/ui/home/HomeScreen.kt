package com.senderrr.app.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.senderrr.app.R
import com.senderrr.app.runtime.RuntimeState
import com.senderrr.app.ui.theme.SenderrrColors

/**
 * What the client sees first, and most days the only thing they see: is my
 * server running, and if not, what do I do about it (PRD commit 12).
 *
 * One primary action per state, in one place. Everything diagnostic lives
 * behind Advanced (ADR-8).
 */
@Composable
fun HomeScreen(
    state: HomeUiState,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onGrantBatteryExemption: () -> Unit,
    onOpenAdvanced: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        Text(stringResource(R.string.app_name), style = MaterialTheme.typography.headlineSmall)

        StatusCard(state.runtime)

        if (!state.isBatteryExemptionGranted) {
            BatteryWarningCard(onGrant = onGrantBatteryExemption)
        }

        if (state.runtime.isActive) {
            OutlinedButton(onClick = onStop, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.home_stop))
            }
        } else {
            Button(onClick = onStart, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.home_start))
            }
        }

        Column(
            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            TextButton(onClick = onOpenAdvanced) {
                Text(stringResource(R.string.home_advanced))
            }
        }
    }
}

@Composable
private fun StatusCard(runtime: RuntimeState) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // The dot is never the only signal — the sentence beside it says
                // the same thing, so this reads correctly without colour vision.
                Surface(
                    modifier = Modifier.size(10.dp),
                    shape = CircleShape,
                    color = statusColor(runtime),
                ) {}
                Text(
                    stringResource(statusHeadline(runtime)),
                    style = MaterialTheme.typography.titleMedium,
                )
            }
            Text(
                statusDetail(runtime),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun BatteryWarningCard(onGrant: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                stringResource(R.string.home_battery_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                stringResource(R.string.home_battery_body),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Button(onClick = onGrant) { Text(stringResource(R.string.home_battery_action)) }
        }
    }
}

private fun statusColor(runtime: RuntimeState): Color = when (runtime) {
    RuntimeState.Running -> SenderrrColors.PrimaryLight
    RuntimeState.Starting -> SenderrrColors.Warning
    RuntimeState.Stopped -> SenderrrColors.TextSecondaryLight
    is RuntimeState.Failed -> SenderrrColors.Danger
}

private fun statusHeadline(runtime: RuntimeState): Int = when (runtime) {
    RuntimeState.Running -> R.string.home_state_running
    RuntimeState.Starting -> R.string.home_state_starting
    RuntimeState.Stopped -> R.string.home_state_stopped
    is RuntimeState.Failed -> R.string.home_state_failed
}

@Composable
private fun statusDetail(runtime: RuntimeState): String = when (runtime) {
    RuntimeState.Running -> stringResource(R.string.home_state_running_detail)
    RuntimeState.Starting -> stringResource(R.string.home_state_starting_detail)
    RuntimeState.Stopped -> stringResource(R.string.home_state_stopped_detail)
    is RuntimeState.Failed -> runtime.reason
}
