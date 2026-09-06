package com.senderrr.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

private val LightColors = lightColorScheme(
    primary = SenderrrColors.PrimaryLight,
    onPrimary = SenderrrColors.BackgroundLight,
    background = SenderrrColors.BackgroundLight,
    onBackground = SenderrrColors.TextLight,
    surface = SenderrrColors.SurfaceLight,
    onSurface = SenderrrColors.TextLight,
    onSurfaceVariant = SenderrrColors.TextSecondaryLight,
    outline = SenderrrColors.BorderLight,
    error = SenderrrColors.Danger,
)

private val DarkColors = darkColorScheme(
    primary = SenderrrColors.PrimaryDark,
    onPrimary = SenderrrColors.BackgroundDark,
    background = SenderrrColors.BackgroundDark,
    onBackground = SenderrrColors.TextDark,
    surface = SenderrrColors.SurfaceDark,
    onSurface = SenderrrColors.TextDark,
    onSurfaceVariant = SenderrrColors.TextSecondaryDark,
    outline = SenderrrColors.BorderDark,
    error = SenderrrColors.Danger,
)

/**
 * Deliberately not using Material You dynamic color: the client's phone
 * wallpaper should not be able to repaint an operations tool whose status
 * colours (running / stopped / failing) have to stay unambiguous.
 */
@Composable
fun SenderrrTheme(
    useDarkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (useDarkTheme) DarkColors else LightColors,
        typography = SenderrrTypography,
        content = content,
    )
}
