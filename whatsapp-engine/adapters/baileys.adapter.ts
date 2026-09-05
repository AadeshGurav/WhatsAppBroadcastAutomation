import { EventEmitter } from 'events';
import { Boom } from '@hapi/boom';
import { DataSource } from 'typeorm';
import * as qrcode from 'qrcode';
import makeWASocket, {
  AnyMessageContent,
  Browsers,
  DisconnectReason,
  WAMessage,
  WAMessageKey,
  WASocket,
  GroupMetadata,
  NewsletterMetadata,
} from 'baileys';
import {
  IWhatsAppEngine,
  EngineStatus,
  EngineEventCallbacks,
  MessageResult,
  MediaInput,
  IncomingMessage,
  Contact,
  Group,
  GroupInfo,
  GroupParticipant,
  LocationInput,
  ContactCard,
  MessageReaction,
  Label,
  Channel,
  ChannelMessage,
  Status,
  TextStatusOptions,
  StatusResult,
  Catalog,
  Product,
  ProductQueryOptions,
  PaginatedProducts,
} from '../interfaces/whatsapp-engine.interface';
import { createLogger } from '@common/services/logger.service';
import { useTypeOrmAuthState, clearTypeOrmAuthState } from '../stores/baileys-typeorm-auth.store';
import { BaileysLoggerAdapter } from './baileys-logger.adapter';

export interface BaileysConfig {
  sessionId: string;
  /**
   * When set, `initialize()` pairs by phone-number code instead of QR.
   * The code (an 8-character string, not a QR data-URL) is delivered
   * through the same `onQRCode` callback the QR flow uses — there is
   * intentionally no separate `onPairingCode` callback so this adapter
   * needs zero changes to the shared `IWhatsAppEngine` interface. The
   * caller distinguishes the two by knowing which mode it configured.
   */
  pairingPhoneNumber?: string;
  /** Display name shown on the phone's "Linked devices" screen. */
  browserName?: string;
}

/**
 * A small bounded insertion-order cache. Backs everything Baileys doesn't
 * expose a request/response query for (arbitrary historical-message lookup,
 * a full contacts directory, "list my labels", "list my subscribed
 * channels", "what's this person's current status"): those all arrive as a
 * stream of events in the multi-device protocol, not as something you can
 * ask the server for on demand, so the only honest way to serve them is to
 * remember what has flowed through since this process started. That is a
 * real, protocol-level difference from whatsapp-web.js (which can reach
 * into the browser's own already-synced IndexedDB), not an oversight — see
 * the class-level methods below for exactly where each cache is read.
 */
class BoundedCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly maxEntries: number) {}

  set(key: K, value: V): void {
    if (!this.map.has(key) && this.map.size >= this.maxEntries) {
      const oldest = Array.from(this.map.keys())[0];
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  values(): V[] {
    return [...this.map.values()];
  }

  delete(key: K): void {
    this.map.delete(key);
  }
}

/** whatsapp-web.js addresses 1:1 chats as `@c.us`; Baileys uses the protocol's
 *  own `@s.whatsapp.net`. Everything above this adapter — stored contact
 *  rows, webhook payloads, dashboards built against the wwebjs engine — was
 *  written against the `@c.us` convention, so normalize at this boundary
 *  rather than let the ID format change depending on which engine is
 *  configured. */
function toBaileysJid(id: string): string {
  return id.endsWith('@c.us') ? id.replace(/@c\.us$/, '@s.whatsapp.net') : id;
}
function toPortableId(jid: string): string {
  return jid.endsWith('@s.whatsapp.net') ? jid.replace(/@s\.whatsapp\.net$/, '@c.us') : jid;
}

function mediaInputToUpload(media: MediaInput): Buffer | { url: string } {
  if (typeof media.data === 'string') {
    if (media.data.startsWith('http://') || media.data.startsWith('https://')) {
      return { url: media.data };
    }
    return Buffer.from(media.data, 'base64');
  }
  return media.data;
}

export class BaileysAdapter extends EventEmitter implements IWhatsAppEngine {
  private readonly logger = createLogger('BaileysAdapter');
  private sock: WASocket | null = null;
  private status: EngineStatus = EngineStatus.DISCONNECTED;
  private qrCode: string | null = null;
  private phoneNumber: string | null = null;
  private pushName: string | null = null;
  private callbacks: EngineEventCallbacks = {};
  private saveCreds: (() => Promise<void>) | null = null;
  /** Set by disconnect()/logout()/destroy() so the reconnect handler knows
   *  a closed socket was deliberate, not a drop to recover from. */
  private intentionalClose = false;

  // See BoundedCache doc comment above for why these exist at all.
  private readonly messageCache = new BoundedCache<string, WAMessage>(500);
  private readonly contactCache = new BoundedCache<string, Contact>(2000);
  private readonly reactionCache = new BoundedCache<string, MessageReaction>(500);
  private readonly labelCache = new BoundedCache<string, Label>(50);
  private readonly chatLabelCache = new BoundedCache<string, Set<string>>(2000);
  private readonly channelCache = new BoundedCache<string, Channel>(200);
  private readonly channelMessageCache = new BoundedCache<string, ChannelMessage[]>(200);
  private readonly statusCache = new BoundedCache<string, Status>(500);
  private readonly groupMetadataCache = new BoundedCache<string, GroupMetadata>(500);

  constructor(
    private readonly config: BaileysConfig,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async initialize(callbacks: EngineEventCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.intentionalClose = false;
    this.setStatus(EngineStatus.INITIALIZING);

    try {
      const { state, saveCreds } = await useTypeOrmAuthState(this.dataSource, this.config.sessionId);
      this.saveCreds = saveCreds;

      this.sock = makeWASocket({
        auth: state,
        logger: new BaileysLoggerAdapter(this.logger),
        browser: Browsers.ubuntu(this.config.browserName || 'Senderrr'),
        syncFullHistory: false,
        getMessage: (key: WAMessageKey) => {
          const cached = key.id ? this.messageCache.get(key.id) : undefined;
          return Promise.resolve(cached?.message ?? undefined);
        },
        cachedGroupMetadata: (jid: string) => Promise.resolve(this.groupMetadataCache.get(jid)),
      });

      this.setupEventHandlers();

      if (this.config.pairingPhoneNumber && !this.sock.authState.creds.registered) {
        const code = await this.sock.requestPairingCode(this.config.pairingPhoneNumber);
        this.qrCode = code;
        this.setStatus(EngineStatus.QR_READY);
        this.callbacks.onQRCode?.(code);
      }
    } catch (error) {
      this.setStatus(EngineStatus.FAILED);
      throw error;
    }
  }

  private setupEventHandlers(): void {
    if (!this.sock) return;
    const sock = this.sock;

    sock.ev.on('creds.update', () => {
      this.saveCreds?.().catch((error: unknown) => {
        this.logger.error('Failed to persist Baileys creds', String(error));
      });
    });

    sock.ev.on('connection.update', update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !this.config.pairingPhoneNumber) {
        qrcode
          .toDataURL(qr)
          .then(dataUrl => {
            this.qrCode = dataUrl;
            this.setStatus(EngineStatus.QR_READY);
            this.callbacks.onQRCode?.(dataUrl);
          })
          .catch(error => this.logger.error('Failed to render QR code', String(error)));
      }

      if (connection === 'open') {
        this.qrCode = null;
        this.phoneNumber = toPortableId(sock.user?.id || '').split('@')[0] || null;
        this.pushName = sock.user?.name || sock.user?.notify || null;
        this.setStatus(EngineStatus.READY);
        this.callbacks.onReady?.(this.phoneNumber || '', this.pushName || '');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        this.setStatus(EngineStatus.DISCONNECTED);
        this.callbacks.onDisconnected?.(
          loggedOut ? 'Logged out' : String(lastDisconnect?.error || 'Connection closed'),
        );

        if (!this.intentionalClose && !loggedOut) {
          // Simple fixed-delay reconnect. Production hardening (exponential
          // backoff, a retry cap, jitter) is a deliberate follow-up, not an
          // oversight — this is enough to survive normal network blips.
          setTimeout(() => {
            this.initialize(this.callbacks).catch(error =>
              this.logger.error('Baileys reconnect failed', String(error)),
            );
          }, 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (!msg.key.id) continue;
        this.messageCache.set(msg.key.id, msg);

        if (!msg.message) continue;
        const chatId = toPortableId(msg.key.remoteJid || '');
        if (msg.key.remoteJid === 'status@broadcast') {
          const senderId = toPortableId(msg.key.participant || '');
          const c = msg.message;
          const statusType: 'text' | 'image' | 'video' = c.imageMessage ? 'image' : c.videoMessage ? 'video' : 'text';
          const senderContact = this.contactCache.get(senderId);
          const status: Status = {
            id: msg.key.id,
            contact: { id: senderId, name: senderContact?.name, pushName: senderContact?.pushName },
            type: statusType,
            caption: c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption || undefined,
            backgroundColor: c.extendedTextMessage?.contextInfo == null ? undefined : undefined,
            timestamp: new Date(Number(msg.messageTimestamp || 0) * 1000),
            expiresAt: new Date((Number(msg.messageTimestamp || 0) + 86400) * 1000),
          };
          this.statusCache.set(msg.key.id, status);
          continue;
        }

        if (msg.key.remoteJid?.endsWith('@newsletter')) {
          const channelId = msg.key.remoteJid;
          const content = msg.message;
          const list = this.channelMessageCache.get(channelId) || [];
          list.unshift({
            id: msg.key.id,
            body:
              content.conversation ||
              content.extendedTextMessage?.text ||
              content.imageMessage?.caption ||
              content.videoMessage?.caption ||
              '',
            timestamp: Number(msg.messageTimestamp || 0),
            hasMedia: !!(content.imageMessage || content.videoMessage),
            mediaUrl: undefined,
          });
          this.channelMessageCache.set(channelId, list.slice(0, 200));
          continue;
        }

        const content = msg.message;
        const text =
          content.conversation ||
          content.extendedTextMessage?.text ||
          content.imageMessage?.caption ||
          content.videoMessage?.caption ||
          content.documentMessage?.caption ||
          '';

        const incoming: IncomingMessage = {
          id: msg.key.id,
          from: toPortableId(msg.key.participant || msg.key.remoteJid || ''),
          to: toPortableId(sock.user?.id || ''),
          chatId,
          body: text,
          type: Object.keys(content)[0] || 'unknown',
          timestamp: Number(msg.messageTimestamp || 0),
          fromMe: !!msg.key.fromMe,
          isGroup: chatId.endsWith('@g.us'),
        };

        if (content.locationMessage) {
          incoming.location = {
            latitude: content.locationMessage.degreesLatitude || 0,
            longitude: content.locationMessage.degreesLongitude || 0,
            description: content.locationMessage.name || undefined,
            address: content.locationMessage.address || undefined,
          };
        }

        const mediaMsg =
          content.imageMessage || content.videoMessage || content.audioMessage || content.documentMessage;
        if (mediaMsg) {
          incoming.media = {
            mimetype: mediaMsg.mimetype || 'application/octet-stream',
            filename: content.documentMessage?.fileName || undefined,
            // Baileys requires a separate downloadMediaMessage() call with
            // the full message object, which needs the decryption keys on
            // `content`; we don't eagerly download every inbound media
            // message here to avoid pulling large files for messages
            // nothing ends up acting on. Callers that need the bytes should
            // fetch them via the same message cache this adapter keeps.
            data: undefined,
          };
        }

        const quoted = content.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedId = content.extendedTextMessage?.contextInfo?.stanzaId;
        if (quoted && quotedId) {
          incoming.quotedMessage = {
            id: quotedId,
            body: quoted.conversation || quoted.extendedTextMessage?.text || '',
          };
        }

        this.callbacks.onMessage?.(incoming);
      }
    });

    sock.ev.on('messages.update', updates => {
      for (const { key, update } of updates) {
        const ack = update.status;
        if (key.id && typeof ack === 'number') {
          this.callbacks.onMessageAck?.(key.id, ack);
        }
      }
    });

    sock.ev.on('messages.reaction', reactions => {
      for (const { key, reaction } of reactions) {
        if (!key.id) continue;
        const existing = this.reactionCache.get(key.id) || { emoji: reaction.text || '', senders: [] };
        existing.senders = existing.senders.filter(s => s.senderId !== reaction.key?.participant);
        if (reaction.text) {
          existing.emoji = reaction.text;
          existing.senders.push({
            senderId: toPortableId(reaction.key?.participant || ''),
            emoji: reaction.text,
            timestamp: Date.now(),
          });
        }
        this.reactionCache.set(key.id, existing);
      }
    });

    sock.ev.on('contacts.upsert', contacts => {
      for (const c of contacts) {
        this.contactCache.set(toPortableId(c.id), {
          id: toPortableId(c.id),
          name: c.name || undefined,
          pushName: c.notify || undefined,
          number: toPortableId(c.id).split('@')[0],
          isMyContact: true,
          isBlocked: false,
        });
      }
    });

    sock.ev.on('contacts.update', updates => {
      for (const c of updates) {
        if (!c.id) continue;
        const existing = this.contactCache.get(toPortableId(c.id));
        if (existing) {
          if (c.name) existing.name = c.name;
          if (c.notify) existing.pushName = c.notify;
          this.contactCache.set(toPortableId(c.id), existing);
        }
      }
    });

    sock.ev.on('blocklist.set', ({ blocklist }) => {
      for (const jid of blocklist) {
        const existing = this.contactCache.get(toPortableId(jid));
        if (existing) existing.isBlocked = true;
      }
    });

    sock.ev.on('groups.upsert', groups => {
      for (const g of groups) this.groupMetadataCache.set(g.id, g);
    });
    sock.ev.on('groups.update', updates => {
      for (const u of updates) {
        if (!u.id) continue;
        const existing = this.groupMetadataCache.get(u.id);
        if (existing) this.groupMetadataCache.set(u.id, { ...existing, ...u });
      }
    });

    sock.ev.on('labels.edit', label => {
      this.labelCache.set(label.id, { id: label.id, name: label.name, hexColor: label.color?.toString() || '' });
    });
    sock.ev.on('labels.association', ({ association, type }) => {
      const chatId = toPortableId((association as { chatId?: string }).chatId || '');
      const labelId = (association as { labelId?: string }).labelId || '';
      if (!chatId || !labelId) return;
      const set = this.chatLabelCache.get(chatId) || new Set<string>();
      if (type === 'add') set.add(labelId);
      else set.delete(labelId);
      this.chatLabelCache.set(chatId, set);
    });
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.callbacks.onStateChanged?.(status);
    this.emit('stateChanged', status);
  }

  private ensureReady(): WASocket {
    if (this.status !== EngineStatus.READY || !this.sock) {
      throw new Error('Baileys engine is not ready');
    }
    return this.sock;
  }

  disconnect(): Promise<void> {
    this.intentionalClose = true;
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  async logout(): Promise<void> {
    this.intentionalClose = true;
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (error) {
        this.logger.warn('Baileys logout failed, forcing disconnect', String(error));
        this.sock.end(undefined);
      }
      this.sock = null;
    }
    await clearTypeOrmAuthState(this.dataSource, this.config.sessionId);
    this.setStatus(EngineStatus.DISCONNECTED);
  }

  destroy(): Promise<void> {
    this.intentionalClose = true;
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.setStatus(EngineStatus.DISCONNECTED);
    return Promise.resolve();
  }

  getStatus(): EngineStatus {
    return this.status;
  }
  getQRCode(): string | null {
    return this.qrCode;
  }
  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }
  getPushName(): string | null {
    return this.pushName;
  }

  // ==========================================================================
  // Messaging - Basic
  // ==========================================================================

  private toResult(msg: WAMessage | undefined): MessageResult {
    if (!msg?.key?.id) throw new Error('Baileys did not return a message key');
    return { id: msg.key.id, timestamp: Number(msg.messageTimestamp || Date.now() / 1000), ack: 0 };
  }

  async sendTextMessage(chatId: string, text: string, options?: { linkPreview?: boolean }): Promise<MessageResult> {
    const sock = this.ensureReady();
    // Baileys generates its own link previews when linkPreview isn't
    // explicitly disabled; there is no wwebjs-style warmUpLinkPreview()
    // workaround to wire up here (see the interface's optional method).
    const content: AnyMessageContent = { text, linkPreview: options?.linkPreview === false ? null : undefined };
    const msg = await sock.sendMessage(toBaileysJid(chatId), content);
    return this.toResult(msg);
  }

  async sendImageMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    const sock = this.ensureReady();
    const msg = await sock.sendMessage(toBaileysJid(chatId), {
      image: mediaInputToUpload(media),
      caption: media.caption,
      mimetype: media.mimetype,
    });
    return this.toResult(msg);
  }

  async sendAlbumMessage(chatId: string, mediaArray: MediaInput[], caption?: string): Promise<MessageResult> {
    const sock = this.ensureReady();
    // Baileys has no distinct "album" wire message — WhatsApp's album view is
    // the client grouping consecutive media messages sent back-to-back, so
    // we send each item as its own message and return the first one's
    // result (matching the single MessageResult the interface expects).
    let first: WAMessage | undefined;
    for (let i = 0; i < mediaArray.length; i++) {
      const media = mediaArray[i];
      const isVideo = media.mimetype.startsWith('video/');
      const msg = await sock.sendMessage(
        toBaileysJid(chatId),
        isVideo
          ? { video: mediaInputToUpload(media), caption: i === 0 ? caption : media.caption, mimetype: media.mimetype }
          : { image: mediaInputToUpload(media), caption: i === 0 ? caption : media.caption, mimetype: media.mimetype },
      );
      if (!first) first = msg;
    }
    return this.toResult(first);
  }

  async sendVideoMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    const sock = this.ensureReady();
    const msg = await sock.sendMessage(toBaileysJid(chatId), {
      video: mediaInputToUpload(media),
      caption: media.caption,
      mimetype: media.mimetype,
    });
    return this.toResult(msg);
  }

  async sendAudioMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    const sock = this.ensureReady();
    const msg = await sock.sendMessage(toBaileysJid(chatId), {
      audio: mediaInputToUpload(media),
      mimetype: media.mimetype || 'audio/ogg; codecs=opus',
      ptt: media.mimetype?.includes('ogg'),
    });
    return this.toResult(msg);
  }

  async sendDocumentMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    const sock = this.ensureReady();
    const msg = await sock.sendMessage(toBaileysJid(chatId), {
      document: mediaInputToUpload(media),
      mimetype: media.mimetype,
      fileName: media.filename || 'file',
      caption: media.caption,
    });
    return this.toResult(msg);
  }

  // ==========================================================================
  // Messaging - Extended
  // ==========================================================================

  async sendLocationMessage(chatId: string, location: LocationInput): Promise<MessageResult> {
    const sock = this.ensureReady();
    const msg = await sock.sendMessage(toBaileysJid(chatId), {
      location: {
        degreesLatitude: location.latitude,
        degreesLongitude: location.longitude,
        name: location.description,
        address: location.address,
      },
    });
    return this.toResult(msg);
  }

  async sendContactMessage(chatId: string, contact: ContactCard): Promise<MessageResult> {
    const sock = this.ensureReady();
    const vcard =
      'BEGIN:VCARD\n' +
      'VERSION:3.0\n' +
      `FN:${contact.name}\n` +
      `TEL;type=CELL;type=VOICE;waid=${contact.number.replace(/\D/g, '')}:${contact.number}\n` +
      'END:VCARD';
    const msg = await sock.sendMessage(toBaileysJid(chatId), {
      contacts: { displayName: contact.name, contacts: [{ displayName: contact.name, vcard }] },
    });
    return this.toResult(msg);
  }

  async sendStickerMessage(chatId: string, media: MediaInput): Promise<MessageResult> {
    const sock = this.ensureReady();
    const msg = await sock.sendMessage(toBaileysJid(chatId), { sticker: mediaInputToUpload(media) });
    return this.toResult(msg);
  }

  // ==========================================================================
  // Reply & Forward
  // ==========================================================================

  async replyToMessage(chatId: string, quotedMsgId: string, text: string): Promise<MessageResult> {
    const sock = this.ensureReady();
    const quoted = this.messageCache.get(quotedMsgId);
    if (!quoted) {
      this.logger.warn(`replyToMessage: original message ${quotedMsgId} not in cache, sending without quote`);
      return this.sendTextMessage(chatId, text);
    }
    const msg = await sock.sendMessage(toBaileysJid(chatId), { text }, { quoted });
    return this.toResult(msg);
  }

  async forwardMessage(fromChatId: string, toChatId: string, messageId: string): Promise<MessageResult> {
    const sock = this.ensureReady();
    const original = this.messageCache.get(messageId);
    if (!original) throw new Error(`forwardMessage: source message ${messageId} not found in local cache`);
    const msg = await sock.sendMessage(toBaileysJid(toChatId), { forward: original });
    return this.toResult(msg);
  }

  // ==========================================================================
  // Reactions
  // ==========================================================================

  async reactToMessage(chatId: string, messageId: string, emoji: string): Promise<void> {
    const sock = this.ensureReady();
    const cached = this.messageCache.get(messageId);
    const key: WAMessageKey = cached?.key || { remoteJid: toBaileysJid(chatId), id: messageId, fromMe: false };
    await sock.sendMessage(toBaileysJid(chatId), { react: { text: emoji, key } });
  }

  getMessageReactions(chatId: string, messageId: string): Promise<MessageReaction[]> {
    const cached = this.reactionCache.get(messageId);
    return Promise.resolve(cached ? [cached] : []);
  }

  // ==========================================================================
  // Contacts
  // ==========================================================================

  getContacts(): Promise<Contact[]> {
    // No "list all contacts" RPC exists in the multi-device protocol either —
    // the app-side contacts list wwebjs reads is synced into the browser's
    // own storage by WhatsApp Web's JS. Baileys instead streams contacts via
    // contacts.upsert/contacts.update as they're seen, so this returns
    // whatever has flowed through since this process last connected.
    return Promise.resolve(this.contactCache.values());
  }

  async getContactById(contactId: string): Promise<Contact | null> {
    const cached = this.contactCache.get(toPortableId(toBaileysJid(contactId)));
    if (cached) return cached;
    const sock = this.ensureReady();
    const jid = toBaileysJid(contactId);
    const results = await sock.onWhatsApp(jid);
    const result = results?.[0];
    if (!result?.exists) return null;
    const contact: Contact = {
      id: toPortableId(result.jid),
      number: toPortableId(result.jid).split('@')[0],
      isMyContact: false,
      isBlocked: false,
    };
    this.contactCache.set(contact.id, contact);
    return contact;
  }

  async checkNumberExists(number: string): Promise<boolean> {
    const sock = this.ensureReady();
    const jid = toBaileysJid(number.includes('@') ? number : `${number}@c.us`);
    const results = await sock.onWhatsApp(jid);
    return !!results?.[0]?.exists;
  }

  // ==========================================================================
  // Groups - Basic
  // ==========================================================================

  private toGroup(meta: GroupMetadata): Group {
    const me = toBaileysJid(this.phoneNumber ? `${this.phoneNumber}@c.us` : '');
    const participant = meta.participants.find(p => p.id === me);
    return {
      id: meta.id,
      name: meta.subject,
      participantsCount: meta.participants.length,
      isAdmin: participant?.admin === 'admin' || participant?.admin === 'superadmin',
    };
  }

  async getGroups(): Promise<Group[]> {
    const sock = this.ensureReady();
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all);
    for (const g of groups) this.groupMetadataCache.set(g.id, g);
    return groups.filter(g => !g.isCommunity).map(g => this.toGroup(g));
  }

  async getCommunities(): Promise<Group[]> {
    const sock = this.ensureReady();
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all);
    for (const g of groups) this.groupMetadataCache.set(g.id, g);
    return groups.filter(g => g.isCommunity).map(g => this.toGroup(g));
  }

  // ==========================================================================
  // Groups - Extended
  // ==========================================================================

  private toParticipant(p: GroupMetadata['participants'][number]): GroupParticipant {
    return {
      id: toPortableId(p.id),
      number: toPortableId(p.id).split('@')[0],
      name: p.name || undefined,
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
      isSuperAdmin: p.admin === 'superadmin',
    };
  }

  async getGroupInfo(groupId: string): Promise<GroupInfo | null> {
    const sock = this.ensureReady();
    try {
      const meta = await sock.groupMetadata(toBaileysJid(groupId));
      this.groupMetadataCache.set(meta.id, meta);
      return {
        id: meta.id,
        name: meta.subject,
        description: meta.desc || undefined,
        owner: meta.owner ? toPortableId(meta.owner) : undefined,
        createdAt: meta.creation,
        participants: meta.participants.map(p => this.toParticipant(p)),
        isReadOnly: meta.announce,
        isAnnounce: meta.announce,
      };
    } catch {
      return null;
    }
  }

  async createGroup(name: string, participants: string[]): Promise<Group> {
    const sock = this.ensureReady();
    const meta = await sock.groupCreate(name, participants.map(toBaileysJid));
    this.groupMetadataCache.set(meta.id, meta);
    return this.toGroup(meta);
  }

  async addParticipants(groupId: string, participants: string[]): Promise<void> {
    const sock = this.ensureReady();
    await sock.groupParticipantsUpdate(toBaileysJid(groupId), participants.map(toBaileysJid), 'add');
  }

  async removeParticipants(groupId: string, participants: string[]): Promise<void> {
    const sock = this.ensureReady();
    await sock.groupParticipantsUpdate(toBaileysJid(groupId), participants.map(toBaileysJid), 'remove');
  }

  async promoteParticipants(groupId: string, participants: string[]): Promise<void> {
    const sock = this.ensureReady();
    await sock.groupParticipantsUpdate(toBaileysJid(groupId), participants.map(toBaileysJid), 'promote');
  }

  async demoteParticipants(groupId: string, participants: string[]): Promise<void> {
    const sock = this.ensureReady();
    await sock.groupParticipantsUpdate(toBaileysJid(groupId), participants.map(toBaileysJid), 'demote');
  }

  async leaveGroup(groupId: string): Promise<void> {
    const sock = this.ensureReady();
    await sock.groupLeave(toBaileysJid(groupId));
    this.groupMetadataCache.delete(toBaileysJid(groupId));
  }

  async setGroupSubject(groupId: string, subject: string): Promise<void> {
    const sock = this.ensureReady();
    await sock.groupUpdateSubject(toBaileysJid(groupId), subject);
  }

  async setGroupDescription(groupId: string, description: string): Promise<void> {
    const sock = this.ensureReady();
    await sock.groupUpdateDescription(toBaileysJid(groupId), description);
  }

  async getGroupInviteCode(groupId: string): Promise<string> {
    const sock = this.ensureReady();
    const code = await sock.groupInviteCode(toBaileysJid(groupId));
    if (!code) throw new Error(`No invite code returned for group ${groupId} (check admin permissions)`);
    return code;
  }

  async revokeGroupInviteCode(groupId: string): Promise<string> {
    const sock = this.ensureReady();
    const code = await sock.groupRevokeInvite(toBaileysJid(groupId));
    if (!code) throw new Error(`No invite code returned after revoke for group ${groupId}`);
    return code;
  }

  // ==========================================================================
  // Message Operations
  // ==========================================================================

  async deleteMessage(chatId: string, messageId: string, forEveryone?: boolean): Promise<void> {
    const sock = this.ensureReady();
    const cached = this.messageCache.get(messageId);
    const key: WAMessageKey = cached?.key || { remoteJid: toBaileysJid(chatId), id: messageId, fromMe: true };
    if (forEveryone === false) {
      // Baileys/WhatsApp multi-device only expose revoke-for-everyone through
      // this API — there is no protocol equivalent of wwebjs's client-only
      // "delete for me" to fall back to, so we say so rather than silently
      // performing a for-everyone delete the caller didn't ask for.
      this.logger.warn('deleteMessage: Baileys only supports delete-for-everyone; forEveryone:false is not supported');
      return;
    }
    await sock.sendMessage(toBaileysJid(chatId), { delete: key });
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<MessageResult> {
    const sock = this.ensureReady();
    const cached = this.messageCache.get(messageId);
    const key: WAMessageKey = cached?.key || { remoteJid: toBaileysJid(chatId), id: messageId, fromMe: true };
    const msg = await sock.sendMessage(toBaileysJid(chatId), { text, edit: key });
    return this.toResult(msg);
  }

  // ==========================================================================
  // Contact Extended Operations
  // ==========================================================================

  async getProfilePicture(contactId: string): Promise<string | null> {
    const sock = this.ensureReady();
    try {
      return (await sock.profilePictureUrl(toBaileysJid(contactId), 'image')) || null;
    } catch {
      // No profile picture set, or privacy settings hide it — not an error.
      return null;
    }
  }

  async blockContact(contactId: string): Promise<void> {
    const sock = this.ensureReady();
    await sock.updateBlockStatus(toBaileysJid(contactId), 'block');
    const c = this.contactCache.get(toPortableId(toBaileysJid(contactId)));
    if (c) c.isBlocked = true;
  }

  async unblockContact(contactId: string): Promise<void> {
    const sock = this.ensureReady();
    await sock.updateBlockStatus(toBaileysJid(contactId), 'unblock');
    const c = this.contactCache.get(toPortableId(toBaileysJid(contactId)));
    if (c) c.isBlocked = false;
  }

  // ==========================================================================
  // Labels (WhatsApp Business)
  // ==========================================================================

  async getLabels(): Promise<Label[]> {
    // Baileys exposes label mutations (labels.edit / label-association RPCs)
    // but there is no "list all labels" query in the protocol — the labels
    // list is a WhatsApp Business app-local concept mirrored to linked
    // devices only via the labels.edit event stream, so this is the same
    // event-sourced cache pattern as contacts/channels above.
    return Promise.resolve(this.labelCache.values());
  }

  getLabelById(labelId: string): Promise<Label | null> {
    return Promise.resolve(this.labelCache.get(labelId) || null);
  }

  getChatLabels(chatId: string): Promise<Label[]> {
    const ids = this.chatLabelCache.get(toPortableId(toBaileysJid(chatId)));
    if (!ids) return Promise.resolve([]);
    return Promise.resolve([...ids].map(id => this.labelCache.get(id)).filter((l): l is Label => !!l));
  }

  async addLabelToChat(chatId: string, labelId: string): Promise<void> {
    const sock = this.ensureReady();
    await sock.addChatLabel(toBaileysJid(chatId), labelId);
    const set = this.chatLabelCache.get(toPortableId(toBaileysJid(chatId))) || new Set<string>();
    set.add(labelId);
    this.chatLabelCache.set(toPortableId(toBaileysJid(chatId)), set);
  }

  async removeLabelFromChat(chatId: string, labelId: string): Promise<void> {
    const sock = this.ensureReady();
    await sock.removeChatLabel(toBaileysJid(chatId), labelId);
    const set = this.chatLabelCache.get(toPortableId(toBaileysJid(chatId)));
    set?.delete(labelId);
  }

  // ==========================================================================
  // Channels / Newsletters
  // ==========================================================================

  private toChannel(meta: NewsletterMetadata): Channel {
    return {
      id: meta.id,
      name: meta.name,
      description: meta.description,
      inviteCode: meta.invite,
      subscriberCount: meta.subscribers,
      picture: meta.picture?.url,
      verified: meta.verification === 'VERIFIED',
      createdAt: meta.creation_time,
    };
  }

  getSubscribedChannels(): Promise<Channel[]> {
    // As with labels/contacts: no "list my newsletters" RPC exists, so this
    // returns whatever this adapter has explicitly subscribed to or looked
    // up since it started.
    return Promise.resolve(this.channelCache.values());
  }

  async getChannelById(channelId: string): Promise<Channel | null> {
    const sock = this.ensureReady();
    try {
      const meta = await sock.newsletterMetadata('jid', channelId);
      if (!meta) return null;
      const channel = this.toChannel(meta);
      this.channelCache.set(channel.id, channel);
      return channel;
    } catch {
      return null;
    }
  }

  async subscribeToChannel(inviteCode: string): Promise<Channel> {
    const sock = this.ensureReady();
    const meta = await sock.newsletterMetadata('invite', inviteCode);
    if (!meta) throw new Error(`No channel found for invite code ${inviteCode}`);
    await sock.newsletterFollow(meta.id);
    // Following alone doesn't start delivering the channel's messages through
    // the normal event stream — this opts into live updates so incoming posts
    // arrive via messages.upsert like any other chat (see the newsletter
    // branch added to that handler, and the note on getChannelMessages below).
    await sock.subscribeNewsletterUpdates(meta.id).catch(() => undefined);
    const channel = this.toChannel(meta);
    this.channelCache.set(channel.id, channel);
    return channel;
  }

  async unsubscribeFromChannel(channelId: string): Promise<void> {
    const sock = this.ensureReady();
    await sock.newsletterUnfollow(channelId);
    this.channelCache.delete(channelId);
  }

  getChannelMessages(channelId: string, limit?: number): Promise<ChannelMessage[]> {
    // `newsletterFetchMessages` (the raw history-fetch RPC) returns an
    // undecoded XMPP binary node, not parsed WAMessage objects — Baileys
    // doesn't expose a public decoder for that node shape, and hand-rolling
    // one from protocol guesswork is exactly the kind of "looks done but
    // silently wrong" shortcut this build avoids. Channel posts instead flow
    // through the same messages.upsert stream as regular chat messages once
    // subscribeNewsletterUpdates() is on (done in subscribeToChannel), so we
    // serve this from that event-sourced cache — same honest pattern as
    // contacts/labels/statuses elsewhere in this adapter.
    const cached = this.channelMessageCache.get(channelId) || [];
    return Promise.resolve(limit ? cached.slice(0, limit) : cached);
  }

  // ==========================================================================
  // Status / Stories
  // ==========================================================================

  getContactStatuses(): Promise<Status[]> {
    return Promise.resolve(this.statusCache.values());
  }

  getContactStatus(contactId: string): Promise<Status[]> {
    const jid = toPortableId(toBaileysJid(contactId));
    return Promise.resolve(this.statusCache.values().filter(s => s.contact.id === jid));
  }

  /**
   * Baileys status updates are, like regular messages, end-to-end encrypted
   * individually per viewer — the socket needs the JID list of who should be
   * able to decrypt the update (`statusJidList`). We pass every contact this
   * adapter has observed; there's no "everyone in my address book" RPC to
   * ask Baileys for instead, so — same as the caches above — this is only as
   * complete as what has flowed through `contacts.upsert` so far.
   */
  private get statusJidList(): string[] {
    return this.contactCache.values().map(c => toBaileysJid(c.id));
  }

  async postTextStatus(text: string, options?: TextStatusOptions): Promise<StatusResult> {
    const sock = this.ensureReady();
    const msg = await sock.sendMessage(
      'status@broadcast',
      { text, backgroundColor: options?.backgroundColor, font: options?.font } as AnyMessageContent,
      { statusJidList: this.statusJidList },
    );
    if (msg?.key.id) this.messageCache.set(msg.key.id, msg);
    const timestamp = new Date();
    return { statusId: msg?.key.id || '', timestamp, expiresAt: new Date(timestamp.getTime() + 86400000) };
  }

  async postImageStatus(media: MediaInput, caption?: string): Promise<StatusResult> {
    const sock = this.ensureReady();
    const msg = await sock.sendMessage(
      'status@broadcast',
      { image: mediaInputToUpload(media), caption, mimetype: media.mimetype },
      { statusJidList: this.statusJidList },
    );
    if (msg?.key.id) this.messageCache.set(msg.key.id, msg);
    const timestamp = new Date();
    return { statusId: msg?.key.id || '', timestamp, expiresAt: new Date(timestamp.getTime() + 86400000) };
  }

  async postVideoStatus(media: MediaInput, caption?: string): Promise<StatusResult> {
    const sock = this.ensureReady();
    const msg = await sock.sendMessage(
      'status@broadcast',
      { video: mediaInputToUpload(media), caption, mimetype: media.mimetype },
      { statusJidList: this.statusJidList },
    );
    if (msg?.key.id) this.messageCache.set(msg.key.id, msg);
    const timestamp = new Date();
    return { statusId: msg?.key.id || '', timestamp, expiresAt: new Date(timestamp.getTime() + 86400000) };
  }

  async deleteStatus(statusId: string): Promise<void> {
    const sock = this.ensureReady();
    const cached = this.messageCache.get(statusId);
    const key: WAMessageKey = cached?.key || { remoteJid: 'status@broadcast', id: statusId, fromMe: true };
    await sock.sendMessage('status@broadcast', { delete: key });
    this.statusCache.delete(statusId);
  }

  // ==========================================================================
  // Catalog (WhatsApp Business)
  // ==========================================================================

  private toProduct(p: {
    id: string;
    name?: string;
    description?: string;
    priceAmount1000?: number;
    currency?: string;
    imageUrls?: { requested?: string };
    productImage?: { imageUrl?: string };
    url?: string;
    availability?: string;
    retailerId?: string;
  }): Product {
    const price = (p.priceAmount1000 || 0) / 1000;
    return {
      id: p.id,
      name: p.name || '',
      description: p.description,
      price,
      currency: p.currency || '',
      priceFormatted: p.currency ? `${price} ${p.currency}` : String(price),
      imageUrl: p.imageUrls?.requested || p.productImage?.imageUrl,
      url: p.url || '',
      isAvailable: p.availability !== 'out of stock',
      retailerId: p.retailerId,
    };
  }

  async getCatalog(): Promise<Catalog | null> {
    const sock = this.ensureReady();
    try {
      const { products } = await sock.getCatalog({});
      const jid = sock.user?.id;
      return {
        id: jid ? toPortableId(jid) : '',
        name: this.pushName || '',
        productCount: products.length,
        url: jid ? `https://wa.me/c/${toPortableId(jid).split('@')[0]}` : '',
      };
    } catch {
      return null;
    }
  }

  async getProducts(options?: ProductQueryOptions): Promise<PaginatedProducts> {
    const sock = this.ensureReady();
    const limit = options?.limit || 20;
    const page = options?.page || 1;
    const { products } = await sock.getCatalog({ limit: limit * page });
    const start = (page - 1) * limit;
    const pageItems = products.slice(start, start + limit);
    return {
      products: pageItems.map(p => this.toProduct(p as never)),
      pagination: { page, limit, total: products.length, totalPages: Math.ceil(products.length / limit) || 1 },
    };
  }

  async getProduct(productId: string): Promise<Product | null> {
    const sock = this.ensureReady();
    try {
      const { products } = await sock.getCatalog({});
      const found = products.find(p => p.id === productId);
      return found ? this.toProduct(found) : null;
    } catch {
      return null;
    }
  }

  async sendProduct(chatId: string, productId: string, body?: string): Promise<MessageResult> {
    const sock = this.ensureReady();
    const product = await this.getProduct(productId);
    if (!product) throw new Error(`Product ${productId} not found in catalog`);
    const msg = await sock.sendMessage(toBaileysJid(chatId), {
      product: {
        productId,
        title: product.name,
        description: product.description,
        currencyCode: product.currency,
        priceAmount1000: Math.round(product.price * 1000),
        retailerId: product.retailerId,
        // WASendableProduct requires an uploadable image source (Baileys
        // turns it into the product card's thumbnail); fall back to an
        // empty buffer when the catalog entry has no image rather than
        // widening the type with an unsafe cast.
        productImage: product.imageUrl ? { url: product.imageUrl } : Buffer.alloc(0),
      },
      businessOwnerJid: sock.user?.id,
      body,
    });
    return this.toResult(msg);
  }

  async sendCatalog(chatId: string, body?: string): Promise<MessageResult> {
    // WhatsApp has no separate structured "catalog card" wire message
    // distinct from a link in the mainstream send API — sharing a catalog
    // is a `wa.me/c/<number>` link, same as tapping "Share" in the app.
    const catalog = await this.getCatalog();
    const link = catalog?.url || '';
    const text = body ? `${body}\n\n${link}` : link;
    return this.sendTextMessage(chatId, text);
  }
}
