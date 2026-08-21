import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RuntimeSetting } from '@database/entities/wa-automation/runtime-setting.entity';

interface CachedValue {
  value: string | null;
  at: number;
}

/**
 * Runtime settings overridable via DB table (and backed by env defaults).
 * Checks RuntimeSetting first, falls back to process.env, then default.
 *
 * Reads are cached in-memory for a short TTL (default 30s). This table is
 * queried on nearly every cron tick and per message send; the TTL cache
 * removes thousands of redundant SELECTs/day from the database, which keeps
 * Neon compute usage down. Writes always invalidate the cache immediately.
 */
@Injectable()
export class SettingsService {
  private readonly cache = new Map<string, CachedValue>();
  private readonly CACHE_TTL_MS: number;

  constructor(
    @InjectRepository(RuntimeSetting, 'data')
    private readonly settingsRepo: Repository<RuntimeSetting>,
  ) {
    this.CACHE_TTL_MS = parseInt(process.env.SETTINGS_CACHE_TTL_MS || '30000', 10);
  }

  async get(key: string, defaultValue = ''): Promise<string> {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.CACHE_TTL_MS) {
      return cached.value ?? process.env[key] ?? defaultValue;
    }

    const row = await this.settingsRepo.findOne({ where: { key } });
    const value = row?.value ?? null;
    this.cache.set(key, { value, at: Date.now() });
    return value ?? process.env[key] ?? defaultValue;
  }

  async getInt(key: string, defaultValue = 0): Promise<number> {
    const val = await this.get(key, String(defaultValue));
    return parseInt(val, 10);
  }

  async getFloat(key: string, defaultValue = 0): Promise<number> {
    const val = await this.get(key, String(defaultValue));
    return parseFloat(val);
  }

  async set(key: string, value: string): Promise<void> {
    let row = await this.settingsRepo.findOne({ where: { key } });
    if (!row) {
      row = this.settingsRepo.create({ key, value });
    } else {
      row.value = value;
    }
    await this.settingsRepo.save(row);
    this.cache.set(key, { value, at: Date.now() });
  }

  async delete(key: string): Promise<void> {
    await this.settingsRepo.delete({ key });
    this.cache.delete(key);
  }

  async all(): Promise<RuntimeSetting[]> {
    return this.settingsRepo.find({ order: { key: 'ASC' } });
  }

  /** Bulk update — set multiple keys at once */
  async bulkSet(entries: Array<{ key: string; value: string }>): Promise<void> {
    for (const entry of entries) {
      await this.set(entry.key, entry.value);
    }
  }
}
