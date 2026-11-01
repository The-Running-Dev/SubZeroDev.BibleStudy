// Reads the service's configuration from the environment once, at startup.
// Every variable read here is listed in .env.example.

export interface Config {
  databaseUrl: string;
  appSecret: string;
  smtpUrl: string;
  mailFrom: string;
  publicUrl: string;
  // Lower-cased; the first sign-in by this address creates the group with that user as owner.
  ownerEmail: string | null;
  // No group sharing mode until the permitted audience is established.
  csbImportedAccess: 'owner' | 'disabled';
  host: string;
  port: number;
  cookieSecure: boolean;
  // Hop count or proxy addresses; never "trust every hop", which would let clients pick their own IP.
  trustProxy: false | number | string;
  buildId: string;
  staticDir: string;
  // Recordings, one file per SHA-256; a volume in production.
  mediaDir: string;
  aolabBaseUrl: string;
  // Lower-cased; the only user who may use the study assistant. Null: nobody may.
  assistantOwnerEmail: string | null;
  // The bearer the PC connector presents on /connector. Null: every link is refused.
  connectorToken: string | null;
  // API.Bible, the licensed CSB source (S13). Null without APIBIBLE_KEY: CSB is not_configured.
  apibible: { key: string; bibleId: string; baseUrl: string } | null;
}

type Env = Record<string, string | undefined>;

function parseTrustProxy(raw: string | undefined, problems: string[]): false | number | string {
  const value = raw?.trim() ?? '';
  if (value === '' || value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'true') {
    problems.push('TRUST_PROXY=true trusts every hop; set the number of proxies (usually 1) or their addresses');
    return false;
  }
  return value;
}

// The settings import-content shares with the server, readable without the server's required ones.
export function contentSettings(env: Env = process.env): Pick<Config, 'mediaDir' | 'aolabBaseUrl'> {
  return {
    mediaDir: env.MEDIA_DIR?.trim() || 'data/media',
    aolabBaseUrl: (env.AOLAB_BASE_URL?.trim() || 'https://bible.helloao.org').replace(/\/+$/, ''),
  };
}

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is required`);
    return value ?? '';
  };

  const config: Config = {
    databaseUrl: required('DATABASE_URL'),
    appSecret: required('APP_SECRET'),
    smtpUrl: required('SMTP_URL'),
    mailFrom: env.MAIL_FROM?.trim() || 'Bible Study <no-reply@localhost>',
    publicUrl: (env.PUBLIC_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, ''),
    ownerEmail: env.OWNER_EMAIL?.trim().toLowerCase() || null,
    csbImportedAccess: (env.CSB_IMPORTED_ACCESS?.trim() || 'owner') as Config['csbImportedAccess'],
    host: env.HOST?.trim() || '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    cookieSecure: env.COOKIE_SECURE !== 'false',
    trustProxy: parseTrustProxy(env.TRUST_PROXY, problems),
    buildId: env.BUILD_ID?.trim() || 'dev',
    staticDir: env.STATIC_DIR?.trim() || 'dist/client',
    ...contentSettings(env),
    assistantOwnerEmail: env.ASSISTANT_OWNER_EMAIL?.trim().toLowerCase() || null,
    connectorToken: env.CONNECTOR_TOKEN?.trim() || null,
    apibible: null,
  };

  if (!['owner', 'disabled'].includes(config.csbImportedAccess)) problems.push('CSB_IMPORTED_ACCESS must be owner or disabled');

  const apibibleKey = env.APIBIBLE_KEY?.trim();
  if (apibibleKey) {
    const bibleId = env.APIBIBLE_CSB_BIBLE_ID?.trim() ?? '';
    if (apibibleKey.startsWith('replace-with')) problems.push('APIBIBLE_KEY is still the example placeholder');
    if (!bibleId || bibleId.startsWith('replace-with')) problems.push('APIBIBLE_CSB_BIBLE_ID is required when APIBIBLE_KEY is set');
    const baseUrl = (env.APIBIBLE_BASE_URL?.trim() || 'https://rest.api.bible/v1').replace(/\/+$/, '');
    // The key travels in a header: never over plain http, except to a stand-in on this machine.
    let parsed: URL | null;
    try {
      parsed = new URL(baseUrl);
    } catch {
      parsed = null;
    }
    const local = parsed !== null && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (!parsed || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local))) {
      problems.push('APIBIBLE_BASE_URL must be an https URL (http only for localhost)');
    }
    config.apibible = { key: apibibleKey, bibleId, baseUrl };
  } else if (env.APIBIBLE_CSB_BIBLE_ID?.trim()) {
    problems.push('APIBIBLE_CSB_BIBLE_ID is set without APIBIBLE_KEY');
  }

  if (config.appSecret && config.appSecret.length < 32) problems.push('APP_SECRET must be at least 32 characters');
  // The example files' placeholders pass the length check and are public.
  if (config.appSecret?.startsWith('replace-with')) problems.push('APP_SECRET is still the example placeholder');
  if (config.connectorToken?.startsWith('replace-with')) problems.push('CONNECTOR_TOKEN is still the example placeholder');
  if (config.ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.ownerEmail)) problems.push('OWNER_EMAIL must be an email address');
  if (config.assistantOwnerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.assistantOwnerEmail)) {
    problems.push('ASSISTANT_OWNER_EMAIL must be an email address');
  }
  if (config.connectorToken && config.connectorToken.length < 32) problems.push('CONNECTOR_TOKEN must be at least 32 characters');
  if (!Number.isInteger(config.port) || config.port <= 0) problems.push('PORT must be a positive integer');
  if (problems.length) throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  return config;
}
