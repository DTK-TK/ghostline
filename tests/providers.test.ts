import { describe, it, expect } from "vitest";
import {
  assertProductionProviders,
  REQUIRED_PRODUCTION_ENV,
} from "@/lib/providers/assert";

const safeProd: Record<string, string> = {
  VERCEL_ENV: "production",
  TWILIO_AUTH_TOKEN: "t-secret",
  PUBLIC_BASE_URL: "https://example.test",
  GEMINI_API_KEY: "g-secret",
  SUPABASE_SERVICE_ROLE_KEY: "s-secret",
  DASHBOARD_PASSCODE: "p-secret",
};

describe("assertProductionProviders", () => {
  it("passes for a safe production env (AI defaults to gemini)", () => {
    expect(() => assertProductionProviders(safeProd)).not.toThrow();
    expect(() =>
      assertProductionProviders({ ...safeProd, AI_PROVIDER: "gemini", MOCK_TELEPHONY: "false" }),
    ).not.toThrow();
  });

  it("throws for MOCK_TELEPHONY=true", () => {
    expect(() => assertProductionProviders({ ...safeProd, MOCK_TELEPHONY: "true" })).toThrow(
      /MOCK_TELEPHONY/,
    );
  });

  it.each(["mock", "ollama", "banana"])("throws for AI_PROVIDER=%s", (value) => {
    expect(() => assertProductionProviders({ ...safeProd, AI_PROVIDER: value })).toThrow(
      /AI_PROVIDER/,
    );
  });

  it.each(REQUIRED_PRODUCTION_ENV)("throws when %s is missing or blank", (name) => {
    const missing = { ...safeProd };
    delete missing[name];
    expect(() => assertProductionProviders(missing)).toThrow(new RegExp(name));
    expect(() => assertProductionProviders({ ...safeProd, [name]: "  " })).toThrow(
      new RegExp(name),
    );
  });

  it("reports all problems at once and never prints secret values", () => {
    let message = "";
    try {
      assertProductionProviders({ ...safeProd, MOCK_TELEPHONY: "true", AI_PROVIDER: "mock", GEMINI_API_KEY: "" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/MOCK_TELEPHONY/);
    expect(message).toMatch(/AI_PROVIDER/);
    expect(message).toMatch(/GEMINI_API_KEY/);
    for (const secret of ["t-secret", "s-secret", "p-secret"]) {
      expect(message).not.toContain(secret);
    }
  });

  it.each(["development", "preview", undefined])("never throws when VERCEL_ENV=%s", (v) => {
    expect(() =>
      assertProductionProviders({ VERCEL_ENV: v, MOCK_TELEPHONY: "true", AI_PROVIDER: "ollama" }),
    ).not.toThrow();
  });
});
