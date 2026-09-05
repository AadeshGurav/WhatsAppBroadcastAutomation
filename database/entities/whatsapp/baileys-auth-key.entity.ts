import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

/**
 * One Baileys Signal key-store entry: a (category, keyId) pair scoped to a
 * session. This is what `SignalKeyStore.get`/`set` reads and writes — pre-keys,
 * sessions, sender-keys, app-state-sync keys/versions, LID mappings, device
 * lists, tctokens, identity keys. Baileys' default file-based store is one
 * file per (category, id); this is the same idea as one row per (category, id)
 * instead of one row per session, because Baileys reads/writes small subsets
 * of keys independently and per-row storage avoids read/write amplification
 * on a session with thousands of keys.
 *
 * `valueJson` uses Baileys' `BufferJSON` replacer, exactly like the official
 * `useMultiFileAuthState` reference implementation, so Buffers/Uint8Arrays
 * round-trip correctly.
 */
@Entity('baileys_auth_keys')
@Index(['sessionId', 'category'])
export class BaileysAuthKey {
  @PrimaryColumn({ type: 'text', name: 'session_id' })
  sessionId: string;

  @PrimaryColumn({ type: 'text' })
  category: string;

  @PrimaryColumn({ type: 'text', name: 'key_id' })
  keyId: string;

  @Column({ type: 'text', name: 'value_json' })
  valueJson: string;
}
