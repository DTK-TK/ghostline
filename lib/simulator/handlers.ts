/**
 * lib/simulator/handlers.ts
 *
 * Request logic for POST /api/simulate and POST /api/simulate/step. The route
 * files only parse JSON and return the result. Passcode check: proxy.ts.
 */

import { z } from "zod";
import { getDemoHousehold, getSimulatedCallStarts } from "@/lib/db";
import { SimulatorError, nextStep, startSimulation } from "@/lib/simulator/run";
import { getScenario } from "@/lib/simulator/scenarios";
import { DAY_MS, checkLimits } from "@/lib/simulator/limits";

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

const StartBody = z.object({ scenarioId: z.string().min(1).max(40) }).strict();
const StepBody = z.object({ callSid: z.string().min(1).max(100), index: z.number().int().min(0).max(100) }).strict();

export function simulatorEnabled(): boolean {
  return process.env.ENABLE_SIMULATOR === "true";
}

/** True when SMS alerts would go out through real Twilio. */
export function willSendRealSms(): boolean {
  return process.env.MOCK_TELEPHONY !== "true";
}

const notFound = (): HandlerResult => ({ status: 404, body: { error: "Not found" } });

export async function handleStart(raw: unknown, now: Date = new Date()): Promise<HandlerResult> {
  if (!simulatorEnabled()) return notFound();

  const parsed = StartBody.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: "Invalid request" } };
  if (!getScenario(parsed.data.scenarioId)) return { status: 400, body: { error: "Unknown scenario" } };

  const household = await getDemoHousehold();
  if (!household) return { status: 403, body: { error: "The simulator only runs on the demo household" } };

  const starts = await getSimulatedCallStarts(household.id, new Date(now.getTime() - DAY_MS).toISOString());
  const limit = checkLimits(starts, now);
  if (!limit.ok) {
    return {
      status: 429,
      body: {
        error: limit.reason === "too_soon" ? "Wait 30 seconds between simulations" : "Daily simulation limit reached",
        reason: limit.reason,
      },
      headers: { "Retry-After": String(limit.retryAfterSeconds) },
    };
  }

  try {
    const start = await startSimulation({ householdId: household.id, scenarioId: parsed.data.scenarioId });
    return { status: 200, body: { ...start, willSendRealSms: willSendRealSms() } };
  } catch (e) {
    return fail(e);
  }
}

export async function handleStep(raw: unknown): Promise<HandlerResult> {
  if (!simulatorEnabled()) return notFound();

  const parsed = StepBody.safeParse(raw);
  if (!parsed.success) return { status: 400, body: { error: "Invalid request" } };

  const household = await getDemoHousehold();
  if (!household) return { status: 403, body: { error: "The simulator only runs on the demo household" } };

  try {
    const result = await nextStep(parsed.data);
    return { status: 200, body: { ...result } };
  } catch (e) {
    return fail(e);
  }
}

function fail(e: unknown): HandlerResult {
  if (e instanceof SimulatorError) return { status: e.status, body: { error: e.message, code: e.code } };
  console.error("simulator error", e instanceof Error ? e.message : "unknown");
  return { status: 500, body: { error: "Simulator failed" } };
}
