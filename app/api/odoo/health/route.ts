import { NextRequest } from 'next/server';
import { requireImporterAuth } from '@/lib/auth';
import { createOdooClient } from '@/lib/odooXmlRpc';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const auth = requireImporterAuth(req);
  if (auth) return auth;

  try {
    const client = await createOdooClient();
    const version = await client.executeKw('ir.module.module', 'search_count', [[['state', '=', 'installed']]]);
    return Response.json({ ok: true, uid: client.uid, target: client.target, installed_modules: version });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
