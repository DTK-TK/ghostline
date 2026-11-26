/**
 * POST /api/simulate/step { callSid, index }
 * Passcode-checked by proxy.ts. Logic in lib/simulator/handlers.ts.
 */

import { handleStep } from "@/lib/simulator/handlers";
import { readJson, toResponse } from "@/lib/simulator/respond";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  return toResponse(await handleStep(await readJson(req)));
}
