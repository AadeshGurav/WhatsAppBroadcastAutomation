/* eslint-disable */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { MessageTask, MessageTaskStatus } from '@database/entities/wa-automation/message-task.entity';
import { BroadcastEvent, BroadcastStatus } from '@database/entities/wa-automation/broadcast-event.entity';
import { AutomationService, ErrorCategory, DeliveryResult } from '../automation/automation.service';
import { RateLimiterService } from '../automation/rate-limiter.service';
import { AttemptTrackerService } from './attempt-tracker.service';
import { MaintenanceService } from './maintenance.service';
import { AdminSessionService } from '../automation/admin-session.service';

/**
 * Parallel per-admin dispatcher with human-like pacing for safe WhatsApp sending.
 *
 * Reliability guarantees:
 * - Session failures leave tasks PENDING (retried by cron) instead of failing them
 * - Rate-limited tasks are skipped (not failed) so they retry next cycle
 * - Individual task delivery has inner retry loop (3 attempts)
 * - Dispatch crash marks broadcast FAILED so it doesn't hang forever
 */
@Injectable()
export class BroadcastDispatcherService {
  private readonly logger = new Logger('BroadcastDispatcherService');

  /** Tracks broadcasts currently being dispatched to prevent concurrent dispatches. */
  private readonly dispatchingBroadcasts = new Set<number>();

  // Human-like pacing — values come from config so local mode can run freely
  // (all delays 0) while cloud keeps the anti-ban throttles.
  private readonly MIN_DELAY_MS: number;
  private readonly MAX_DELAY_MS: number;
  private readonly BATCH_SIZE: number;
  private readonly BATCH_PAUSE_MIN_MS: number;
  private readonly BATCH_PAUSE_MAX_MS: number;
  private readonly DISPATCH_TIMEOUT_MINUTES: number;
  private readonly RATE_LIMIT_RETRY_SLEEP_MS: number;
  private readonly isLocal: boolean;

  constructor(
    @InjectRepository(MessageTask, 'data')
    private readonly taskRepo: Repository<MessageTask>,
    @InjectRepository(BroadcastEvent, 'data')
    private readonly broadcastRepo: Repository<BroadcastEvent>,
    private readonly automationService: AutomationService,
    private readonly rateLimiter: RateLimiterService,
    private readonly attemptTracker: AttemptTrackerService,
    private readonly maintenanceService: MaintenanceService,
    private readonly adminSessionService: AdminSessionService,
    configService: ConfigService,
  ) {
    this.MIN_DELAY_MS = configService.get<number>('automation.perMessageDelayMin', 3000);
    this.MAX_DELAY_MS = configService.get<number>('automation.perMessageDelayMax', 8000);
    this.BATCH_SIZE = configService.get<number>('automation.batchSize', 50);
    this.BATCH_PAUSE_MIN_MS = configService.get<number>('automation.batchPauseMin', 120_000);
    this.BATCH_PAUSE_MAX_MS = configService.get<number>('automation.batchPauseMax', 300_000);
    this.DISPATCH_TIMEOUT_MINUTES = configService.get<number>('automation.dispatchTimeoutMinutes', 60);
    this.RATE_LIMIT_RETRY_SLEEP_MS = configService.get<number>('automation.rateLimitRetrySleepMs', 60_000);
    this.isLocal = configService.get<boolean>('isLocal', false);
  }

  /**
   * Dispatch a broadcast's pending tasks across all assigned admins in parallel.
   * Prevents concurrent dispatch of the same broadcast to avoid duplicates.
   */
  async dispatchBroadcast(broadcastId: number, messageText: string, imageUrls: string[] = []): Promise<void> {
    // Allow re-dispatch if broadcast is still IN_PROGRESS and has remaining pending tasks
    if (this.dispatchingBroadcasts.has(broadcastId)) {
      const broadcast = await this.broadcastRepo.findOne({ where: { id: broadcastId } });
      if (
        broadcast &&
        (broadcast.status === BroadcastStatus.COMPLETED || broadcast.status === BroadcastStatus.FAILED)
      ) {
        this.logger.log(`Broadcast #${broadcastId}: already ${broadcast.status}, skipping duplicate call`);
        return;
      }
      // If still in progress, check remaining pending count
      if (broadcast) {
        const pendingCount = await this.taskRepo.count({
          where: { broadcast: { id: broadcastId }, status: MessageTaskStatus.PENDING },
        });
        if (pendingCount === 0) {
          this.logger.log(`Broadcast #${broadcastId}: no pending tasks, skipping duplicate call`);
          return;
        }
        this.logger.log(`Broadcast #${broadcastId}: re-dispatching ${pendingCount} remaining pending tasks`);
      }
    }
    this.dispatchingBroadcasts.add(broadcastId);

    try {
      await this.dispatchBroadcastInner(broadcastId, messageText, imageUrls);
    } catch (err) {
      this.logger.error(`Broadcast #${broadcastId} dispatch crashed: ${(err as Error).message}`, (err as Error).stack);
      // Mark as FAILED so it doesn't stay IN_PROGRESS forever
      await this.broadcastRepo
        .update(broadcastId, {
          status: BroadcastStatus.FAILED,
          completedAt: new Date(),
        })
        .catch(e => this.logger.error(`Failed to mark broadcast #${broadcastId} as failed: ${e.message}`));
    } finally {
      this.dispatchingBroadcasts.delete(broadcastId);
    }
  }

  isDispatching(broadcastId: number): boolean {
    return this.dispatchingBroadcasts.has(broadcastId);
  }

  private async dispatchBroadcastInner(
    broadcastId: number,
    messageText: string,
    imageUrls: string[] = [],
  ): Promise<void> {
    const broadcast = await this.broadcastRepo.findOne({ where: { id: broadcastId } });
    if (!broadcast) {
      this.logger.warn(`Broadcast #${broadcastId} not found`);
      return;
    }

    const tasks = await this.taskRepo.find({
      where: { broadcast: { id: broadcastId }, status: MessageTaskStatus.PENDING },
      relations: ['group', 'admin'],
    });
    if (tasks.length === 0) {
      this.logger.log(`Broadcast #${broadcastId}: no pending tasks`);
      return;
    }

    // Group by admin
    const byAdmin = new Map<number, MessageTask[]>();
    for (const task of tasks) {
      const adminId = task.admin?.id;
      if (!adminId) continue;
      const list = byAdmin.get(adminId) || [];
      list.push(task);
      byAdmin.set(adminId, list);
    }

    this.logger.log(
      `Broadcast #${broadcastId}: ${tasks.length} tasks across ${byAdmin.size} admins ` +
        `[${[...byAdmin.entries()].map(([id, t]) => `a${id}:${t.length}`).join(', ')}]`,
    );

    // Mark broadcast in-progress
    if (broadcast.status !== BroadcastStatus.IN_PROGRESS) {
      broadcast.status = BroadcastStatus.IN_PROGRESS;
      broadcast.startedAt = new Date();
      await this.broadcastRepo.save(broadcast);
    }

    // Dispatch timeout — if a queue hangs beyond this, we still tally
    const dispatchTimeout = setTimeout(
      async () => {
        this.logger.warn(
          `Broadcast #${broadcastId}: dispatch timed out after ${this.DISPATCH_TIMEOUT_MINUTES}min, forcing tally`,
        );
        await this.tallyBroadcast(broadcastId);
      },
      this.DISPATCH_TIMEOUT_MINUTES * 60 * 1000,
    );

    // Fire all admin queues in parallel
    const queues = [...byAdmin.entries()].map(([adminId, adminTasks]) =>
      this.processAdminQueue(adminId, adminTasks, messageText, imageUrls),
    );
    const results = await Promise.allSettled(queues);

    clearTimeout(dispatchTimeout);

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(`Admin queue rejected: ${result.reason}`);
      }
    }

    await this.tallyBroadcast(broadcastId);
  }

  private async processAdminQueue(
    adminId: number,
    tasks: MessageTask[],
    text: string,
    imageUrls: string[] = [],
  ): Promise<void> {
    try {
      await this.processAdminQueueInner(adminId, tasks, text, imageUrls);
    } catch (err) {
      this.logger.error(`Admin #${adminId} queue crashed: ${(err as Error).message}`);
      // Leave remaining tasks PENDING — retry cron will pick them up
    }
  }

  private async processAdminQueueInner(
    adminId: number,
    tasks: MessageTask[],
    text: string,
    imageUrls: string[] = [],
  ): Promise<void> {
    // Resolve the admin's ready session with timeout
    let sessionId: string | null = null;
    try {
      const sessions = (await Promise.race([
        this.adminSessionService.getAdminSessions(adminId),
        this.sleep(30_000).then(() => {
          throw new Error('getAdminSessions timed out after 30s');
        }),
      ])) as any[];
      sessionId = sessions.find(s => s.openwaSessionStatus === 'ready')?.openwaSessionId || null;
      this.logger.log(
        `Admin #${adminId}: resolved session=${sessionId || 'none'} from ${sessions.length} sessions (${sessions.map(s => s.openwaSessionStatus).join(', ')})`,
      );
    } catch (err) {
      this.logger.warn(`Admin #${adminId}: session resolution failed: ${(err as Error).message}`);
      sessionId = null;
    }

    if (!sessionId) {
      // Graceful degradation: don't fail all tasks, leave them PENDING for retry cron
      this.logger.warn(`Admin #${adminId}: no active session — leaving ${tasks.length} tasks PENDING for retry`);
      for (const task of tasks) {
        await this.taskRepo.update(task.id, {
          status: MessageTaskStatus.PENDING,
          nextRetryAt: new Date(Date.now() + 60_000),
        });
      }
      return;
    }

    // Pre-warm WhatsApp's server-side link preview cache before dispatching.
    // This polls Meta's getLinkPreview API until the server-side crawl completes
    // (typically 3-15s). Once cached, ALL subsequent sendMessage calls resolve
    // instantly via the browser's shared page context — every group gets the
    // same preview instead of only the ones that happen to hit a cached crawl.
    if (imageUrls.length === 0 && text) {
      try {
        await this.automationService.preWarmLinkPreview(sessionId, text);
      } catch {
        // Pre-warm is best-effort; continue without cached preview
      }
    }

    this.logger.log(`Admin #${adminId}: starting loop for ${tasks.length} tasks`);
    const warmUpMultiplier = 1.0;

    for (let i = 0; i < tasks.length; i++) {
      // Atomically claim the task to prevent concurrent dispatch loops from sending duplicates
      const claimResult = await this.taskRepo.update(
        { id: tasks[i].id, status: MessageTaskStatus.PENDING },
        { status: MessageTaskStatus.IN_PROGRESS }
      );
      if (claimResult.affected === 0) {
        this.logger.debug(`Task #${tasks[i].id} already claimed or no longer pending, skipping`);
        continue;
      }

      // Human-like per-message delay (skipped in local mode)
      if (this.MIN_DELAY_MS > 0) {
        const delayMs = this.MIN_DELAY_MS + Math.random() * (this.MAX_DELAY_MS - this.MIN_DELAY_MS);
        await this.sleep(delayMs);
      }

      // Batch pause (skipped in local mode)
      if (this.BATCH_PAUSE_MIN_MS > 0 && i > 0 && i % this.BATCH_SIZE === 0) {
        const pauseMs = this.BATCH_PAUSE_MIN_MS + Math.random() * (this.BATCH_PAUSE_MAX_MS - this.BATCH_PAUSE_MIN_MS);
        this.logger.debug(`Admin #${adminId}: pausing ${Math.round(pauseMs / 1000)}s after ${i} messages`);
        await this.sleep(pauseMs);
      }

      // Rate limiter check
      const rateCheck = this.rateLimiter.check(adminId, warmUpMultiplier);
      if (!rateCheck.allowed) {
        if (this.isLocal) {
          this.logger.warn(`Admin #${adminId} rate-limited at msg ${i + 1}/${tasks.length} — local mode, skipping wait`);
        } else {
          this.logger.warn(`Admin #${adminId} rate-limited at msg ${i + 1}/${tasks.length}, delaying 60s`);
          await this.sleep(this.RATE_LIMIT_RETRY_SLEEP_MS);
        }
        const retryCheck = this.rateLimiter.check(adminId, warmUpMultiplier);
        if (!retryCheck.allowed) {
          // Graceful: skip remaining tasks instead of failing them
          this.logger.warn(
            `Admin #${adminId} still rate-limited after 60s, skipping remaining ${tasks.length - i} tasks`,
          );
          for (let j = i; j < tasks.length; j++) {
            await this.taskRepo.update(tasks[j].id, {
              status: MessageTaskStatus.PENDING,
              nextRetryAt: new Date(Date.now() + 300_000),
            });
          }
          return;
        }
      }

      await this.deliverTaskWithRetry(tasks[i], sessionId, text, imageUrls);
    }
  }

  /**
   * Deliver a single task with inner retry loop (3 attempts with backoff).
   * Only the final failure is recorded to the attempt tracker.
   */
  private async deliverTaskWithRetry(
    task: MessageTask,
    sessionId: string,
    text: string,
    imageUrls: string[] = [],
  ): Promise<void> {
    const maxDeliveryAttempts = 3;
    let lastError: string | null = null;
    let lastCategory: ErrorCategory = ErrorCategory.UNKNOWN;
    let lastResponseTime = 0;

    for (let attempt = 1; attempt <= maxDeliveryAttempts; attempt++) {
      const result = await this.attemptDelivery(task, sessionId, text, imageUrls);

      if (result.success) {
        this.logger.log(
          `Task #${task.id} sent to group ${task.group?.name || task.group?.groupJid || '?'} ` +
            `via admin #${task.admin?.id} (attempt ${attempt})`,
        );
        return; // Success (attemptDelivery already recorded it via tracker)
      }

      lastError = result.errorMessage || null;
      lastCategory = result.errorCategory || ErrorCategory.UNKNOWN;
      lastResponseTime = result.responseTime || 0;

      // Rate-limited — wait with short backoff and retry within this loop,
      // like other transient errors. Do NOT defer to retry cron (that creates
      // a loop where the task gets rate-limited again immediately).
      if (lastCategory === ErrorCategory.RATE_LIMITED || lastCategory === ErrorCategory.SESSION_EXPIRED) {
        const backoffMs =
          lastCategory === ErrorCategory.RATE_LIMITED
            ? 15_000 * attempt // 15s, 30s, 45s — short enough to catch bucket refresh
            : 60_000;
        this.logger.warn(`Task #${task.id}: ${lastCategory} on attempt ${attempt} — retrying in ${backoffMs / 1000}s`);
        if (attempt < maxDeliveryAttempts) {
          await this.sleep(backoffMs);
          continue;
        }
        // Last attempt exhausted — mark as FAILED so tally/telemetry reflects it
        this.logger.error(`Task #${task.id} failed after ${maxDeliveryAttempts} attempts: ${lastError}`);
        await this.taskRepo.update(task.id, {
          status: MessageTaskStatus.FAILED,
          errorCategory: lastCategory,
          errorMessage: lastError || 'Max delivery attempts exceeded',
        });
        await this.maintenanceService.markGroupFailed(task.group.id);
        return;
      }

      if (attempt < maxDeliveryAttempts) {
        const backoffMs = 5_000 * attempt; // 5s, 10s
        this.logger.warn(
          `Task #${task.id} attempt ${attempt}/${maxDeliveryAttempts} failed: ${lastError} — retrying in ${backoffMs}ms`,
        );
        await this.sleep(backoffMs);
      }
    }

    // All attempts exhausted — update task directly
    this.logger.error(`Task #${task.id} failed after ${maxDeliveryAttempts} attempts: ${lastError}`);

    task.status = MessageTaskStatus.FAILED;
    task.errorCategory = lastCategory;
    task.errorMessage = lastError || 'Max delivery attempts exceeded';
    await this.taskRepo.update(task.id, {
      status: MessageTaskStatus.FAILED,
      errorCategory: lastCategory,
      errorMessage: lastError || 'Max delivery attempts exceeded',
    });
    await this.maintenanceService.markGroupFailed(task.group.id);
  }

  private async attemptDelivery(
    task: MessageTask,
    sessionId: string,
    text: string,
    imageUrls: string[] = [],
  ): Promise<DeliveryResult> {
    if (!task.group || !task.admin?.id) {
      return {
        success: false,
        errorCategory: ErrorCategory.UNKNOWN,
        errorMessage: 'Task missing group or admin',
        responseTime: 0,
      };
    }

    const adminId = task.admin.id;
    const workerId = task.workerId || `admin-${adminId}-sess-0`;
    const SEND_TIMEOUT_MS = 600_000;

    // Mark task as IN_PROGRESS directly
    await this.taskRepo.update(task.id, {
      status: MessageTaskStatus.IN_PROGRESS,
      attemptCount: task.attemptCount + 1,
      lastAttemptAt: new Date(),
    });

    const result = await new Promise<DeliveryResult>(resolve => {
      const timer = setTimeout(() => {
        resolve({
          success: false,
          errorCategory: ErrorCategory.TIMEOUT,
          errorMessage: `Send timed out after ${SEND_TIMEOUT_MS / 1000}s`,
          responseTime: SEND_TIMEOUT_MS,
        });
      }, SEND_TIMEOUT_MS);

      this.automationService
        .deliverMessage(sessionId, task.group.groupJid, text, adminId, workerId, imageUrls)
        .then(deliverResult => {
          clearTimeout(timer);
          resolve(deliverResult);
        })
        .catch(err => {
          clearTimeout(timer);
          resolve({
            success: false,
            errorCategory: ErrorCategory.UNKNOWN,
            errorMessage: `Send crashed: ${(err as Error).message}`,
            responseTime: 0,
          });
        });
    });

    // On success, update task status directly
    if (result.success) {
      const updateData: Partial<MessageTask> = { status: MessageTaskStatus.SENT };
      if (result.messageId) {
        updateData.waMessageId = result.messageId;
      }
      await this.taskRepo.update(task.id, updateData);
      await this.maintenanceService.markGroupSuccess(task.group.id);
    }

    return result;
  }

  /** Recalculate and persist broadcast counters. */
  async tallyBroadcast(broadcastId: number): Promise<void> {
    const [sent, failed, pending, total] = await Promise.all([
      this.taskRepo.count({ where: { broadcast: { id: broadcastId }, status: MessageTaskStatus.SENT } }),
      this.taskRepo.count({ where: { broadcast: { id: broadcastId }, status: MessageTaskStatus.FAILED } }),
      this.taskRepo.count({ where: { broadcast: { id: broadcastId }, status: MessageTaskStatus.PENDING } }),
      this.taskRepo.count({ where: { broadcast: { id: broadcastId } } }),
    ]);

    const broadcast = await this.broadcastRepo.findOne({ where: { id: broadcastId } });
    if (!broadcast) return;

    broadcast.sentCount = sent;
    broadcast.failedCount = failed;

    const done = sent + failed;
    if (done >= total && pending === 0) {
      broadcast.status =
        failed > 0 && sent > 0
          ? BroadcastStatus.PARTIAL
          : failed > 0
            ? BroadcastStatus.FAILED
            : BroadcastStatus.COMPLETED;
      broadcast.completedAt = new Date();
    }

    await this.broadcastRepo.save(broadcast);

    this.logger.log(
      `Broadcast #${broadcastId} tally: ${sent} sent, ${failed} failed, ${pending} pending (total ${total}) — status: ${broadcast.status}`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
