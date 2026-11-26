/**
 * lib/simulator/run.ts
 *
 * startSimulation() creates a simulated call. nextStep() plays one scripted
 * caller line through processTurn(), the same path as real calls.
 *
 * - The server owns the text: nextStep takes only { callSid, index }.
 * - State lives in the database. The scenario comes from the call sid
 *   (SIM_<scenarioId>_<uuid>); the expected index is the number of caller
 *   transcript events already stored.
 * - No outbound calls. A scripted callback answer is written as an event.
 * - Gates (ENABLE_SIMULATOR, is_demo, rate limits) belong to the routes.
 */

import { randomUUID } from "node:crypto";
import { appendEvent, createCall, getCallBySid, getCallEvents } from "@/lib/db";
import type { CallOutcome, CallState } from "@/lib/db";
import { processTurn } from "@/lib/turn";
import { finalizeCall } from "@/lib/finalize-call";
import { getScenario } from "@/lib/simulator/scenarios";
import type { CallbackAnswer, Scenario, ScenarioLine } from "@/lib/simulator/scenarios";

export const SIMULATED_FROM_NUMBER = "+15550100000";
const WRONG_SAFE_WORD = "pineapple";
const SID_RE = /^SIM_([a-z]+)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SimulatorErrorCode = "not_found" | "conflict" | "ended" | "config";

export class SimulatorError extends Error {
  constructor(
    public readonly code: SimulatorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SimulatorError";
  }
  /** HTTP status the route should return. */
  get status(): number {
    return this.code === "not_found" ? 404 : this.code === "config" ? 500 : 409;
  }
}

export interface StartResult {
  callSid: string;
  callId: string;
  scenarioId: string;
  total: number;
}

export interface StepResult {
  /** Text shown for the caller line. A safe word line is redacted. */
  line: string;
  reply: string;
  level: string;
  score: number;
  state: CallState;
  done: boolean;
}

export function scenarioIdFromSid(callSid: string): string | null {
  const m = SID_RE.exec(callSid);
  return m ? m[1]! : null;
}

export async function startSimulation(input: {
  householdId: string;
  scenarioId: string;
}): Promise<StartResult> {
  const scenario = getScenario(input.scenarioId);
  if (!scenario) throw new SimulatorError("not_found", "Unknown scenario");

  const callSid = `SIM_${scenario.id}_${randomUUID()}`;
  const call = await createCall({
    household_id: input.householdId,
    call_sid: callSid,
    from_number: SIMULATED_FROM_NUMBER,
    state: "screening",
    is_simulated: true,
  });
  return { callSid, callId: call.id, scenarioId: scenario.id, total: scenario.lines.length };
}

/**
 * The text to speak for a line. The safe word is read from the environment
 * only when the scenario says "correct"; it is never taken from a request.
 */
export function resolveLineText(line: ScenarioLine): string {
  if (line.kind === "speech") return line.text;
  if (line.safeWord === "wrong") return WRONG_SAFE_WORD;
  const word = process.env.SIMULATOR_SAFE_WORD;
  if (!word) throw new SimulatorError("config", "SIMULATOR_SAFE_WORD is not set");
  return word;
}

function outcomeFor(state: CallState): CallOutcome {
  if (state === "scam_blocked") return "blocked";
  if (state === "time_wasted") return "time_wasted";
  if (state === "verified" || state === "transferring") return "transferred";
  return "unknown";
}

const ENDED: CallState[] = ["scam_blocked", "completed", "verified", "transferring", "failed"];

async function scriptCallbackAnswer(callId: string, answer: CallbackAnswer): Promise<void> {
  // lib/callback.ts (recordCallbackResult) does not exist yet. Write the same
  // event it would write, without placing any call. Swap to
  // recordCallbackResult(callSid, answer) when safe-word-and-callback lands.
  await appendEvent({
    call_id: callId,
    type: "callback_result",
    payload: { type: "callback_result", outcome: answer },
  });
}

export async function nextStep(input: { callSid: string; index: number }): Promise<StepResult> {
  const { callSid, index } = input;

  const scenarioId = scenarioIdFromSid(callSid);
  const scenario: Scenario | null = scenarioId ? getScenario(scenarioId) : null;
  const call = await getCallBySid(callSid);
  if (!scenario || !call || !call.is_simulated) {
    throw new SimulatorError("not_found", "Simulation not found");
  }
  if (call.ended_at) throw new SimulatorError("ended", "Simulation already ended");

  const events = await getCallEvents(call.id);
  const expected = events.filter(
    (e) => e.type === "transcript" && e.payload["speaker"] === "caller",
  ).length;
  if (!Number.isInteger(index) || index !== expected || index >= scenario.lines.length) {
    throw new SimulatorError("conflict", `Expected step ${expected}`);
  }

  const line = scenario.lines[index]!;
  const text = resolveLineText(line);

  const turn = await processTurn({ callSid, speech: text, source: "simulator" });
  if (turn.kind === "not_found") throw new SimulatorError("not_found", "Simulation not found");

  if (line.callbackAnswer) await scriptCallbackAnswer(call.id, line.callbackAnswer);

  const isLast = index === scenario.lines.length - 1;
  const done = isLast || ENDED.includes(turn.nextState);
  if (done) {
    // Re-read so finalizeCall sees the risk level this turn just wrote.
    const fresh = (await getCallBySid(callSid)) ?? turn.call;
    const finalState = ENDED.includes(turn.nextState) || turn.nextState === "time_wasted"
      ? turn.nextState
      : "completed";
    await finalizeCall(fresh, { state: finalState, outcome: outcomeFor(finalState) });
  }

  return {
    line: line.kind === "safe_word" ? "[safe word]" : text,
    reply: turn.reply,
    level: turn.riskLevel,
    score: turn.riskScore,
    state: turn.nextState,
    done,
  };
}
