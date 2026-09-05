const DEPLOYMENT_MODE: 'cloud' | 'local' =
  (process.env.DEPLOYMENT_MODE || (process.env.NODE_ENV === 'production' ? 'cloud' : 'local')) === 'local'
    ? 'local'
    : 'cloud';

export default () => ({
  port: parseInt(process.env.PORT || '2785', 10),

  /**
   * Deployment mode:
   *  - 'cloud' (default, and always when NODE_ENV=production): keeps all the
   *    anti-ban / WAF throttles and human-like pacing that protect the
   *    WhatsApp numbers when running on Render (cloud IPs are heavily
   *    scrutinized, and Hostinger WAF rate-limits the Render IP).
   *  - 'local': runs on a residential IP — no WAF, no cloud-IP reputation —
   *    so all pacing/delays are relaxed to let processing run freely. Set
   *    DEPLOYMENT_MODE=local explicitly (or rely on NODE_ENV != production).
   */
  deploymentMode: DEPLOYMENT_MODE,
  // True when running in relaxed local mode (no throttles).
  isLocal: DEPLOYMENT_MODE === 'local',

  // Redis configuration
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
  },

  // Queue configuration
  queue: {
    enabled: process.env.QUEUE_ENABLED === 'true',
  },

  // Cache configuration
  cache: {
    enabled: process.env.CACHE_ENABLED === 'true',
  },

  // Main Database configuration (always SQLite for boot config)
  database: {
    type: 'sqlite' as const,
    database: './data/main.sqlite',
    synchronize: true,
    logging: process.env.DATABASE_LOGGING === 'true',
  },

  // Data Storage Database configuration (pluggable: SQLite, PostgreSQL, etc.)
  dataDatabase: {
    type: process.env.DATABASE_TYPE || 'sqlite',
    // SQLite path (used when type is sqlite)
    database: process.env.DATABASE_NAME || './data/senderrr.sqlite',
    // PostgreSQL/MySQL connection (used when type is postgres/mysql)
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    synchronize: process.env.DATABASE_SYNCHRONIZE === 'true',
    logging: process.env.DATABASE_LOGGING === 'true',
    // Connection pooling (PostgreSQL) — cloud keeps a modest pool (10); local
    // apps are typically the only consumer so a smaller pool (4) is plenty and
    // burns fewer Neon connections.
    poolSize: parseInt(process.env.DATABASE_POOL_SIZE || (DEPLOYMENT_MODE === 'local' ? '4' : '10'), 10),
    // SSL configuration
    ssl: process.env.DATABASE_SSL === 'true',
    sslRejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== 'false',
  },

  // WhatsApp engine configuration
  engine: {
    type: process.env.ENGINE_TYPE || 'whatsapp-web.js',
    puppeteer: {
      headless: process.env.PUPPETEER_HEADLESS !== 'false',
      args: (
        process.env.PUPPETEER_ARGS ||
        '--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-accelerated-2d-canvas,--no-first-run,--no-zygote,--disable-gpu'
      ).split(','),
    },
    // sessionDataPath removed — RemoteAuth stores WhatsApp sessions in Postgres via
    // PostgresRemoteAuthStore. Keep SESSION_DATA_PATH env var for disk-based cleanup
    // (Chrome lock files) which operates on the process level via pkill.
    baileys: {
      // Set to pair by phone-number code instead of scanning a QR (useful
      // when there's no way to see the phone's screen during setup). Leave
      // unset to keep the default QR-code flow.
      pairingPhoneNumber: process.env.ENGINE_BAILEYS_PAIRING_PHONE_NUMBER || undefined,
      // Display name shown on the linked WhatsApp account's "Linked devices" screen.
      browserName: process.env.ENGINE_BAILEYS_BROWSER_NAME || 'Senderrr',
    },
  },

  // Webhook configuration
  webhook: {
    timeout: parseInt(process.env.WEBHOOK_TIMEOUT || '10000', 10),
    maxRetries: parseInt(process.env.WEBHOOK_MAX_RETRIES || '3', 10),
    retryDelay: parseInt(process.env.WEBHOOK_RETRY_DELAY || '5000', 10),
  },

  // API configuration
  api: {
    rateLimit: {
      // Short burst protection: 10 requests per second
      shortTtl: parseInt(process.env.RATE_LIMIT_SHORT_TTL || '1000', 10),
      shortLimit: parseInt(process.env.RATE_LIMIT_SHORT_LIMIT || '10', 10),
      // Medium protection: 100 requests per minute
      mediumTtl: parseInt(process.env.RATE_LIMIT_MEDIUM_TTL || '60000', 10),
      mediumLimit: parseInt(process.env.RATE_LIMIT_MEDIUM_LIMIT || '100', 10),
      // Long protection: 1000 requests per hour
      longTtl: parseInt(process.env.RATE_LIMIT_LONG_TTL || '3600000', 10),
      longLimit: parseInt(process.env.RATE_LIMIT_LONG_LIMIT || '1000', 10),
    },
  },

  // Security configuration
  security: {
    // Comma-separated IPs/CIDRs of reverse proxies whose X-Forwarded-For header
    // may be trusted for client-IP resolution. Empty by default: X-Forwarded-For
    // is ignored and the direct socket address is used, preventing spoofing of
    // the API-key allowedIps whitelist.
    trustedProxies: (process.env.TRUSTED_PROXIES || '')
      .split(',')
      .map(proxy => proxy.trim())
      .filter(Boolean),
  },

  // WA Automation configuration
  waAuth: {
    jwtSecret: process.env.WA_JWT_SECRET || 'wa-automation-jwt-secret-change-me',
  },

  // Scraper configuration
  scraper: {
    timeout: parseInt(process.env.SCRAPER_REQUEST_TIMEOUT || '30', 10),
    // Local: no WAF, so retries can be fast and minimal. Cloud: keep the
    // exponential backoff to avoid hammering the target site.
    maxRetries: parseInt(
      process.env.SCRAPER_MAX_RETRIES || (DEPLOYMENT_MODE === 'local' ? '1' : '3'),
      10,
    ),
    activeHourStart: parseInt(process.env.SCRAPER_ACTIVE_HOUR_START || '0', 10),
    activeHourEnd: parseInt(process.env.SCRAPER_ACTIVE_HOUR_END || '23', 10),
    activeWeekdays: process.env.SCRAPER_ACTIVE_WEEKDAYS || '0,1,2,3,4,5,6',
    targetUrls: process.env.SCRAPER_TARGET_URLS || '',
  },

  // Automation configuration
  automation: {
    hourlyLimit: parseInt(process.env.AUTOMATION_HOURLY_LIMIT || '500', 10),
    dailyLimit: parseInt(process.env.AUTOMATION_DAILY_LIMIT || '5000', 10),
    batchSize: parseInt(process.env.AUTOMATION_BATCH_SIZE || '50', 10),
    batchCooldown: parseInt(process.env.AUTOMATION_BATCH_COOLDOWN || '900', 10),
    jitterMin: parseFloat(process.env.AUTOMATION_JITTER_MIN || (DEPLOYMENT_MODE === 'local' ? '0' : '30')),
    jitterMax: parseFloat(process.env.AUTOMATION_JITTER_MAX || (DEPLOYMENT_MODE === 'local' ? '1' : '120')),
    jitterMultiplier: parseFloat(process.env.AUTOMATION_JITTER_MULTIPLIER || '1.5'),
    quietHourStart: parseInt(process.env.AUTOMATION_QUIET_HOUR_START || '1', 10),
    quietHourEnd: parseInt(process.env.AUTOMATION_QUIET_HOUR_END || '7', 10),
    maxRetryAttempts: parseInt(process.env.MESSAGE_MAX_RETRY_ATTEMPTS || '3', 10),
    rateLimitRetryDelay: parseInt(process.env.RATE_LIMIT_RETRY_DELAY || '3600', 10),
    groupMaxConsecutiveFailures: parseInt(process.env.GROUP_MAX_CONSECUTIVE_FAILURES || '10', 10),
    groupUnhealthyRecoveryHours: parseInt(process.env.GROUP_UNHEALTHY_RECOVERY_HOURS || '2', 10),
    // Human-like pacing used by the broadcast dispatcher. Local mode runs
    // without per-message delays, batch pauses, or rate-limit sleeps.
    perMessageDelayMin: parseInt(process.env.BROADCAST_DELAY_MIN_MS || (DEPLOYMENT_MODE === 'local' ? '0' : '3000'), 10),
    perMessageDelayMax: parseInt(process.env.BROADCAST_DELAY_MAX_MS || (DEPLOYMENT_MODE === 'local' ? '0' : '8000'), 10),
    batchPauseMin: parseInt(process.env.BROADCAST_BATCH_PAUSE_MIN_MS || (DEPLOYMENT_MODE === 'local' ? '0' : '120000'), 10),
    batchPauseMax: parseInt(process.env.BROADCAST_BATCH_PAUSE_MAX_MS || (DEPLOYMENT_MODE === 'local' ? '0' : '300000'), 10),
    dispatchTimeoutMinutes: parseInt(process.env.BROADCAST_DISPATCH_TIMEOUT_MINUTES || '60', 10),
    rateLimitRetrySleepMs: parseInt(process.env.BROADCAST_RATE_LIMIT_SLEEP_MS || (DEPLOYMENT_MODE === 'local' ? '0' : '60000'), 10),
  },

  // Storage configuration
  storage: {
    type: process.env.STORAGE_TYPE || 'local',
    localPath: process.env.STORAGE_LOCAL_PATH || './data/media',
    s3: {
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      endpoint: process.env.S3_ENDPOINT,
    },
  },
});
