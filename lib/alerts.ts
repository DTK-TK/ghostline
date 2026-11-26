/**
 * lib/alerts.ts
 *
 * SMS alert delivery for MEDIUM and HIGH risk calls.
 *
 * sendAlerts() is at-most-once: it inserts the alert_sent row first (unique
 * index call_events_alert_once) and sends the SMS only if the insert
 * succeeded, so it is safe to call more than once per call.
 *
 * Two messages per call (both idempotent, keyed by channel + recipient):
 *
 *   1. RISK ALERT - sent to every family_members row with gets_alerts=true.
 *      Max 320 characters (two SMS segments, within carrier limits).
 *
 *   2. MONEY-MOVE CHECKLIST - sent to the same recipients when
 *      payment_method is set on the call. Reminds the senior of safe
 *      practices without accusing anyone.
 *
 * Both messages include the PUBLIC_BASE_URL dashboard link.
 */

import { getTelephony } from "@/lib/providers";
import {
  getAlertRecipients,
  getHousehold,
  claimAlertEvent,
  getCallbackTargets,
} from "@/lib/db";
import { maskPhone } from "@/lib/phone";
import { fitFields, fieldForSms, SMS_MAX } from "@/lib/sms-text";
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
  /** "denied" | "confirmed" | "no_answer" | "pending" | "not initiated" */
  callbackResult: "denied" | "confirmed" | "no_answer" | "pending" | "not initiated";
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
 * Kept to <= 320 characters for predictable two-segment delivery.
 */
export function buildAlertSms(
  context: AlertContext,
  dashboardUrl: string,
): string {
  const { level, claimedIdentity, requestedAmount, paymentMethod, safeWordResult, callbackResult } = context;
  const tag = level === "critical" ? "HIGH" : level.toUpperCase();

  // The SIMULATED prefix and the link count toward the limit. Only the
  // caller-derived fields shrink; the link goes last and is never cut.
  const prefix = context.call.is_simulated ? "SIMULATED: " : "";
  const suffix = ` ${dashboardUrl}`;

  const text = fitFields(
    { who: claimedIdentity, amount: requestedAmount, payment: paymentMethod },
    (f) =>
      `${prefix}GHOSTLINE ${tag}: Caller claims to be ${f.who}. ` +
      `Amount: ${f.amount}. Payment: ${f.payment}. ` +
      `Safe word: ${safeWordResult}. Callback: ${callbackResult}.`,
    suffix.length,
  );
  return text + suffix;
}

export type PaymentBranch = "gift_card" | "transfer" | "courier" | "other";

/** Pick the step set from the payment method (whole-word match). */
export function paymentBranch(paymentMethod: string | null | undefined): PaymentBranch {
  const p = ` ${(paymentMethod ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  if (/ (gift cards?|giftcards?|itunes|steam|google play) /.test(p)) return "gift_card";
  if (/ (crypto|cryptocurrency|bitcoin|btc|ethereum|wire|wires|transfer|etransfer|interac|zelle|venmo) /.test(p) || / e transfer /.test(p)) {
    return "transfer";
  }
  if (/ (courier|pickup|runner|driver|cash) /.test(p)) return "courier";
  return "other";
}

const STEP_3: Record<PaymentBranch, string> = {
  gift_card: "Gift card: keep the card and receipt, call the issuer now.",
  transfer: "If money moved, ask the bank to stop or recall it now.",
  courier: "Hand nothing to any courier or driver.",
  other: "If money moved, call the bank or card issuer now.",
};

/**
 * Build the money-move checklist SMS (numbered steps chosen by payment method).
 * Contains no caller-derived text: the payment method only selects a branch.
 * Names come from the household and are cleaned and capped anyway. The link
 * is appended last and never cut. At most SMS_MAX characters when the link
 * itself fits.
 */
export function buildChecklistSms(
  familyName: string,
  contactName: string | null | undefined,
  paymentMethod: string | null | undefined,
  link: string,
): string {
  const branch = paymentBranch(paymentMethod);
  const family = fieldForSms(familyName, 20, "");
  const suffix = ` ${link}`;
  let max = 30;
  let text = "";
  for (;;) {
    const contact = fieldForSms(contactName, max, "a family member");
    text =
      `GHOSTLINE STEPS${family ? ` (${family} home)` : ""}: ` +
      `1) Call ${contact} first. 2) Send no more money. ` +
      `3) ${STEP_3[branch]} 4) Keep receipts and this link.`;
    if (text.length + suffix.length <= SMS_MAX || max <= 6) break;
    max -= 1;
  }
  return text + suffix;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Send SMS alerts for a completed MEDIUM or HIGH call.
 * Safe to call multiple times - already-sent alerts are skipped.
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

  const alertBody    = buildAlertSms(context, dashboardUrl);
  let contactName: string | null = null;
  if (paymentMethod) {
    try {
      contactName = (await getCallbackTargets(household.id))[0]?.name ?? null;
    } catch {
      console.error("[alerts] could not load callback targets");
    }
  }
  const checklistBody = paymentMethod
    ? buildChecklistSms(household.family_name, contactName, paymentMethod, dashboardUrl)
    : null;

  for (const member of recipients) {
    try {
      await sendOnce(telephony, context, member, "risk", alertBody);
      // Money-move checklist (only when a payment method was mentioned).
      if (checklistBody) {
        await sendOnce(telephony, context, member, "checklist", checklistBody);
      }
    } catch (err) {
      // One recipient failing must not stop the others. Log nothing sensitive.
      console.error(
        "[alerts] recipient failed:",
        maskPhone(member.phone),
        err instanceof Error ? err.name : "error",
      );
    }
  }
}

/**
 * Claim the alert (insert alert_sent), then send the SMS only if the claim
 * succeeded. A claim that already exists means it was sent before: skip.
 * A failed send is not retried.
 */
async function sendOnce(
  telephony: ReturnType<typeof getTelephony>,
  context: AlertContext,
  member: { id: string; phone: string },
  alertType: "risk" | "checklist",
  body: string,
): Promise<void> {
  const claimed = await claimAlertEvent({
    call_id: context.call.id,
    type: "alert_sent",
    payload: {
      type: "alert_sent",
      channel: "sms",
      recipient: maskPhone(member.phone),
      recipient_id: member.id,
      alert_type: alertType,
      level: context.level,
    },
  });
  if (!claimed) return;
  await telephony.sendSms(member.phone, body);
}
