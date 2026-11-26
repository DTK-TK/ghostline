import { z } from "zod";

const CallIdSchema = z.uuid();

/** Returns the id when it is a valid uuid, else null (the page then 404s). */
export function parseCallId(raw: unknown): string | null {
  const r = CallIdSchema.safeParse(raw);
  return r.success ? r.data : null;
}
