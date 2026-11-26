/**
 * lib/report.ts
 *
 * Builds and stores the structured fraud report for HIGH-risk calls.
 *
 * buildAndStoreReport() assembles all available evidence from call_events,
 * stores it in fraud_reports as JSONB, and returns the typed report object.
 *
 * Nothing is submitted automatically. The /reports/[id] page shows the
 * report and provides a "Copy for CAFC report" plain-text block for the
 * family to submit manually if they choose.
 *
 * CAFC = Canadian Anti-Fraud Centre  https://antifraudcentre-centreantifraude.ca
 */

import {
  getCallBySid,
  getCallEvents,
  getHousehold,
  getFraudReport,
  createFraudReport,
} from "@/lib/db";
import type { CallRow, CallEventRow, FraudReportRow } from "@/lib/db";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Typed report schema
// ---------------------------------------------------------------------------

export const FraudReportDataSchema = z.object({
  /** ISO-8601 timestamp when the call started. */
  date_time: z.string(),
  /** E.164 caller number. */
  caller_number: z.string(),
  /** Claimed name or organisation, or null. */
  claimed_identity: z.string().nullable(),
  /**
   * Best-guess scam category derived from red flags.
   * e.g. "grandparent scam", "CRA impersonation", "tech support", "bank fraud"
   */
  scam_type: z.string(),
  /** Verbatim amount mentioned, or null. */
  amount: z.string().nullable(),
  /** Payment method mentioned, or null. */
  payment_method: z.string().nullable(),
  /** Array of { flag_id, quote } — the actual words that triggered each flag. */
  red_flags: z.array(
    z.object({
      flag_id: z.string(),
      quote: z.string().default(""),
    }),
  ),
  /** "passed" | "failed" | "not asked" */
  safe_word_result: z.enum(["passed", "failed", "not asked"]),
  /** "denied" | "confirmed" | "no_answer" | "not initiated" */
  callback_result: z.enum(["denied", "confirmed", "no_answer", "not initiated"]),
  /** Full conversation: array of { speaker, text } oldest-first. */
  transcript: z.array(z.object({ speaker: z.string(), text: z.string() })),
  /** Final risk score (0–100). */
  risk_score: z.number().int(),
  /** "low" | "medium" | "high" */
  risk_level: z.string(),
  /** Gemini-generated one-sentence summary. */
  summary: z.string().nullable(),
  /** True when the call came from the simulator. Never file a simulated report. */
  is_simulated: z.boolean().default(false),
});

export type FraudReportData = z.infer<typeof FraudReportDataSchema>;

// ---------------------------------------------------------------------------
// Evidence extractors
// ---------------------------------------------------------------------------

function extractTranscript(
  events: CallEventRow[],
): Array<{ speaker: string; text: string }> {
  return events
    .filter((e) => e.type === "transcript")
    .map((e) => ({
      speaker: typeof e.payload["speaker"] === "string" ? e.payload["speaker"] : "caller",
      text:    typeof e.payload["text"]    === "string" ? e.payload["text"]    : "",
    }))
    .filter((t) => t.text.length > 0);
}

function extractRedFlags(events: CallEventRow[]): Array<{ flag_id: string; quote: string }> {
  return events
    .filter((e) => e.type === "red_flag")
    .map((e) => ({
      flag_id: typeof e.payload["flag"]   === "string" ? e.payload["flag"]   : "unknown",
      quote:   typeof e.payload["quote"]  === "string" ? e.payload["quote"]  : "",
    }));
}

function extractSafeWordResult(
  events: CallEventRow[],
): "passed" | "failed" | "not asked" {
  const attempts = events.filter((e) => e.type === "safe_word_attempt");
  if (attempts.length === 0) return "not asked";
  const lastAttempt = attempts[attempts.length - 1]!;
  return lastAttempt.payload["matched"] === true ? "passed" : "failed";
}

function extractCallbackResult(
  events: CallEventRow[],
): "denied" | "confirmed" | "no_answer" | "not initiated" {
  const results = events.filter((e) => e.type === "callback_result");
  if (results.length === 0) return "not initiated";
  const last = results[results.length - 1]!;
  const outcome = last.payload["outcome"];
  if (outcome === "denied")    return "denied";
  if (outcome === "confirmed") return "confirmed";
  return "no_answer";
}

function guessScamType(call: CallRow, flags: string[]): string {
  const identity = (call.claimed_identity ?? "").toLowerCase();
  if (flags.includes("emergency_story") && identity.match(/grandson|granddaughter|son|daughter|family/)) {
    return "grandparent scam";
  }
  if (identity.match(/cra|irs|revenue|tax agency/)) return "CRA / IRS impersonation";
  if (identity.match(/police|rcmp|sheriff|court|marshal|officer/)) return "law enforcement impersonation";
  if (identity.match(/microsoft|apple|google|tech support|helpdesk/)) return "tech support scam";
  if (identity.match(/bank|visa|mastercard|credit union/)) return "bank / card fraud";
  if (flags.includes("remote_access")) return "remote access scam";
  if (flags.includes("payment_method")) return "payment / gift card scam";
  if (flags.includes("emergency_story")) return "emergency story scam";
  return "suspicious call";
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build the fraud report for a completed HIGH-risk call and store it.
 * Idempotent: if a report already exists for this call it is returned as-is.
 *
 * @param callId - The UUID from calls.id (not the Twilio CallSid).
 */
export async function buildAndStoreReport(callId: string): Promise<FraudReportRow> {
  // Check for existing report first (idempotent).
  const existing = await getFraudReport(callId);
  if (existing) return existing;

  // Load call + events.
  const { data: callData, error: callError } = await (async () => {
    const { adminDb } = await import("@/lib/db");
    const { data, error } = await adminDb()
      .from("calls")
      .select("*")
      .eq("id", callId)
      .maybeSingle();
    return { data, error };
  })();
  if (callError) throw callError;
  if (!callData) throw new Error(`Call not found: ${callId}`);

  const { CallSchema } = await import("@/lib/db");
  const call = CallSchema.parse(callData);

  const events = await getCallEvents(callId);

  const redFlags   = extractRedFlags(events);
  const transcript = extractTranscript(events);
  const flagIds    = redFlags.map((f) => f.flag_id);

  const report: FraudReportData = FraudReportDataSchema.parse({
    date_time:        call.started_at,
    caller_number:    call.from_number,
    claimed_identity: call.claimed_identity,
    scam_type:        guessScamType(call, flagIds),
    amount:           call.requested_amount,
    payment_method:   call.payment_method,
    red_flags:        redFlags,
    safe_word_result: extractSafeWordResult(events),
    callback_result:  extractCallbackResult(events),
    transcript,
    risk_score:       call.risk_score ?? 0,
    risk_level:       call.risk_level ?? "high",
    summary:          call.summary,
    is_simulated:     call.is_simulated,
  });

  return createFraudReport({ call_id: callId, report: report as Record<string, unknown> });
}

/**
 * Load a fully-typed fraud report by its own UUID (fraud_reports.id).
 */
export async function loadReport(reportId: string): Promise<{
  row: FraudReportRow;
  data: FraudReportData;
} | null> {
  const { adminDb, FraudReportSchema } = await import("@/lib/db");
  const { data, error } = await adminDb()
    .from("fraud_reports")
    .select("*")
    .eq("id", reportId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = FraudReportSchema.parse(data);
  const reportData = FraudReportDataSchema.parse(row.report);
  return { row, data: reportData };
}

// ---------------------------------------------------------------------------
// CAFC report text block
// ---------------------------------------------------------------------------

/**
 * Returns a plain-text block the user can copy and paste into the
 * CAFC online reporting form at https://antifraudcentre-centreantifraude.ca
 *
 * Never submitted automatically.
 */
export function buildCafcText(report: FraudReportData): string {
  const simulatedBanner: string[] = report.is_simulated
    ? [
        "*** SIMULATED: THIS IS A TEST CALL FROM THE GHOSTLINE SIMULATOR. ***",
        "*** DO NOT FILE THIS REPORT. NO REAL FRAUD OCCURRED. ***",
        "",
      ]
    : [];
  const lines: string[] = [
    ...simulatedBanner,
    "=== CAFC FRAUD REPORT (copy and paste into the online form) ===",
    "",
    `Date and time:       ${new Date(report.date_time).toLocaleString("en-CA")}`,
    `Caller number:       ${report.caller_number}`,
    `Claimed identity:    ${report.claimed_identity ?? "not stated"}`,
    `Scam type:           ${report.scam_type}`,
    `Amount requested:    ${report.amount ?? "not stated"}`,
    `Payment method:      ${report.payment_method ?? "not stated"}`,
    `Safe word result:    ${report.safe_word_result}`,
    `Callback result:     ${report.callback_result}`,
    `Risk score:          ${report.risk_score}/100 (${report.risk_level.toUpperCase()})`,
    "",
    "Red flags detected:",
    ...report.red_flags.map((f) => `  - ${f.flag_id}: "${f.quote}"`),
    "",
    "Summary:",
    `  ${report.summary ?? "(none)"}`,
    "",
    "Full transcript:",
    ...report.transcript.map(
      (t) => `  [${t.speaker.toUpperCase()}] ${t.text}`,
    ),
    "",
    "=== END OF REPORT ===",
    ...(report.is_simulated ? ["SIMULATED: do not file this report."] : []),
    "Report a fraud: https://antifraudcentre-centreantifraude.ca/reportincident-signalerincident-eng.htm",
  ];
  return lines.join("\n");
}
