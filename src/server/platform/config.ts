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
    host: env.HOST?.trim() || '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    cookieSecure: env.COOKIE_SECURE !== 'false',
    trustProxy: parseTrustProxy(env.TRUST_PROXY, problems),
    buildId: env.BUILD_ID?.trim() || 'dev',
    staticDir: env.STATIC_DIR?.trim() || 'dist/client',
    ...contentSettings(env),
  };

  if (config.appSecret && config.appSecret.length < 32) problems.push('APP_SECRET must be at least 32 characters');
  if (config.ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.ownerEmail)) problems.push('OWNER_EMAIL must be an email address');
  if (!Number.isInteger(config.port) || config.port <= 0) problems.push('PORT must be a positive integer');
  if (problems.length) throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  return config;
}
