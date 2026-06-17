import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireImporterAuth } from '@/lib/auth';
import { runCleanup } from '@/lib/cleanupEngine';

export const runtime = 'nodejs';

const Body = z.object({
  keys: z.array(z.string()).default([]),
  confirm: z.string(),
  scope: z.object({
    mode: z.enum(['all', 'models', 'fields', 'external_ids', 'access']).optional(),
    limit: z.number().optional(),
    includeCore: z.boolean().optional(),
  }).optional(),
});

export async function POST(req: NextRequest) {
  const auth = requireImporterAuth(req);
  if (auth) return auth;
  try {
    const body = Body.parse(await req.json());
    const result = await runCleanup(body.keys, body.confirm, body.scope || {});
    return Response.json(result, { status: 200 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
