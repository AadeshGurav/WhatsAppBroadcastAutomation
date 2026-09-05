import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { IWhatsAppEngine } from './interfaces/whatsapp-engine.interface';
import { WhatsAppWebJsAdapter } from './adapters/whatsapp-web-js.adapter';
import { BaileysAdapter } from './adapters/baileys.adapter';
import { PluginLoaderService, PluginType, IEnginePlugin, PluginManifest } from '@core/plugins';
import { WhatsAppWebJsPlugin } from './plugins/whatsapp-web-js';
import { BaileysPlugin } from './plugins/baileys';
import { createLogger } from '@common/services/logger.service';

export interface EngineCreateOptions {
  sessionId: string;
  proxyUrl?: string;
  proxyType?: 'http' | 'https' | 'socks4' | 'socks5';
}

@Injectable()
export class EngineFactory implements OnModuleInit {
  private readonly logger = createLogger('EngineFactory');
  private readonly engineType: string;
  private readonly engines = new Map<string, IWhatsAppEngine>();

  constructor(
    private readonly configService: ConfigService,
    private readonly pluginLoader: PluginLoaderService,
    @InjectDataSource('data') private readonly dataSource: DataSource,
  ) {
    this.engineType = this.configService.get<string>('engine.type') ?? 'whatsapp-web.js';
  }

  /** Register an engine instance so it can be reused (called by SessionService). */
  registerEngine(sessionId: string, engine: IWhatsAppEngine): void {
    this.engines.set(sessionId, engine);
  }

  /** Remove a registered engine (called on session stop/delete). */
  unregisterEngine(sessionId: string): void {
    this.engines.delete(sessionId);
  }

  async onModuleInit(): Promise<void> {
    // Register built-in engine plugins
    await this.registerBuiltInEngines();
  }

  private async registerBuiltInEngines(): Promise<void> {
    // Register WhatsApp-web.js as built-in plugin
    const wwjsManifest: PluginManifest = {
      id: 'whatsapp-web.js',
      name: 'WhatsApp Web.js Engine',
      version: '1.0.0',
      type: PluginType.ENGINE,
      description: 'Official WhatsApp-web.js engine adapter',
      main: 'index.ts',
      provides: ['whatsapp-engine'],
    };

    const wwjsPlugin = new WhatsAppWebJsPlugin();
    this.pluginLoader.registerBuiltInPlugin(wwjsManifest, wwjsPlugin);

    // Register Baileys as a built-in plugin — the browser-free engine that
    // lets Senderrr run its WhatsApp connection on an Android phone.
    const baileysManifest: PluginManifest = {
      id: 'baileys',
      name: 'Baileys Engine',
      version: '1.0.0',
      type: PluginType.ENGINE,
      description: 'Browser-free WhatsApp multi-device protocol engine adapter',
      main: 'index.ts',
      provides: ['whatsapp-engine'],
    };

    const baileysPlugin = new BaileysPlugin();
    this.pluginLoader.registerBuiltInPlugin(baileysManifest, baileysPlugin);

    // Auto-enable the configured engine
    try {
      await this.pluginLoader.enablePlugin(this.engineType);
      this.logger.log(`Engine plugin enabled: ${this.engineType}`, {
        action: 'engine_enabled',
        engineType: this.engineType,
      });
    } catch (error) {
      this.logger.error(
        `Failed to enable engine plugin: ${this.engineType}`,
        error instanceof Error ? error.message : String(error),
        { action: 'engine_enable_failed' },
      );
    }
  }

  create(options: EngineCreateOptions): IWhatsAppEngine {
    // Return existing engine if already registered for this session
    const existing = this.engines.get(options.sessionId);
    if (existing) {
      return existing;
    }

    // Direct adapter creation with DataSource injection.
    // The plugin system is bypassed here because whatsapp-web.js RemoteAuth
    // requires a Postgres DataSource which the plugin interface doesn't carry.
    // The plugin is still used for healthCheck() and getFeatures().
    const engine = this.createDirectEngine(options);
    this.engines.set(options.sessionId, engine);
    return engine;
  }

  private createDirectEngine(options: EngineCreateOptions): IWhatsAppEngine {
    if (this.engineType === 'baileys') {
      return new BaileysAdapter(
        {
          sessionId: options.sessionId,
          pairingPhoneNumber: this.configService.get<string>('engine.baileys.pairingPhoneNumber') || undefined,
          browserName: this.configService.get<string>('engine.baileys.browserName') || 'Senderrr',
        },
        this.dataSource,
      );
    }

    return new WhatsAppWebJsAdapter(
      {
        sessionId: options.sessionId,
        puppeteer: {
          headless: this.configService.get<boolean>('engine.puppeteer.headless') ?? true,
          args: this.configService.get<string[]>('engine.puppeteer.args') ?? [
            '--no-sandbox',
            '--disable-setuid-sandbox',
          ],
        },
        proxy: options.proxyUrl
          ? {
              url: options.proxyUrl,
              type: options.proxyType ?? 'http',
            }
          : undefined,
      },
      this.dataSource,
    );
  }

  private isEnginePlugin(instance: unknown): instance is IEnginePlugin {
    return (
      typeof instance === 'object' &&
      instance !== null &&
      'type' in instance &&
      instance.type === PluginType.ENGINE &&
      'createEngine' in instance &&
      typeof (instance as { createEngine: unknown }).createEngine === 'function'
    );
  }

  // ============================================================================
  // Query Methods for API/Dashboard
  // ============================================================================

  getAvailableEngines(): Array<{ id: string; name: string; enabled: boolean; features: string[] }> {
    const enginePlugins = this.pluginLoader.getPluginsByType(PluginType.ENGINE);

    return enginePlugins.map(plugin => {
      const features = plugin.instance && this.isEnginePlugin(plugin.instance) ? plugin.instance.getFeatures() : [];

      return {
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        enabled: this.pluginLoader.isPluginEnabled(plugin.manifest.id),
        features,
      };
    });
  }

  getCurrentEngine(): string {
    return this.engineType;
  }
}
