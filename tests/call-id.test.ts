import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseCallId } from "@/lib/call-id";
import { buildTimeline } from "@/lib/call-timeline";

describe("parseCallId", () => {
  it("accepts a uuid", () => {
    const id = "3f2b8c1e-9a4d-4e6b-8c2a-1d5e7f9a0b3c";
    expect(parseCallId(id)).toBe(id);
  });

  it("rejects malformed ids and non-strings", () => {
    for (const bad of ["not-a-uuid", "", "123", undefined, null, 42]) {
      expect(parseCallId(bad)).toBeNull();
    }
  });

  it("accepts every generated uuid", () => {
    fc.assert(fc.property(fc.uuid(), (u) => parseCallId(u) === u));
  });
});

describe("buildTimeline", () => {
  it("never includes safe word attempt text", () => {
    const rows = buildTimeline([
      {
        id: "1",
        call_id: "c",
        type: "safe_word_attempt",
        payload: { matched: false, attempt: "SECRETWORD" },
        created_at: "2026-12-04T10:00:00.000Z",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("SECRETWORD");
  });
});
