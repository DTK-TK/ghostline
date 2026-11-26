/**
 * lib/callback.ts
 *
 * The callback check: when a caller claims to be family, Ghostline phones a
 * real family member and asks if they are the one calling.
 *
 *   startCallback()         place the call (once per call), write the events
 *   recordCallbackResult()  first result wins; rescore; HIGH on denial
 *   holdDecision()          pure: what the caller-side hold loop does next
 *
 * State lives in call_events (callback_started, callback_result). Routes in
 * app/api/voice/* only validate the signature and call into this file.
 * Full phone numbers are never logged; stored and logged values are masked.
 */

import {
  appendEvent,
  getCallBySid,
  getCallEvents,
  getCallbackTargets,
  getHousehold,
  updateCall,
} from "@/lib/db";
import type { CallEventRow, CallOutcome, CallRow, CallState, HouseholdRow, RiskLevel } from "@/lib/db";
import { enterHighRisk } from "@/lib/time-waster";
import { getTelephony } from "@/lib/providers";
import { sendAlerts } from "@/lib/alerts";
import { buildAndStoreReport } from "@/lib/report";
import { maskPhone } from "@/lib/phone";
import { scoreRules } from "@/lib/scoring/rules";
import { combineScores, creditsFromEvents } from "@/lib/scoring/combine";
import {
  blockTwiml,
  callbackPromptTwiml,
  callbackThanksTwiml,
  emptyTwiml,
  hangupTwiml,
  holdEndTwiml,
  holdTwiml,
  timeWasteTwiml,
} from "@/lib/twiml";
import { SAFE_WORD_CHALLENGE, TIME_WASTER_REPLY, isChallengeLine } from "@/lib/safe-word-phase";

export type CallbackOutcome = "denied" | "confirmed" | "no_answer";

/** Hold-check passes before giving up: 4 x 10 s pauses is about 45 s with speech. */
export const MAX_HOLD_CHECKS = 4;
export const HOLD_REPLY = "Please hold one moment.";

const SAFE_WORD_FAIL_POINTS = 50;
const NAME_MAX = 40;

/** States in which the caller is already connected, blocked or finished. */
const ENDED_STATES: CallState[] = ["scam_blocked", "completed", "verified", "transferring", "failed"];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export { maskPhone };

/**
 * A name that is safe to speak and to put in a URL: letters, spaces, hyphens,
 * apostrophes and periods only, single spaces, at most 40 characters.
 * Returns null when nothing usable is left.
 */
export function cleanName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[^\p{L}\s'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return /\p{L}/u.test(cleaned) ? cleaned : null;
}

/** Hold-check pass number from the query string: an integer 1 to 4, else 4. */
export function parseHoldN(raw: string | null | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_HOLD_CHECKS ? n : MAX_HOLD_CHECKS;
}

/** The result that follows the latest callback_started, or null if pending. */
export function currentCallbackResult(events: CallEventRow[]): CallbackOutcome | null {
  let startIdx = -1;
  events.forEach((e, i) => {
    if (e.type === "callback_started") startIdx = i;
  });
  for (let i = startIdx + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.type !== "callback_result") continue;
    const o = e.payload["outcome"];
    if (o === "denied" || o === "confirmed" || o === "no_answer") return o;
  }
  return null;
}

export type HoldDecision =
  | { kind: "denied" }
  /** A result is in (confirmed or no_answer): carry on with the challenge. */
  | { kind: "challenge" }
  | { kind: "wait"; next: number }
  /** Hold limit reached with no result: record no_answer, then challenge. */
  | { kind: "give_up" }
  | { kind: "ended" };

/**
 * What the caller-side hold loop does at pass `n`. A result always wins over
 * an ended call, because a denial itself moves the call to time_wasted or
 * scam_blocked.
 */
export function holdDecision(
  events: CallEventRow[],
  call: Pick<CallRow, "state" | "ended_at">,
  n: number,
): HoldDecision {
  const result = currentCallbackResult(events);
  if (result === "denied") return { kind: "denied" };
  if (result !== null) {
    return ENDED_STATES.includes(call.state) || call.ended_at ? { kind: "ended" } : { kind: "challenge" };
  }
  if (ENDED_STATES.includes(call.state) || call.ended_at) return { kind: "ended" };
  return n < MAX_HOLD_CHECKS ? { kind: "wait", next: n + 1 } : { kind: "give_up" };
}

// ---------------------------------------------------------------------------
// startCallback
// ---------------------------------------------------------------------------

export type StartCallbackResult = "started" | "no_answer" | "skipped";

/**
 * Phone the first callback target. Guards: once per call, and a clean claimed
 * name is required (otherwise "skipped": nothing is written and the caller
 * just gets the safe word challenge). No target, or a provider error, writes
 * callback_result "no_answer" so the caller is never left holding.
 * The call goes through getTelephony(), so MOCK_TELEPHONY=true works.
 */
export async function startCallback(args: {
  call: CallRow;
  household: HouseholdRow;
  claimedName: string | null | undefined;
}): Promise<StartCallbackResult> {
  const { call, household } = args;

  const events = await getCallEvents(call.id);
  if (events.some((e) => e.type === "callback_started" || e.type === "callback_result")) {
    return "skipped";
  }

  const name = cleanName(args.claimedName);
  if (!name) return "skipped";

  let targetPhone: string | null = null;
  try {
    targetPhone = (await getCallbackTargets(household.id))[0]?.phone ?? null;
  } catch {
    console.error("[callback] could not load callback targets");
  }
  if (!targetPhone) {
    await appendEvent({
      call_id: call.id,
      type: "callback_result",
      payload: { type: "callback_result", outcome: "no_answer" },
    });
    return "no_answer";
  }

  // Written before dialling, so a fast webhook always finds a started callback.
  await appendEvent({
    call_id: call.id,
    type: "callback_started",
    payload: { type: "callback_started", target_phone: maskPhone(targetPhone) },
  });

  try {
    await getTelephony().startCallbackCall(targetPhone, call.call_sid, name);
  } catch (err) {
    console.error(
      "[callback] could not start the callback call:",
      err instanceof Error ? err.message.replace(/\+?\d[\d\s().-]{6,}\d/g, maskPhone) : "unknown",
    );
    await appendEvent({
      call_id: call.id,
      type: "callback_result",
      payload: { type: "callback_result", outcome: "no_answer" },
    });
    return "no_answer";
  }
  return "started";
}

// ---------------------------------------------------------------------------
// Family member's phone: the prompt
// ---------------------------------------------------------------------------

/** Where the family member's digit goes. `retry` marks the one repeat of the prompt. */
export function callbackResultUrl(
  baseUrl: string,
  originalCallSid: string,
  opts: { retry?: boolean; claimedName?: string | null } = {},
): string {
  return (
    `${baseUrl}/api/voice/callback-result?originalCallSid=${encodeURIComponent(originalCallSid)}` +
    (opts.claimedName ? `&claimedName=${encodeURIComponent(opts.claimedName)}` : "") +
    (opts.retry ? "&retry=1" : "")
  );
}

/**
 * TwiML for the answered callback leg. The name and the family name are
 * sanitised before they are spoken. An unknown call gets a short goodbye.
 */
export async function buildCallbackPrompt(args: {
  originalCallSid: string;
  claimedName: string | null | undefined;
  baseUrl: string;
  retry?: boolean;
}): Promise<string> {
  const call = args.originalCallSid ? await getCallBySid(args.originalCallSid) : null;
  const household = call ? await getHousehold(call.household_id) : null;
  if (!call || !household) return hangupTwiml();

  const name = cleanName(args.claimedName);
  return callbackPromptTwiml(
    name ?? "someone",
    cleanName(household.family_name) ?? "household",
    callbackResultUrl(args.baseUrl, args.originalCallSid, { retry: args.retry, claimedName: name }),
  );
}

// ---------------------------------------------------------------------------
// recordCallbackResult
// ---------------------------------------------------------------------------

export interface RecordResult {
  /** False when the call or its callback is unknown, or a result already exists. */
  recorded: boolean;
  call: CallRow | null;
  level: RiskLevel | null;
  score: number | null;
  state: CallState | null;
}

/**
 * Store the family member's answer. The first result after the latest
 * callback_started wins, so Twilio retries and late presses are ignored.
 * "no_answer" changes nothing else. "denied" and "confirmed" rescore from the
 * stored events; a denial also puts the call on the HIGH path.
 */
export async function recordCallbackResult(
  callSid: string,
  outcome: CallbackOutcome,
): Promise<RecordResult> {
  const none: RecordResult = { recorded: false, call: null, level: null, score: null, state: null };

  const call = await getCallBySid(callSid);
  if (!call) return none;
  const events = await getCallEvents(call.id);

  const hasStart = events.some((e) => e.type === "callback_started");
  const unchanged: RecordResult = {
    recorded: false,
    call,
    level: call.risk_level,
    score: call.risk_score,
    state: call.state,
  };
  if (!hasStart || currentCallbackResult(events) !== null) return unchanged;

  await appendEvent({
    call_id: call.id,
    type: "callback_result",
    payload: { type: "callback_result", outcome },
  });
  if (outcome === "no_answer") return { ...unchanged, recorded: true };

  // Rescore from the stored events (caller turns are already redacted).
  const storedCaller = events
    .filter((e) => e.type === "transcript" && e.payload["speaker"] === "caller")
    .map((e) => (typeof e.payload["text"] === "string" ? e.payload["text"] : ""));
  const rules = scoreRules(storedCaller);
  const failed = events.filter(
    (e) => e.type === "safe_word_attempt" && e.payload["matched"] === false,
  ).length;
  const matched = events.some((e) => e.type === "safe_word_attempt" && e.payload["matched"] === true);

  const combined = combineScores({
    rulesScore: rules.score + SAFE_WORD_FAIL_POINTS * failed,
    aiScore: 0,
    allFlags: [...rules.flags, ...(failed > 0 ? ["safe_word_fail"] : [])],
    safeWordCorrect: matched,
    callbackDenied: outcome === "denied",
    callbackConfirmed: outcome === "confirmed",
    priorScore: call.risk_score ?? 0,
    // Credit already in the stored score: from the events before this result.
    priorCredits: creditsFromEvents(events),
  });

  let state: CallState = call.state;
  let highExtra: Record<string, unknown> = {};
  let highOutcome: CallOutcome | undefined;
  if (outcome === "denied") {
    const household = await getHousehold(call.household_id);
    if (!ENDED_STATES.includes(call.state) && call.state !== "time_wasted") {
      const high = enterHighRisk({
        call,
        household: { time_waster_enabled: household?.time_waster_enabled ?? false },
        now: new Date(),
      });
      state = high.state;
      highExtra = high.extra;
      highOutcome = high.outcome;
    }
    const priorFlags = events
      .filter((e) => e.type === "red_flag")
      .map((e) => e.payload["flag"]);
    if (!priorFlags.includes("callback_denied")) {
      await appendEvent({
        call_id: call.id,
        type: "red_flag",
        payload: { type: "red_flag", flag: "callback_denied", detail: "family member denied" },
      });
    }
  }

  await updateCall(callSid, {
    risk_score: combined.score,
    risk_level: combined.level,
    ...(state !== call.state ? { state } : {}),
    ...(highOutcome ? { outcome: highOutcome } : {}),
  });
  if (state !== call.state) {
    await appendEvent({
      call_id: call.id,
      type: "state_change",
      payload: { type: "state_change", from: call.state, to: state, ...highExtra },
    });
  }

  // A denial is alerted at once, only here: this point is reached once per
  // call because the first result wins above.
  if (outcome === "denied") {
    await alertOnDenial({ ...call, risk_score: combined.score, risk_level: combined.level, state }, events);
  }

  return { recorded: true, call, level: combined.level, score: combined.score, state };
}

/**
 * Alert the family and store the fraud report for a denied callback.
 * Best effort: a failed SMS or report never fails the webhook. sendAlerts and
 * buildAndStoreReport are idempotent, so an alert already sent for the call
 * is not repeated. The report is for the family to file, never auto-submitted.
 */
async function alertOnDenial(call: CallRow, events: CallEventRow[]): Promise<void> {
  try {
    const attempts = events.filter((e) => e.type === "safe_word_attempt");
    const last = attempts[attempts.length - 1];
    await sendAlerts({
      call,
      level: "high",
      claimedIdentity: call.claimed_identity,
      requestedAmount: call.requested_amount,
      paymentMethod: call.payment_method,
      safeWordResult: !last ? "not asked" : last.payload["matched"] === true ? "passed" : "failed",
      callbackResult: "denied",
    });
    await buildAndStoreReport(call.id);
  } catch (err) {
    console.error("[callback] alert or report failed:", err instanceof Error ? err.message : "unknown");
  }
}

// ---------------------------------------------------------------------------
// Route logic: /api/voice/hold-check
// ---------------------------------------------------------------------------

function lastSystemText(events: CallEventRow[]): unknown {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "transcript" && e.payload["speaker"] === "system") return e.payload["text"];
  }
  return undefined;
}

async function appendSystemLine(callId: string, text: string): Promise<void> {
  await appendEvent({
    call_id: callId,
    type: "transcript",
    payload: { type: "transcript", text, speaker: "system" },
  });
}

/**
 * One pass of the caller-side hold loop. Returns the TwiML for the caller.
 *   pending, n < 4   Pause 10, Redirect hold-check?n+1
 *   pending, n = 4   record no_answer, then the safe word challenge
 *   denied           the HIGH reply (time-waster or blocked)
 *   confirmed / no_answer  the safe word challenge (the word is still required)
 *   call already over  hang up
 */
export async function handleHoldCheck(args: {
  callSid: string;
  n: string | null | undefined;
  baseUrl: string;
}): Promise<string | null> {
  const { callSid, baseUrl } = args;
  const n = parseHoldN(args.n);

  const call = await getCallBySid(callSid);
  if (!call) return null;

  let events = await getCallEvents(call.id);
  let current: CallRow = call;
  let decision = holdDecision(events, current, n);

  if (decision.kind === "give_up") {
    await recordCallbackResult(callSid, "no_answer");
    // A press may have landed at the same moment: look again.
    events = await getCallEvents(call.id);
    current = (await getCallBySid(callSid)) ?? call;
    decision = holdDecision(events, current, n);
    if (decision.kind === "give_up") decision = { kind: "challenge" };
  }

  switch (decision.kind) {
    case "wait":
      return holdTwiml(baseUrl, decision.next);

    case "denied": {
      if (current.state === "time_wasted") {
        if (lastSystemText(events) !== TIME_WASTER_REPLY) await appendSystemLine(call.id, TIME_WASTER_REPLY);
        return timeWasteTwiml(TIME_WASTER_REPLY, baseUrl);
      }
      return blockTwiml();
    }

    case "challenge": {
      if (!isChallengeLine(lastSystemText(events))) await appendSystemLine(call.id, SAFE_WORD_CHALLENGE);
      return holdEndTwiml(SAFE_WORD_CHALLENGE, baseUrl);
    }

    case "ended":
    default:
      return hangupTwiml();
  }
}

// ---------------------------------------------------------------------------
// Route logic: /api/voice/callback-result
// ---------------------------------------------------------------------------

/** Call statuses that mean the family member never gave an answer. */
const NO_ANSWER_STATUSES = ["no-answer", "busy", "failed", "canceled", "completed"];

/**
 * The family member's digit (Gather action) or the call's status callback.
 * 1 = denied, 2 = confirmed, any other digit repeats the prompt once and then
 * counts as no_answer. A status callback with no digit means no_answer unless
 * a result is already stored (first result wins, handled in recordCallbackResult).
 */
export async function handleCallbackResult(args: {
  originalCallSid: string;
  digits: string | null | undefined;
  callStatus: string | null | undefined;
  retry: boolean;
  claimedName?: string | null;
  baseUrl: string;
}): Promise<string> {
  const { originalCallSid, retry, baseUrl, claimedName } = args;
  const digits = (args.digits ?? "").trim();
  if (!originalCallSid) return emptyTwiml();

  if (digits === "1") {
    await recordCallbackResult(originalCallSid, "denied");
    return callbackThanksTwiml();
  }
  if (digits === "2") {
    await recordCallbackResult(originalCallSid, "confirmed");
    return callbackThanksTwiml();
  }
  if (digits !== "") {
    if (!retry) {
      return buildCallbackPrompt({ originalCallSid, claimedName, baseUrl, retry: true });
    }
    await recordCallbackResult(originalCallSid, "no_answer");
    return callbackThanksTwiml();
  }

  // No digit: a status callback.
  if (NO_ANSWER_STATUSES.includes((args.callStatus ?? "").toLowerCase())) {
    await recordCallbackResult(originalCallSid, "no_answer");
  }
  return emptyTwiml();
}
