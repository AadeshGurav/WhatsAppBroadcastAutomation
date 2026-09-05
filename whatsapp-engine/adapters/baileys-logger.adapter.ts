// 'baileys' does not re-export ILogger from its root index (Utils/index.ts
// never re-exports logger.ts) even though the type exists in the published
// .d.ts files, so we import the subpath directly.
import type { ILogger } from 'baileys/lib/Utils/logger';
import { createLogger } from '@common/services/logger.service';

/**
 * Adapts the app's own logger to the exact `ILogger` shape Baileys requires
 * (`level`, `child()`, and `trace/debug/info/warn/error(obj, msg?)`). Baileys
 * ships its own pino-based default, but wiring our logger through here keeps
 * every engine's logs in the same structured format Senderrr already uses,
 * rather than mixing in a second, differently-formatted log stream.
 */
export class BaileysLoggerAdapter implements ILogger {
  level = 'info';

  constructor(
    private readonly logger: ReturnType<typeof createLogger>,
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  child(obj: Record<string, unknown>): ILogger {
    return new BaileysLoggerAdapter(this.logger, { ...this.bindings, ...obj });
  }

  private format(obj: unknown, msg?: string): string {
    const context = Object.keys(this.bindings).length > 0 ? JSON.stringify(this.bindings) : '';
    const detail = typeof obj === 'string' ? obj : obj ? JSON.stringify(obj) : '';
    return [msg, context, detail].filter(Boolean).join(' ');
  }

  trace(obj: unknown, msg?: string): void {
    this.logger.debug(this.format(obj, msg));
  }

  debug(obj: unknown, msg?: string): void {
    this.logger.debug(this.format(obj, msg));
  }

  info(obj: unknown, msg?: string): void {
    this.logger.log(this.format(obj, msg));
  }

  warn(obj: unknown, msg?: string): void {
    this.logger.warn(this.format(obj, msg));
  }

  error(obj: unknown, msg?: string): void {
    this.logger.error(this.format(obj, msg));
  }
}
