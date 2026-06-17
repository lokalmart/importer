import 'server-only';
import { NextRequest } from 'next/server';
import { getAdminToken } from './env';

export function requireImporterAuth(req: NextRequest): Response | null {
  const expected = getAdminToken();
  if (!expected) return null;

  const token = req.headers.get('x-importer-token') || '';
  if (token === expected) return null;

  return Response.json(
    {
      ok: false,
      error: 'Unauthorized importer access. Set the correct access key in the app.'
    },
    { status: 401 }
  );
}
