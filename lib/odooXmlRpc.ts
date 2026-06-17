import 'server-only';
import * as xmlrpc from 'xmlrpc';
import { getOdooEnv, getSafeTargetInfo } from './env';

export type OdooClient = Awaited<ReturnType<typeof createOdooClient>>;

type XmlRpcClient = ReturnType<typeof xmlrpc.createClient>;

function makeXmlClient(url: string): XmlRpcClient {
  const parsed = new URL(url);
  const factory = parsed.protocol === 'https:' ? xmlrpc.createSecureClient : xmlrpc.createClient;
  return factory({ url, cookies: true });
}

function call(client: XmlRpcClient, method: string, params: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

export async function createOdooClient() {
  const env = getOdooEnv();
  const common = makeXmlClient(`${env.url}/xmlrpc/2/common`);
  const object = makeXmlClient(`${env.url}/xmlrpc/2/object`);

  const uid = await call(common, 'authenticate', [env.db, env.username, env.password, {}]);
  if (!uid || typeof uid !== 'number') {
    throw new Error('Odoo authentication failed. Check ODOO_DB, ODOO_USERNAME, and ODOO_PASSWORD/API key.');
  }

  async function executeKw<T = unknown>(model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<T> {
    const params = [env.db, uid, env.password, model, method, args, kwargs];
    return (await call(object, 'execute_kw', params)) as T;
  }

  async function fieldsGet(model: string): Promise<Record<string, any>> {
    return executeKw<Record<string, any>>(model, 'fields_get', [], { attributes: ['string', 'type', 'relation', 'required', 'readonly', 'store', 'selection'] });
  }

  async function searchRead<T = Record<string, unknown>>(model: string, domain: unknown[] = [], fields: string[] = [], limit = 2000): Promise<T[]> {
    const kwargs: Record<string, unknown> = { limit };
    if (fields.length) kwargs.fields = fields;
    return executeKw<T[]>(model, 'search_read', [domain], kwargs);
  }

  async function search(model: string, domain: unknown[] = [], limit = 2000): Promise<number[]> {
    return executeKw<number[]>(model, 'search', [domain], { limit });
  }

  async function read<T = Record<string, unknown>>(model: string, ids: number[], fields: string[] = []): Promise<T[]> {
    const kwargs: Record<string, unknown> = {};
    if (fields.length) kwargs.fields = fields;
    return executeKw<T[]>(model, 'read', [ids], kwargs);
  }

  async function create(model: string, values: Record<string, unknown>): Promise<number> {
    return executeKw<number>(model, 'create', [values]);
  }

  async function write(model: string, ids: number[], values: Record<string, unknown>): Promise<boolean> {
    return executeKw<boolean>(model, 'write', [ids, values]);
  }

  return {
    env,
    uid,
    target: getSafeTargetInfo(),
    executeKw,
    fieldsGet,
    searchRead,
    search,
    read,
    create,
    write,
  };
}

export function splitXmlId(raw: string, defaultModule: string): { module: string; name: string; complete_name: string } {
  const cleaned = String(raw || '').trim();
  if (!cleaned) throw new Error('External ID kosong.');
  if (cleaned.includes('.')) {
    const [module, ...rest] = cleaned.split('.');
    const name = rest.join('.');
    return { module, name, complete_name: `${module}.${name}` };
  }
  const safeName = cleaned.replace(/[^a-zA-Z0-9_\.]/g, '_');
  return { module: defaultModule, name: safeName, complete_name: `${defaultModule}.${safeName}` };
}

export async function resolveExternalId(client: OdooClient, raw: string): Promise<{ model: string; res_id: number; module: string; name: string; complete_name: string } | null> {
  const xml = splitXmlId(raw, client.env.defaultModule);
  const found = await client.searchRead<{ model: string; res_id: number; module: string; name: string }>(
    'ir.model.data',
    [['module', '=', xml.module], ['name', '=', xml.name]],
    ['module', 'name', 'model', 'res_id'],
    1
  );
  if (!found.length) return null;
  return { ...found[0], complete_name: xml.complete_name };
}

export async function ensureExternalId(client: OdooClient, raw: string, model: string, resId: number): Promise<void> {
  const xml = splitXmlId(raw, client.env.defaultModule);
  const existing = await client.searchRead<{ id: number; model: string; res_id: number }>(
    'ir.model.data',
    [['module', '=', xml.module], ['name', '=', xml.name]],
    ['id', 'model', 'res_id'],
    1
  );
  if (existing.length) {
    await client.write('ir.model.data', [existing[0].id], { model, res_id: resId, noupdate: true });
    return;
  }
  await client.create('ir.model.data', {
    module: xml.module,
    name: xml.name,
    model,
    res_id: resId,
    noupdate: true,
  });
}
