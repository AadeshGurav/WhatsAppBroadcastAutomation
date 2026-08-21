import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Indexes for hot query paths — cuts seq scans that burn Neon compute:
 *  - message_tasks: status + nextRetryAt filters (5-min retry cron), adminId FK
 *  - broadcast_events: status filter (stalled-broadcast scans), articleId FK
 *  - message_attempts: messageTaskId FK (per-attempt lookups)
 *  - scraper_activity_log / worker_session_logs: createdAt for retention prunes
 *  - whatsapp_groups: communityId FK
 */
export class ReduceDbFootprintIndexes1799000000000 implements MigrationInterface {
    name = 'ReduceDbFootprintIndexes1799000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mt_status" ON "message_tasks" ("status") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mt_next_retry_at" ON "message_tasks" ("nextRetryAt") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_mt_admin_id" ON "message_tasks" ("adminId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_be_status" ON "broadcast_events" ("status") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_be_article_id" ON "broadcast_events" ("articleId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_ma_message_task_id" ON "message_attempts" ("messageTaskId") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_sal_checked_at" ON "scraper_activity_log" ("checkedAt") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wsl_created_at" ON "worker_session_logs" ("createdAt") `);
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_wg_community_id" ON "whatsapp_groups" ("communityId") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_wg_community_id" `);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_wsl_created_at" `);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sal_checked_at" `);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_ma_message_task_id" `);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_be_article_id" `);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_be_status" `);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mt_admin_id" `);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mt_next_retry_at" `);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_mt_status" `);
    }

}
