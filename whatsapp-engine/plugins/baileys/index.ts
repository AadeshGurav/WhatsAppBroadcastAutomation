/**
 * Baileys Engine Plugin
 * Built-in engine plugin that wraps the `baileys` library — a pure-Node
 * reimplementation of WhatsApp's multi-device protocol (no browser/Chromium
 * required). This is what makes running Senderrr on an Android phone
 * possible: see BaileysAdapter for the actual protocol implementation.
 *
 * Mirrors WhatsAppWebJsPlugin: engine creation is handled by EngineFactory
 * directly (bypassing this plugin) because the TypeORM-backed auth store
 * requires a DataSource which the plugin interface cannot carry. This
 * plugin is still used for healthCheck() and getFeatures().
 */

import { PluginContext, PluginType, IEnginePlugin } from '@core/plugins';
import { IWhatsAppEngine } from '@whatsapp-engine/interfaces/whatsapp-engine.interface';

export class BaileysPlugin implements IEnginePlugin {
  type = PluginType.ENGINE as const;
  private context?: PluginContext;

  onLoad(context: PluginContext): Promise<void> {
    this.context = context;
    context.logger.log('Baileys engine plugin loaded');
    return Promise.resolve();
  }

  onEnable(context: PluginContext): Promise<void> {
    context.logger.log('Baileys engine plugin enabled');
    return Promise.resolve();
  }

  onDisable(context: PluginContext): Promise<void> {
    context.logger.log('Baileys engine plugin disabled');
    return Promise.resolve();
  }

  createEngine(_config: Record<string, unknown>): IWhatsAppEngine {
    throw new Error('Engine creation is handled by EngineFactory — do not call createEngine directly');
  }

  getFeatures(): string[] {
    return [
      'text-messages',
      'media-messages',
      'location-messages',
      'contact-messages',
      'group-management',
      'message-reactions',
      'message-replies',
      'message-forwarding',
      'message-deletion',
      'message-editing',
      'labels',
      'channels',
      'status-updates',
      'catalog',
      'no-browser-required',
    ];
  }

  healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return Promise.resolve({ healthy: true, message: 'Baileys engine is available' });
  }
}

export default BaileysPlugin;
