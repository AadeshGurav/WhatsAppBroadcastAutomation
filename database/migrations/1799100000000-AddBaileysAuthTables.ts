import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tables backing the Baileys engine adapter's TypeORM auth store
 * (whatsapp-engine/stores/baileys-typeorm-auth.store.ts). Only used when
 * ENGINE_TYPE=baileys; harmless empty tables otherwise. SQLite creates these
 * via DATABASE_SYNCHRONIZE instead of this migration (see app.module.ts).
 */
export class AddBaileysAuthTables1799100000000 implements MigrationInterface {
  name = 'AddBaileysAuthTables1799100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "baileys_auth_creds" (
                "session_id" text PRIMARY KEY,
                "creds_json" text NOT NULL,
                "updated_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
    await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "baileys_auth_keys" (
                "session_id" text NOT NULL,
                "category" text NOT NULL,
                "key_id" text NOT NULL,
                "value_json" text NOT NULL,
                PRIMARY KEY ("session_id", "category", "key_id")
            )
        `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_bak_session_category" ON "baileys_auth_keys" ("session_id", "category")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_bak_session_category"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "baileys_auth_keys"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "baileys_auth_creds"`);
  }
}
