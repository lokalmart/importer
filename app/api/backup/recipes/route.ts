import { NextRequest } from 'next/server';
import { requireImporterAuth } from '@/lib/auth';
import { listBackupRecipes } from '@/lib/backupEngine';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const auth = requireImporterAuth(req);
  if (auth) return auth;
  return Response.json({ ok: true, recipes: listBackupRecipes() });
}
