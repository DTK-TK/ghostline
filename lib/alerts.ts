/**
 * lib/alerts.ts
 *
 * SMS alert delivery for MEDIUM and HIGH risk calls.
 *
 * sendAlerts() is idempotent: it checks call_events for existing
 * alert_sent entries before sending, so it is safe to call more than once
 * per call (e.g. from a retry or the status webhook).
 *
 * Two messages per call (both idempotent, keyed by channel + recipient):
 *
 *   1. RISK ALERT — sent to every family_members row with gets_alerts=true.
 *      Max 320 characters (two SMS segments, within carrier limits).
 *
 *   2. MONEY-MOVE CHECKLIST — sent to the same recipients when
 *      payment_method is set on the call. Reminds the senior of safe
 *      practices without accusing anyone.
 *
 * Both messages include the PUBLIC_BASE_URL dashboard link.
 */

import { getTelephony } from "@/lib/providers";
import {
  getCallEvents,
  getAlertRecipients,
  getHousehold,
  appendEvent,
} from "@/lib/db";
import type { CallRow, RiskLevel } from "@/lib/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AlertContext {
  call: CallRow;
  /** Risk level at time of alert (medium or high). */
  level: RiskLevel;
  /** What the caller claimed their identity was, or null. */
  claimedIdentity: string | null;
  /** Dollar / other amount mentioned, verbatim, or null. */
  requestedAmount: string | null;
  /** Payment method mentioned (e.g. "gift card"), or null. */
  paymentMethod: string | null;
  /** "passed" | "failed" | "not asked" */
  safeWordResult: "passed" | "failed" | "not asked";
  /** "denied" | "confirmed" | "no_answer" | "not initiated" */
  callbackResult: "denied" | "confirmed" | "no_answer" | "not initiated";
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

/** CAFC-complaint scam type guess from call data. */
function guessScamType(context: AlertContext): string {
  if (context.paymentMethod) return "payment scam";
  if (context.claimedIdentity?.toLowerCase().match(/cra|irs|revenue|tax/)) return "government impersonation";
  if (context.claimedIdentity?.toLowerCase().match(/microsoft|apple|support/)) return "tech support scam";
  if (context.claimedIdentity?.toLowerCase().match(/police|rcmp|court|lawyer/)) return "authority impersonation";
  return "suspicious call";
}

/**
 * Build the primary risk-alert SMS body.
 * Kept to ≤ 320 characters for predictable two-segment delivery.
 */
export function buildAlertSms(
  context: AlertContext,
  dashboardUrl: string,
): string {
  const { level, claimedIdentity, requestedAmount, paymentMethod, safeWordResult, callbackResult } = context;
  const tag = level.toUpperCase();
  const who  = claimedIdentity ?? "unknown";
  const amt  = requestedAmount ?? "none";
  const pay  = paymentMethod   ?? "none";
  const sw   = safeWordResult;
  const cb   = callbackResult;

  const body =
    `GHOSTLINE ${tag}: Caller claimed to be ${who}. ` +
    `Asked for ${amt} via ${pay}. ` +
    `Safe word: ${sw}. Callback: ${cb}. ${dashboardUrl}`;

  // The SIMULATED prefix counts toward the limit, so truncate the rest.
  const prefix = context.call.is_simulated ? "SIMULATED: " : "";
  const room = 320 - prefix.length;
  const trimmed = body.length <= room ? body : body.slice(0, room - 1) + "…";
  return prefix + trimmed;
}

/**
 * Build the money-move checklist SMS.
 * Only sent when paymentMethod is set.
 */
export function buildChecklistSms(
  seniorName: string,
  familyContactName: string,
): string {
  return (
    `Reminder for ${seniorName}: no bank, police or family member will ever ` +
    `ask for gift cards, crypto, wire transfers or a courier pickup. ` +
    `Call ${familyContactName} directly on their saved number.`
  );
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

/**
 * Returns the set of recipient phone numbers that have already received
 * an SMS alert for this call, keyed by a "type:recipient" string.
 */
async function sentAlertKeys(callId: string): Promise<Set<string>> {
  const events = await getCallEvents(callId);
  const keys = new Set<string>();
  for (const ev of events) {
    if (
      ev.type === "alert_sent" &&
      ev.payload["channel"] === "sms" &&
      typeof ev.payload["recipient"] === "string"
    ) {
      const tag = ev.payload["alert_type"] ?? "risk";
      keys.add(`${tag}:${ev.payload["recipient"] as string}`);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Send SMS alerts for a completed MEDIUM or HIGH call.
 * Safe to call multiple times — already-sent alerts are skipped.
 */
export async function sendAlerts(context: AlertContext): Promise<void> {
  const { call, paymentMethod } = context;

  const household = await getHousehold(call.household_id);
  if (!household) throw new Error(`Household not found: ${call.household_id}`);

  const recipients = await getAlertRecipients(call.household_id);
  if (recipients.length === 0) return;

  const baseUrl = process.env.PUBLIC_BASE_URL ?? "";
  const dashboardUrl = `${baseUrl}/calls/${call.id}`;

  const telephony = getTelephony();
  const sent = await sentAlertKeys(call.id);

  const alertBody    = buildAlertSms(context, dashboardUrl);
  const checklistBody = paymentMethod
    ? buildChecklistSms(
        household.family_name,
        recipients.find((r) => r.is_callback_target)?.name ?? "a family member",
      )
    : null;

  for (const member of recipients) {
    // --- Primary risk alert ---
    const riskKey = `risk:${member.phone}`;
    if (!sent.has(riskKey)) {
      await telephony.sendSms(member.phone, alertBody);
      await appendEvent({
        call_id: call.id,
        type: "alert_sent",
        payload: {
          type: "alert_sent",
          channel: "sms",
          recipient: member.phone,
          alert_type: "risk",
        },
      });
    }

    // --- Money-move checklist (only when a payment method was mentioned) ---
    if (checklistBody) {
      const checkKey = `checklist:${member.phone}`;
      if (!sent.has(checkKey)) {
        await telephony.sendSms(member.phone, checklistBody);
        await appendEvent({
          call_id: call.id,
          type: "alert_sent",
          payload: {
            type: "alert_sent",
            channel: "sms",
            recipient: member.phone,
            alert_type: "checklist",
          },
        });
      }
    }
  }
}
