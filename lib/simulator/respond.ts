import type { HandlerResult } from "@/lib/simulator/handlers";

/** Read a JSON body without throwing; invalid JSON becomes undefined (-> 400). */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

export function toResponse(r: HandlerResult): Response {
  return Response.json(r.body, {
    status: r.status,
    headers: { "Cache-Control": "no-store", ...(r.headers ?? {}) },
  });
}
