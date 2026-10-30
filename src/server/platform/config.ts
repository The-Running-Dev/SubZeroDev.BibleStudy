// Reads the service's configuration from the environment once, at startup.
// Every variable read here is listed in .env.example.

export interface Config {
  databaseUrl: string;
  appSecret: string;
  smtpUrl: string;
  mailFrom: string;
  publicUrl: string;
  host: string;
  port: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  buildId: string;
  staticDir: string;
}

type Env = Record<string, string | undefined>;

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
    host: env.HOST?.trim() || '0.0.0.0',
    port: Number(env.PORT ?? 3000),
    cookieSecure: env.COOKIE_SECURE !== 'false',
    trustProxy: env.TRUST_PROXY === 'true',
    buildId: env.BUILD_ID?.trim() || 'dev',
    staticDir: env.STATIC_DIR?.trim() || 'dist/client',
  };

  if (config.appSecret && config.appSecret.length < 32) problems.push('APP_SECRET must be at least 32 characters');
  if (!Number.isInteger(config.port) || config.port <= 0) problems.push('PORT must be a positive integer');
  if (problems.length) throw new Error(`Invalid configuration: ${problems.join('; ')}`);
  return config;
}
