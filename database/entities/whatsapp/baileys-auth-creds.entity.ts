import { Entity, Column, UpdateDateColumn } from 'typeorm';

/**
 * Baileys `AuthenticationCreds` blob for one WhatsApp session (one row per
 * sessionId). This is the noise/signal identity + registration state — small,
 * changes often (every `creds.update` event), and is the one piece of auth
 * state that MUST NOT be lost, since it can't be regenerated without a fresh
 * QR/pairing-code scan.
 *
 * Stored as a single JSON blob (via Baileys' own `BufferJSON` replacer, which
 * round-trips Buffers/Uint8Arrays safely) rather than modelled column-by-column,
 * because Baileys owns this shape and it grows fields across releases — mapping
 * it 1:1 to columns would break on every Baileys upgrade.
 */
@Entity('baileys_auth_creds')
export class BaileysAuthCreds {
  @Column({ type: 'text', name: 'session_id', primary: true })
  sessionId: string;

  @Column({ type: 'text', name: 'creds_json' })
  credsJson: string;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
