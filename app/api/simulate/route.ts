/**
 * POST /api/simulate { scenarioId }
 * Passcode-checked by proxy.ts. Logic in lib/simulator/handlers.ts.
 */

import { handleStart } from "@/lib/simulator/handlers";
import { readJson, toResponse } from "@/lib/simulator/respond";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  return toResponse(await handleStart(await readJson(req)));
}
