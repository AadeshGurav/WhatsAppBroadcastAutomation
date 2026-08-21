import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JitterService {
  private readonly minJitter: number;
  private readonly maxJitter: number;
  private readonly multiplier: number;

  constructor(configService: ConfigService) {
    this.minJitter = configService.get<number>('automation.jitterMin', 30);
    this.maxJitter = configService.get<number>('automation.jitterMax', 120);
    this.multiplier = configService.get<number>('automation.jitterMultiplier', 1.5);
  }

  /**
   * Calculate progressive delay (in ms) for a batch sequence.
   * Later messages get longer delays (1.5x multiplier).
   * In local mode jitterMin/Max default to 0/1 → effectively no delay.
   */
  calculateDelay(batchIndex: number, messagesThisBatch = 1): number {
    if (this.maxJitter <= 0) return 0;
    const base = this.minJitter + Math.random() * (this.maxJitter - this.minJitter);
    const batchFactor = Math.pow(this.multiplier, Math.floor(batchIndex / messagesThisBatch));
    return Math.min(base * batchFactor, this.maxJitter * 10) * 1000;
  }
}
