package com.senderrr.app.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * The dashboard's design tokens (dashboard-ui/src/index.css), transcribed so the
 * phone app and the web dashboard are visibly the same product.
 *
 * 60/30/10: [Background] carries the page, [Surface] the cards on it, and
 * [Primary] is reserved for the one action that matters on each screen.
 */
object SenderrrColors {
    val PrimaryLight = Color(0xFF10B981)
    val PrimaryDark = Color(0xFF34D399)

    val BackgroundLight = Color(0xFFFFFFFF)
    val SurfaceLight = Color(0xFFF8FAFC)
    val BorderLight = Color(0xFFE2E8F0)
    val TextLight = Color(0xFF0F172A)
    val TextSecondaryLight = Color(0xFF64748B)

    val BackgroundDark = Color(0xFF050505)
    val SurfaceDark = Color(0xFF111111)
    val BorderDark = Color(0xFF1F1F1F)
    val TextDark = Color(0xFFFAFAFA)
    val TextSecondaryDark = Color(0xFFA1A1AA)

    val Danger = Color(0xFFEF4444)
    val Warning = Color(0xFFF59E0B)
    val Info = Color(0xFF3B82F6)
}
