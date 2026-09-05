import { DataSource } from 'typeorm';
import { BufferJSON, initAuthCreds, proto } from 'baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from 'baileys';
import { BaileysAuthCreds } from '@database/entities/whatsapp/baileys-auth-creds.entity';
import { BaileysAuthKey } from '@database/entities/whatsapp/baileys-auth-key.entity';

/**
 * TypeORM-backed replacement for Baileys' own `useMultiFileAuthState`.
 *
 * Baileys' file-based helper is explicitly documented (in its own source
 * comment) as a reference implementation, not something to run in
 * production: "I wouldn't endorse this for any production level use other
 * than perhaps a bot. Would recommend writing an auth state for use with a
 * proper SQL or No-SQL DB". This is that DB-backed implementation, using the
 * same data shapes and the same `BufferJSON` (de)serializer Baileys itself
 * uses, so a value round-trips identically to the file-based version — we're
 * just swapping the storage medium, not the encoding.
 *
 * Session data on a phone-hosted deployment lives on the phone's own disk
 * (SQLite) or Postgres if configured, same as the rest of Senderrr's data —
 * there's no separate backup story to invent for this engine.
 */
export const useTypeOrmAuthState = async (
  dataSource: DataSource,
  sessionId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
  const credsRepo = dataSource.getRepository(BaileysAuthCreds);
  const keyRepo = dataSource.getRepository(BaileysAuthKey);

  const existingCreds = await credsRepo.findOne({ where: { sessionId } });
  const creds: AuthenticationCreds = existingCreds
    ? (JSON.parse(existingCreds.credsJson, BufferJSON.reviver) as AuthenticationCreds)
    : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          if (ids.length === 0) return data;

          const rows = await keyRepo.find({
            where: ids.map(keyId => ({ sessionId, category: type, keyId })),
          });

          for (const row of rows) {
            let value: unknown = JSON.parse(row.valueJson, BufferJSON.reviver);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }

            data[row.keyId] = value as SignalDataTypeMap[T];
          }

          return data;
        },
        set: async data => {
          const toUpsert: BaileysAuthKey[] = [];
          const toDelete: Array<{ sessionId: string; category: string; keyId: string }> = [];

          for (const category of Object.keys(data) as Array<keyof SignalDataTypeMap>) {
            const categoryData = data[category];
            if (!categoryData) continue;

            for (const keyId of Object.keys(categoryData)) {
              const value = categoryData[keyId];
              if (value === null || value === undefined) {
                toDelete.push({ sessionId, category: category, keyId });
              } else {
                const row = new BaileysAuthKey();
                row.sessionId = sessionId;
                row.category = category;
                row.keyId = keyId;
                row.valueJson = JSON.stringify(value, BufferJSON.replacer);
                toUpsert.push(row);
              }
            }
          }

          if (toUpsert.length > 0) {
            await keyRepo.save(toUpsert);
          }

          await Promise.all(toDelete.map(({ category, keyId }) => keyRepo.delete({ sessionId, category, keyId })));
        },
        clear: async () => {
          await keyRepo.delete({ sessionId });
        },
      },
    },
    saveCreds: async () => {
      await credsRepo.save({
        sessionId,
        credsJson: JSON.stringify(creds, BufferJSON.replacer),
      });
    },
  };
};

/** Wipes all persisted auth state for a session — used by `logout()`. */
export const clearTypeOrmAuthState = async (dataSource: DataSource, sessionId: string): Promise<void> => {
  await dataSource.getRepository(BaileysAuthKey).delete({ sessionId });
  await dataSource.getRepository(BaileysAuthCreds).delete({ sessionId });
};
