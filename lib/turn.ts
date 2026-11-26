/**
 * lib/turn.ts
 *
 * processTurn(): one conversation turn, shared by /api/voice/turn,
 * /api/dev/phone/turn and the simulator. Routes only adapt input and output.
 *
 * Steps: load call and household, store the caller transcript, hang up after
 * two silent turns, run engine(), write state_change, update the call.
 * All state lives in the database, keyed by CallSid.
 */

import { getCallBySid, getCallEvents, getHousehold, updateCall, appendEvent } from "@/lib/db";
import { inChallengePhase, SAFE_WORD_TRANSCRIPT } from "@/lib/safe-word-phase";
import type { CallRow, CallState, HouseholdRow, RiskLevel } from "@/lib/db";
import { engine } from "@/lib/conversation";
import { countConsecutiveSilence } from "@/lib/silence";
import { GOODBYE_LINE } from "@/lib/time-waster";
import { recordTimeWastedExit } from "@/lib/time-waster-exit";

/** Consecutive silent turns before giving up. */
export const SILENCE_LIMIT = 2;

/** States that accept no more conversation. */
const TERMINAL: CallState[] = ["scam_blocked", "completed", "verified", "transferring"];

export type TurnSource = "twilio" | "dev" | "simulator";

export interface TurnInput {
  callSid: string;
  speech: string;
  source: TurnSource;
}

export type TurnResult =
  | { kind: "not_found" }
  | {
      kind: "turn";
      call: CallRow;
      household: HouseholdRow;
      reply: string;
      nextState: CallState;
      riskScore: number;
      riskLevel: RiskLevel;
      /** True when the call ended because of repeated silence. */
      silenceHangup: boolean;
      /** True when the call was already terminal and the engine was skipped. */
      alreadyEnded: boolean;
      /** True when a callback was just started: hold the caller. */
      hold: boolean;
      /** True when the route should say `reply` and hang up. */
      hangup?: boolean;
    };

export function terminalReply(state: CallState): string {
  switch (state) {
    case "verified":
    case "transferring":
      return "You have been connected to the resident. Have a good day!";
    case "scam_blocked":
      return "I'm not able to connect this call. Goodbye.";
    default:
      return "This call has ended.";
  }
}

export async function processTurn(input: TurnInput): Promise<TurnResult> {
  const { callSid } = input;
  const speech = input.speech.trim();

  const call = await getCallBySid(callSid);
  if (!call) return { kind: "not_found" };

  const household = await getHousehold(call.household_id);
  if (!household) return { kind: "not_found" };

  // Store the caller turn first (empty string = silence). A safe word attempt
  // is stored as a placeholder, never as the spoken text. Terminal calls
  // accept no attempts, so they skip the lookup.
  const attemptTurn =
    !TERMINAL.includes(call.state) && inChallengePhase(await getCallEvents(call.id));
  await appendEvent({
    call_id: call.id,
    type: "transcript",
    payload: {
      type: "transcript",
      text: attemptTurn ? SAFE_WORD_TRANSCRIPT : speech,
      speaker: "caller",
    },
  });

  const base = {
    kind: "turn" as const,
    call,
    household,
    riskScore: call.risk_score ?? 0,
    riskLevel: (call.risk_level ?? "low") as RiskLevel,
  };

  if (TERMINAL.includes(call.state)) {
    return {
      ...base,
      reply: terminalReply(call.state),
      nextState: call.state,
      silenceHangup: false,
      alreadyEnded: true,
      hold: false,
    };
  }

  const silenceCount = speech === "" ? await countConsecutiveSilence(call.id) : 0;
  if (silenceCount >= SILENCE_LIMIT && call.state === "time_wasted") {
    // Persona active: close the episode, say goodbye and hang up.
    const exit = await recordTimeWastedExit({ callId: call.id, reason: "caller_silent" });
    await updateCall(callSid, {
      state: "completed",
      outcome: "time_wasted",
      ended_at: exit?.endedAt ?? new Date().toISOString(),
    });
    return {
      ...base,
      reply: GOODBYE_LINE,
      nextState: "completed",
      silenceHangup: false,
      alreadyEnded: false,
      hold: false,
      hangup: true,
    };
  }
  if (silenceCount >= SILENCE_LIMIT) {
    await updateCall(callSid, { state: "completed", outcome: "dropped" });
    await appendEvent({
      call_id: call.id,
      type: "state_change",
      payload: { type: "state_change", from: call.state, to: "completed" as CallState },
    });
    return {
      ...base,
      reply: terminalReply("completed"),
      nextState: "completed",
      silenceHangup: true,
      alreadyEnded: false,
      hold: false,
    };
  }

  const { reply, nextState, riskUpdate, hold, hangup, outcome, stateChangeExtra } = await engine({
    callSid,
    speechResult: speech,
    currentState: call.state,
    currentRiskScore: call.risk_score ?? 0,
  });

  if (nextState !== call.state) {
    await appendEvent({
      call_id: call.id,
      type: "state_change",
      payload: {
        type: "state_change",
        from: call.state,
        to: nextState,
        ...(stateChangeExtra ?? {}),
      },
    });
  }

  // The engine's outcome wins; entering scam_blocked is a blocked call.
  const finalOutcome =
    outcome ?? (nextState === "scam_blocked" && call.state !== "scam_blocked" ? "blocked" : undefined);
  const extraEnded = stateChangeExtra?.["ended_at"];
  const endedAt =
    finalOutcome || hangup === true
      ? typeof extraEnded === "string"
        ? extraEnded
        : new Date().toISOString()
      : undefined;

  // combineScores already applies the monotonic floor; flooring again here
  // would cancel the safe-word and confirmed-callback credits (R11).
  const riskScore = riskUpdate.score;
  await updateCall(callSid, {
    state: nextState,
    risk_score: riskScore,
    risk_level: riskUpdate.level,
    ...(finalOutcome ? { outcome: finalOutcome } : {}),
    ...(endedAt ? { ended_at: endedAt } : {}),
  });

  return {
    ...base,
    reply,
    nextState,
    riskScore,
    riskLevel: riskUpdate.level,
    silenceHangup: false,
    alreadyEnded: false,
    hold: hold === true,
    hangup: hangup === true,
  };
}
