/**
 * lib/db.ts
 *
 * Supabase client + typed helpers for every table in the Ghostline schema.
 *
 * Server-side code (API routes, server components) uses `adminDb` with the
 * service role key. Browser code uses `browserDb` with the anon key.
 *
 * Row types are derived from Zod schemas so the same shapes validate both
 * runtime API responses and TypeScript call sites.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Database type (manual until `supabase gen types` runs)
// ---------------------------------------------------------------------------

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/**
 * Hand-written Database interface for SupabaseClient<Database> generics.
 * Replace with the output of `supabase gen types typescript --local` once the
 * migration has been applied and the Supabase CLI is available.
 *
 * Declared after the Zod-derived row/insert types at the bottom of this file.
 * TypeScript resolves `type` alias forward-references lazily, so this compiles
 * correctly even though the referenced types appear below.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Database = any;

// ---------------------------------------------------------------------------
// Zod schemas – single source of truth for row shapes
// ---------------------------------------------------------------------------

// ---- households -----------------------------------------------------------

export const HouseholdSchema = z.object({
  id: z.uuid(),
  family_name: z.string(),
  senior_phone: z.string(),
  safe_word_hash: z.string(),
  time_waster_enabled: z.boolean(),
  is_demo: z.boolean().default(false),
  created_at: z.string().datetime(),
});

export const HouseholdInsertSchema = HouseholdSchema.omit({ id: true, created_at: true }).extend({
  time_waster_enabled: z.boolean().optional(),
  is_demo: z.boolean().optional(),
});

export type HouseholdRow = z.infer<typeof HouseholdSchema>;
export type HouseholdInsert = z.infer<typeof HouseholdInsertSchema>;

// ---- contacts -------------------------------------------------------------

export const ContactSchema = z.object({
  id: z.uuid(),
  household_id: z.uuid(),
  name: z.string(),
  phone: z.string(),
  relationship: z.string(),
});

export const ContactInsertSchema = ContactSchema.omit({ id: true });

export type ContactRow = z.infer<typeof ContactSchema>;
export type ContactInsert = z.infer<typeof ContactInsertSchema>;

// ---- family_members -------------------------------------------------------

export const FamilyMemberSchema = z.object({
  id: z.uuid(),
  household_id: z.uuid(),
  name: z.string(),
  phone: z.string(),
  gets_alerts: z.boolean(),
  is_callback_target: z.boolean(),
});

export const FamilyMemberInsertSchema = FamilyMemberSchema.omit({ id: true }).extend({
  gets_alerts: z.boolean().optional(),
  is_callback_target: z.boolean().optional(),
});

export type FamilyMemberRow = z.infer<typeof FamilyMemberSchema>;
export type FamilyMemberInsert = z.infer<typeof FamilyMemberInsertSchema>;

// ---- calls ----------------------------------------------------------------

export const CallStateSchema = z.enum([
  "initiated",
  "screening",
  "verified",
  "transferring",
  "scam_blocked",
  "time_wasted",
  "completed",
  "failed",
]);

export const RiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

export const CallOutcomeSchema = z.enum([
  "transferred",
  "blocked",
  "dropped",
  "time_wasted",
  "unknown",
]);

export type CallState = z.infer<typeof CallStateSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;

export const CallSchema = z.object({
  id: z.uuid(),
  household_id: z.uuid(),
  call_sid: z.string(),
  from_number: z.string(),
  claimed_identity: z.string().nullable(),
  state: CallStateSchema,
  risk_score: z.number().int().min(0).max(100).nullable(),
  risk_level: RiskLevelSchema.nullable(),
  outcome: CallOutcomeSchema.nullable(),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable(),
  summary: z.string().nullable(),
  is_simulated: z.boolean().default(false),
  requested_amount: z.string().nullable().default(null),
  payment_method: z.string().nullable().default(null),
});

export const CallInsertSchema = CallSchema.omit({ id: true, started_at: true }).extend({
  requested_amount: z.string().optional(),
  payment_method: z.string().optional(),
  is_simulated: z.boolean().optional(),
  state: CallStateSchema.optional(),
  claimed_identity: z.string().optional(),
  risk_score: z.number().int().min(0).max(100).optional(),
  risk_level: RiskLevelSchema.optional(),
  outcome: CallOutcomeSchema.optional(),
  ended_at: z.string().datetime().optional(),
  summary: z.string().optional(),
});

export type CallRow = z.infer<typeof CallSchema>;
export type CallInsert = z.infer<typeof CallInsertSchema>;

// ---- call_events ----------------------------------------------------------

export const CallEventTypeSchema = z.enum([
  "transcript",
  "red_flag",
  "safe_word_attempt",
  "callback_started",
  "callback_result",
  "state_change",
  "alert_sent",
]);

export type CallEventType = z.infer<typeof CallEventTypeSchema>;

/** Per-type payload schemas. Each is validated before writing to the DB. */
export const CallEventPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("transcript"),       text: z.string(), speaker: z.enum(["caller", "system"]) }),
  z.object({ type: z.literal("red_flag"),         flag: z.string(), detail: z.string().optional(), quote: z.string().optional() }),
  z.object({ type: z.literal("safe_word_attempt"), matched: z.boolean(), attempt: z.string() }),
  z.object({ type: z.literal("callback_started"), target_phone: z.string() }),
  z.object({ type: z.literal("callback_result"),  outcome: z.string(), duration_seconds: z.number().int().optional() }),
  z.object({
    type: z.literal("state_change"),
    from: CallStateSchema,
    to: CallStateSchema,
    // Time-waster entry/exit details. Optional, so existing rows stay valid.
    started_at: z.string().datetime().optional(),
    ended_at: z.string().datetime().optional(),
    seconds: z.number().int().nonnegative().optional(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("alert_sent"),
    channel: z.enum(["sms", "call"]),
    recipient: z.string(),
    alert_type: z.enum(["risk", "checklist"]),
    level: RiskLevelSchema.optional(),
    recipient_id: z.string().optional(),
    status: z.enum(["sending", "sent", "failed"]).optional(),
  }),
]);

export type CallEventPayload = z.infer<typeof CallEventPayloadSchema>;

export const CallEventSchema = z.object({
  id: z.uuid(),
  call_id: z.uuid(),
  type: CallEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  created_at: z.string().datetime(),
});

export const CallEventInsertSchema = CallEventSchema.omit({ id: true, created_at: true });

export type CallEventRow = z.infer<typeof CallEventSchema>;
export type CallEventInsert = z.infer<typeof CallEventInsertSchema>;

// ---- fraud_reports --------------------------------------------------------

export const FraudReportSchema = z.object({
  id: z.uuid(),
  call_id: z.uuid(),
  report: z.record(z.string(), z.unknown()),
  created_at: z.string().datetime(),
});

export const FraudReportInsertSchema = FraudReportSchema.omit({ id: true, created_at: true });

export type FraudReportRow = z.infer<typeof FraudReportSchema>;
export type FraudReportInsert = z.infer<typeof FraudReportInsertSchema>;

// ---------------------------------------------------------------------------
// Client factories
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

/** Server-only client. Uses the service role key — never expose to the browser. */
export function createAdminClient(): SupabaseClient<Database> {
  return createClient<Database>(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** Browser client. Uses the anon key — safe to expose. */
export function createBrowserClient(): SupabaseClient<Database> {
  return createClient<Database>(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  );
}

// Lazily created server-side singleton (safe inside Node.js / edge functions
// because each serverless invocation gets a fresh module scope).
let _adminDb: SupabaseClient<Database> | null = null;

export function adminDb(): SupabaseClient<Database> {
  if (!_adminDb) _adminDb = createAdminClient();
  return _adminDb;
}

// ---------------------------------------------------------------------------
// households helpers
// ---------------------------------------------------------------------------

export async function getHouseholdByPhone(phone: string): Promise<HouseholdRow | null> {
  const { data, error } = await adminDb()
    .from("households")
    .select("*")
    .eq("senior_phone", phone)
    .maybeSingle();
  if (error) throw error;
  return data ? HouseholdSchema.parse(data) : null;
}

export async function getHousehold(id: string): Promise<HouseholdRow | null> {
  const { data, error } = await adminDb()
    .from("households")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? HouseholdSchema.parse(data) : null;
}

// ---------------------------------------------------------------------------
// contacts helpers
// ---------------------------------------------------------------------------

export async function getContactsForHousehold(householdId: string): Promise<ContactRow[]> {
  const { data, error } = await adminDb()
    .from("contacts")
    .select("*")
    .eq("household_id", householdId);
  if (error) throw error;
  return (data ?? []).map((row) => ContactSchema.parse(row));
}

export async function isTrustedContact(householdId: string, phone: string): Promise<boolean> {
  const { count, error } = await adminDb()
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("household_id", householdId)
    .eq("phone", phone);
  if (error) throw error;
  return (count ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// family_members helpers
// ---------------------------------------------------------------------------

export async function getFamilyMembers(householdId: string): Promise<FamilyMemberRow[]> {
  const { data, error } = await adminDb()
    .from("family_members")
    .select("*")
    .eq("household_id", householdId);
  if (error) throw error;
  return (data ?? []).map((row) => FamilyMemberSchema.parse(row));
}

export async function getAlertRecipients(householdId: string): Promise<FamilyMemberRow[]> {
  const { data, error } = await adminDb()
    .from("family_members")
    .select("*")
    .eq("household_id", householdId)
    .eq("gets_alerts", true);
  if (error) throw error;
  return (data ?? []).map((row) => FamilyMemberSchema.parse(row));
}

export async function getCallbackTargets(householdId: string): Promise<FamilyMemberRow[]> {
  const { data, error } = await adminDb()
    .from("family_members")
    .select("*")
    .eq("household_id", householdId)
    .eq("is_callback_target", true);
  if (error) throw error;
  return (data ?? []).map((row) => FamilyMemberSchema.parse(row));
}

// ---------------------------------------------------------------------------
// calls helpers
// ---------------------------------------------------------------------------

export async function createCall(insert: CallInsert): Promise<CallRow> {
  const validated = CallInsertSchema.parse(insert);
  const { data, error } = await adminDb()
    .from("calls")
    .insert(validated)
    .select()
    .single();
  if (error) throw error;
  return CallSchema.parse(data);
}

export async function getCallBySid(callSid: string): Promise<CallRow | null> {
  const { data, error } = await adminDb()
    .from("calls")
    .select("*")
    .eq("call_sid", callSid)
    .maybeSingle();
  if (error) throw error;
  return data ? CallSchema.parse(data) : null;
}

export async function getCallById(id: string): Promise<CallRow | null> {
  const { data, error } = await adminDb()
    .from("calls")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? CallSchema.parse(data) : null;
}

/** Newest call with no ended_at that started within `windowMs` of `now`. */
export async function getActiveCall(now: Date = new Date(), windowMs = 15 * 60 * 1000): Promise<CallRow | null> {
  const since = new Date(now.getTime() - windowMs).toISOString();
  const { data, error } = await adminDb()
    .from("calls")
    .select("*")
    .is("ended_at", null)
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? CallSchema.parse(data) : null;
}

export async function getFraudReportId(callId: string): Promise<string | null> {
  const { data, error } = await adminDb()
    .from("fraud_reports")
    .select("id")
    .eq("call_id", callId)
    .maybeSingle();
  if (error) throw error;
  return data ? String((data as { id: unknown }).id) : null;
}

export async function updateCall(
  callSid: string,
  patch: Partial<CallInsert>,
): Promise<CallRow> {
  const { data, error } = await adminDb()
    .from("calls")
    .update(patch)
    .eq("call_sid", callSid)
    .select()
    .single();
  if (error) throw error;
  return CallSchema.parse(data);
}

export async function updateCallState(callSid: string, state: CallState): Promise<CallRow> {
  return updateCall(callSid, { state });
}

export async function getRecentCalls(
  householdId: string,
  limit = 20,
): Promise<CallRow[]> {
  const { data, error } = await adminDb()
    .from("calls")
    .select("*")
    .eq("household_id", householdId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => CallSchema.parse(row));
}

/**
 * Calls of one household, newest first. `before` is an exclusive started_at
 * cursor (ISO string); rows with started_at < before are returned.
 */
export async function getCallsPage(
  householdId: string,
  limit: number,
  before?: string,
): Promise<CallRow[]> {
  let q = adminDb()
    .from("calls")
    .select("*")
    .eq("household_id", householdId)
    .order("started_at", { ascending: false })
    .limit(limit);
  if (before) q = q.lt("started_at", before);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((row: unknown) => CallSchema.parse(row));
}

/** The household the app serves: the demo household, else the oldest one. */
export async function getServedHouseholdId(): Promise<string | null> {
  const demo = await adminDb()
    .from("households")
    .select("id")
    .eq("is_demo", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (demo.error) throw demo.error;
  if (demo.data) return String((demo.data as { id: unknown }).id);
  const any = await adminDb()
    .from("households")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (any.error) throw any.error;
  return any.data ? String((any.data as { id: unknown }).id) : null;
}

/** The demo household (is_demo = true), oldest first, or null. No fallback. */
export async function getDemoHousehold(): Promise<HouseholdRow | null> {
  const { data, error } = await adminDb()
    .from("households")
    .select("*")
    .eq("is_demo", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? HouseholdSchema.parse(data) : null;
}

/** started_at of simulated calls of one household since `sinceIso`, newest first. */
export async function getSimulatedCallStarts(householdId: string, sinceIso: string): Promise<string[]> {
  const { data, error } = await adminDb()
    .from("calls")
    .select("started_at")
    .eq("household_id", householdId)
    .eq("is_simulated", true)
    .gte("started_at", sinceIso)
    .order("started_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return ((data ?? []) as { started_at: string }[]).map((r) => r.started_at);
}

/** One query: call_id -> fraud report id for the given calls. */
export async function getFraudReportIds(callIds: string[]): Promise<Record<string, string>> {
  if (callIds.length === 0) return {};
  const { data, error } = await adminDb()
    .from("fraud_reports")
    .select("id, call_id")
    .in("call_id", callIds);
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const r of (data ?? []) as { id: string; call_id: string }[]) out[r.call_id] = r.id;
  return out;
}

// ---------------------------------------------------------------------------
// call_events helpers
// ---------------------------------------------------------------------------

export async function appendEvent(insert: CallEventInsert): Promise<CallEventRow> {
  const validated = CallEventInsertSchema.parse(insert);
  // Validate the payload matches its declared type.
  CallEventPayloadSchema.parse({ type: validated.type, ...validated.payload });
  const { data, error } = await adminDb()
    .from("call_events")
    .insert(validated)
    .select()
    .single();
  if (error) throw error;
  return CallEventSchema.parse(data);
}

export async function getCallEvents(callId: string): Promise<CallEventRow[]> {
  const { data, error } = await adminDb()
    .from("call_events")
    .select("*")
    .eq("call_id", callId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => CallEventSchema.parse(row));
}

/** One query: state_change events (oldest first) grouped by call id. */
export async function getStateChangeEventsByCall(
  callIds: string[],
): Promise<Record<string, CallEventRow[]>> {
  if (callIds.length === 0) return {};
  const { data, error } = await adminDb()
    .from("call_events")
    .select("*")
    .in("call_id", callIds)
    .eq("type", "state_change")
    .order("created_at", { ascending: true });
  if (error) throw error;
  const out: Record<string, CallEventRow[]> = {};
  for (const row of data ?? []) {
    const e = CallEventSchema.parse(row);
    (out[e.call_id] ??= []).push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// fraud_reports helpers
// ---------------------------------------------------------------------------

export async function createFraudReport(insert: FraudReportInsert): Promise<FraudReportRow> {
  const validated = FraudReportInsertSchema.parse(insert);
  const { data, error } = await adminDb()
    .from("fraud_reports")
    .insert(validated)
    .select()
    .single();
  if (error) throw error;
  return FraudReportSchema.parse(data);
}

export async function getFraudReport(callId: string): Promise<FraudReportRow | null> {
  const { data, error } = await adminDb()
    .from("fraud_reports")
    .select("*")
    .eq("call_id", callId)
    .maybeSingle();
  if (error) throw error;
  return data ? FraudReportSchema.parse(data) : null;
}
