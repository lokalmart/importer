import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireImporterAuth } from '@/lib/auth';
import { runBackup } from '@/lib/backupEngine';

export const runtime = 'nodejs';

const Body = z.object({
  recipeId: z.string(),
  scope: z.object({
    projectIds: z.array(z.number()).optional(),
    productIds: z.array(z.number()).optional(),
    partnerIds: z.array(z.number()).optional(),
    knowledgeIds: z.array(z.number()).optional(),
    limit: z.number().optional(),
    includeSchema: z.boolean().optional(),
    includeRawJson: z.boolean().optional(),
  }).optional(),
});

export async function POST(req: NextRequest) {
  const auth = requireImporterAuth(req);
  if (auth) return auth;
  try {
    const body = Body.parse(await req.json());
    const result = await runBackup(body.recipeId as any, body.scope || {});
    return Response.json(result, { status: 200 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
