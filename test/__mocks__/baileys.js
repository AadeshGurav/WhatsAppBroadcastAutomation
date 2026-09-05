// Manual Jest mock for the `baileys` package.
//
// `baileys` ships ESM-only ("type": "module" in its package.json) and pulls
// in at least one ESM-only transitive dependency (music-metadata@11), so
// requiring the real package from Jest's CommonJS test runtime throws
// "Cannot use import statement outside a module" for any spec that
// transitively imports whatsapp-engine/adapters/baileys.adapter.ts (e.g.
// through EngineFactory -> SessionService). No spec in this suite exercises
// the Baileys engine's real network behaviour, so this mock only needs to
// provide requireable, shape-compatible stand-ins for the runtime values
// (not types — those vanish at compile time) our code actually imports from
// 'baileys': the default export, Browsers, DisconnectReason, BufferJSON,
// initAuthCreds, and proto.Message.AppStateSyncKeyData.
function makeWASocket() {
  throw new Error('makeWASocket() is mocked in tests — the Baileys engine is not exercised here');
}

module.exports = {
  __esModule: true,
  default: makeWASocket,
  makeWASocket,
  Browsers: {
    ubuntu: (name) => ['Ubuntu', name || 'Chrome', '1.0.0'],
  },
  DisconnectReason: {
    loggedOut: 401,
  },
  BufferJSON: {
    replacer: (_key, value) => value,
    reviver: (_key, value) => value,
  },
  initAuthCreds: () => ({}),
  proto: {
    Message: {
      AppStateSyncKeyData: {
        fromObject: (obj) => obj,
      },
    },
  },
};
