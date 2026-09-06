package com.senderrr.app.ui.advanced

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.senderrr.app.R

/**
 * The warned, non-default surface from ADR-8: a live log tail and a few named
 * diagnostic actions, reached deliberately and never shown by accident.
 *
 * The interstitial is not decoration. Everything on the far side of it can stop
 * the client's server, and someone who arrived here by tapping around should be
 * turned back rather than handed the controls.
 */
@Composable
fun AdvancedScreen(
    isWarningAccepted: Boolean,
    logLines: List<String>,
    onAcceptWarning: () -> Unit,
    onBack: () -> Unit,
    onRestartServer: () -> Unit,
    onCopyLogs: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (!isWarningAccepted) {
        WarningInterstitial(onContinue = onAcceptWarning, onBack = onBack, modifier = modifier)
        return
    }

    Column(
        modifier = modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(stringResource(R.string.advanced_title), style = MaterialTheme.typography.headlineSmall)

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onRestartServer) {
                Text(stringResource(R.string.advanced_restart))
            }
            OutlinedButton(onClick = onCopyLogs) {
                Text(stringResource(R.string.advanced_copy_logs))
            }
        }

        LogView(logLines, modifier = Modifier.fillMaxWidth().weight(1f))

        TextButton(onClick = onBack) { Text(stringResource(R.string.advanced_back)) }
    }
}

@Composable
private fun WarningInterstitial(
    onContinue: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    ) {
        Text(
            stringResource(R.string.advanced_warning_title),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            stringResource(R.string.advanced_warning_body),
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        // Going back is the primary action; continuing is the deliberate one.
        Button(onClick = onBack, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.advanced_warning_back))
        }
        TextButton(onClick = onContinue, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.advanced_warning_continue))
        }
    }
}

@Composable
private fun LogView(lines: List<String>, modifier: Modifier = Modifier) {
    val listState = rememberLazyListState()

    // Follow the tail, the way a terminal does.
    LaunchedEffect(lines.size) {
        if (lines.isNotEmpty()) listState.scrollToItem(lines.lastIndex)
    }

    Card(
        modifier = modifier,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        if (lines.isEmpty()) {
            Text(
                stringResource(R.string.advanced_logs_empty),
                modifier = Modifier.padding(16.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            return@Card
        }

        LazyColumn(state = listState, modifier = Modifier.padding(12.dp)) {
            items(lines) { line ->
                Text(
                    line,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurface,
                )
            }
        }
    }
}
