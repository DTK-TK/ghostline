import { describe, it, expect } from "vitest";
import { CallSchema, HouseholdSchema } from "@/lib/db";

const callRow = {
  id: "11111111-1111-4111-8111-111111111111",
  household_id: "22222222-2222-4222-8222-222222222222",
  call_sid: "SIM_test",
  from_number: "+15550100000",
  claimed_identity: null,
  state: "screening",
  risk_score: null,
  risk_level: null,
  outcome: null,
  started_at: "2026-01-01T00:00:00.000Z",
  ended_at: null,
  summary: null,
};

const householdRow = {
  id: "22222222-2222-4222-8222-222222222222",
  family_name: "Sun",
  senior_phone: "+15550000000",
  safe_word_hash: "$2b$12$hash",
  time_waster_enabled: true,
  created_at: "2026-01-01T00:00:00.000Z",
};

describe("is_simulated / is_demo columns", () => {
  it("CallSchema parses a row with is_simulated", () => {
    expect(CallSchema.parse({ ...callRow, is_simulated: true }).is_simulated).toBe(true);
  });

  it("CallSchema defaults is_simulated to false when absent", () => {
    expect(CallSchema.parse(callRow).is_simulated).toBe(false);
  });

  it("HouseholdSchema parses is_demo and defaults it to false", () => {
    expect(HouseholdSchema.parse({ ...householdRow, is_demo: true }).is_demo).toBe(true);
    expect(HouseholdSchema.parse(householdRow).is_demo).toBe(false);
  });
});
