/**
 * claimAlertEvent treats Postgres unique violation 23505 as already sent.
 * Validates: Requirements 6 (R6 Alert events)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ error: null as null | { code: string } }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ insert: async () => ({ error: h.error }) }) }),
}));

import { claimAlertEvent } from "@/lib/db";

const row = {
  call_id: "00000000-0000-4000-8000-000000000001",
  type: "alert_sent" as const,
  payload: {
    type: "alert_sent",
    channel: "sms",
    recipient: "***0001",
    recipient_id: "m1",
    alert_type: "risk",
  },
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "x");
  h.error = null;
});

describe("claimAlertEvent", () => {
  it("returns true when the insert succeeds", async () => {
    expect(await claimAlertEvent(row)).toBe(true);
  });

  it("returns false on unique violation 23505 (already sent)", async () => {
    h.error = { code: "23505" };
    expect(await claimAlertEvent(row)).toBe(false);
  });

  it("throws on any other error", async () => {
    h.error = { code: "XX000" };
    await expect(claimAlertEvent(row)).rejects.toBeTruthy();
  });
});
