import { describe, it, expect } from "vitest";
import { CallEventPayloadSchema } from "@/lib/db";

// Validates: Requirements 6 (R6 Alert events)
const base = { type: "alert_sent", channel: "sms", recipient: "***1234" };

describe("alert_sent payload schema", () => {
  it("accepts a risk payload", () => {
    expect(CallEventPayloadSchema.safeParse({ ...base, alert_type: "risk" }).success).toBe(true);
  });

  it("accepts a checklist payload with the optional fields", () => {
    const r = CallEventPayloadSchema.safeParse({
      ...base,
      alert_type: "checklist",
      level: "high",
      recipient_id: "member-1",
      status: "sent",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a payload with no alert_type", () => {
    expect(CallEventPayloadSchema.safeParse(base).success).toBe(false);
  });

  it("rejects alert_type 'other'", () => {
    expect(CallEventPayloadSchema.safeParse({ ...base, alert_type: "other" }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(
      CallEventPayloadSchema.safeParse({ ...base, alert_type: "risk", status: "queued" }).success,
    ).toBe(false);
  });
});
