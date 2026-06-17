import { NextRequest } from 'next/server';
import { requireImporterAuth } from '@/lib/auth';
import { buildSchemaSnapshot } from '@/lib/schemaScanner';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const auth = requireImporterAuth(req);
  if (auth) return auth;

  try {
    const mode = (req.nextUrl.searchParams.get('mode') || 'custom') as 'custom' | 'all' | 'core';
    const snapshot = await buildSchemaSnapshot(mode);
    return Response.json(snapshot);
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
