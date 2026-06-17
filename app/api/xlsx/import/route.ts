import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireImporterAuth } from '@/lib/auth';
import { runImport } from '@/lib/importRunner';

export const runtime = 'nodejs';

const Body = z.object({
  base64: z.string().min(10),
  filename: z.string().optional(),
  dryRun: z.boolean().optional(),
  confirm: z.string().optional()
});

export async function POST(req: NextRequest) {
  const auth = requireImporterAuth(req);
  if (auth) return auth;

  try {
    const body = Body.parse(await req.json());
    const result = await runImport(body.base64, { filename: body.filename, dryRun: body.dryRun, confirm: body.confirm });
    return Response.json(result, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
