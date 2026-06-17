import 'server-only';

export type OdooEnv = {
  url: string;
  db: string;
  username: string;
  password: string;
  batchSize: number;
  defaultModule: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function getOdooEnv(): OdooEnv {
  const url = requireEnv('ODOO_URL').replace(/\/+$/, '');
  return {
    url,
    db: requireEnv('ODOO_DB'),
    username: requireEnv('ODOO_USERNAME'),
    password: requireEnv('ODOO_PASSWORD'),
    batchSize: Number(process.env.IMPORT_BATCH_SIZE || 25),
    defaultModule: process.env.IMPORT_DEFAULT_MODULE || 'lokalmart_importer'
  };
}

export function getSafeTargetInfo() {
  const env = getOdooEnv();
  const parsed = new URL(env.url);
  return {
    url_host: parsed.host,
    db: env.db,
    username: env.username
  };
}

export function getAdminToken(): string | null {
  return process.env.IMPORTER_ADMIN_TOKEN?.trim() || null;
}
