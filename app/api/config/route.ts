import { NextRequest } from 'next/server';
import { getAdminToken, getSafeTargetInfo } from '@/lib/env';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest) {
  try {
    return Response.json({
      ok: true,
      requiresToken: Boolean(getAdminToken()),
      target: getSafeTargetInfo(),
    });
  } catch (error) {
    return Response.json({ ok: false, requiresToken: Boolean(getAdminToken()), error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
