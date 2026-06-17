import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireImporterAuth } from '@/lib/auth';
import { runPreflight } from '@/lib/preflightEngine';

export const runtime = 'nodejs';

const Body = z.object({ base64: z.string().min(10), filename: z.string().optional() });

export async function POST(req: NextRequest) {
  const auth = requireImporterAuth(req);
  if (auth) return auth;

  try {
    const body = Body.parse(await req.json());
    const result = await runPreflight(body.base64, body.filename);
    return Response.json(result);
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
