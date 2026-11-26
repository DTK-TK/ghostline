# Design — dashboard-and-simulator

## Overview

The dashboard is a Next.js App Router app under `app/(dashboard)/`. It uses
server components for the initial data fetch and client components for
Realtime subscriptions. The simulator is a single API route for demo use.

---

## Route map

```
app/
  layout.tsx                     Root layout — dark theme, header
  page.tsx                       → redirect to /(dashboard)
  (dashboard)/
    layout.tsx                   Dashboard shell: header + sidebar
    page.tsx                     Call list (/)
    calls/[id]/page.tsx          Call detail
    settings/page.tsx            Household settings
  api/
    simulate/route.ts            POST /api/simulate
    settings/
      household/route.ts         PATCH — update name, time_waster_enabled
      contacts/route.ts          GET / POST trusted contacts
      contacts/[id]/route.ts     DELETE trusted contact
      members/route.ts           GET / POST family members
      members/[id]/route.ts      PATCH / DELETE family member
      safe-word/route.ts         POST — change safe word (hash + store)
  reports/[id]/page.tsx          Fraud report (already exists)
```

---

## Header component

```tsx
// app/(dashboard)/layout.tsx  or  components/Header.tsx
<header class="flex items-center gap-3 font-mono bg-zinc-900 px-6 py-3">
  <CassetteTapeIcon />              {/* lucide-react or custom SVG */}
  <span class="text-xl tracking-widest text-white">GHOSTLINE</span>
  {hasUnread && (
    <span
      class="ml-auto h-3 w-3 rounded-full bg-red-500 animate-pulse"
      aria-label="Unread alerts"
    />
  )}
</header>
```

`hasUnread` is derived server-side: query `calls` for
`risk_level IN ('medium','high')` and check a read-state store. The dot
re-renders via Realtime on the client.

---

## Call list page

Server component fetches initial rows via `getRecentCalls(householdId)`.
Client component (`<CallListClient>`) subscribes to Supabase Realtime
`calls` INSERT/UPDATE filtered by `household_id` and merges new rows into
local state.

```tsx
<Table>
  <TableHeader> started_at | from | claimed_identity | risk | score | outcome | → </TableHeader>
  {calls.map(c => (
    <TableRow key={c.id}>
      <Td>{formatTime(c.started_at)}</Td>
      <Td>{c.from_number ?? "unknown"}</Td>
      <Td>{c.claimed_identity ?? "—"}</Td>
      <Td><RiskBadge level={c.risk_level} /></Td>  {/* colour + text label */}
      <Td>{c.risk_score ?? "—"}</Td>
      <Td>{c.outcome ?? "—"}</Td>
      <Td><Link href={`/calls/${c.id}`}>View →</Link></Td>
    </TableRow>
  ))}
</Table>
```

`<RiskBadge>` renders both colour and text to satisfy the accessibility rule:

```tsx
const COLOURS = { low: "bg-green-500", medium: "bg-amber-500", high: "bg-red-500" };
<Badge class={COLOURS[level]}>{level.toUpperCase()}</Badge>
```

---

## Call detail page

Server component:

1. `getCallBySid` / query by UUID.
2. `getCallEvents(call.id)` — full event timeline.
3. `getFraudReport(call.id)` — link if present.

Client component (`<CallDetailClient>`):
- Subscribes to Realtime on `call_events` filtered by `call_id`.
- Subscribes to Realtime on `calls` filtered by `id`.
- Appends new events to the timeline live.
- Updates risk score + state badge when the call row changes.
- On mount: marks call as "read" (removes from unread count).

---

## Settings page

Three shadcn/ui card sections:

1. **Household** — editable family name field + time-waster `<Switch>`.
2. **Trusted contacts** — `<Table>` of contacts, add via `<Dialog>` form,
   delete with confirmation.
3. **Family members** — `<Table>` with `gets_alerts` and `is_callback_target`
   `<Switch>` per row, add via `<Dialog>`.
4. **Safe word** — single `<Input type="password">` + confirm field. On save,
   the new word is sent to `POST /api/settings/safe-word` where it is hashed
   server-side. The hash is never sent to the client.

All mutations call the matching API route with `fetch`. On success, the page
re-fetches or uses optimistic updates.

---

## Safe-word change API

```
POST /api/settings/safe-word
Body: { newWord: string, householdId: string }

Server:
  normalised = newWord.trim().toLowerCase()
  hash = await bcrypt.hash(normalised, 12)
  await adminDb().from("households").update({ safe_word_hash: hash }).eq("id", householdId)
  return { ok: true }
```

The plaintext `newWord` exists only in memory on the server for the duration
of the hash computation. It is never stored, logged, or returned.

---

## Simulator

```
POST /api/simulate
Body: { scenario, householdId }

Gate: if ENABLE_SIMULATOR !== "true" → return 404

1. getHousehold(householdId)                        verify exists
2. createCall({ household_id, call_sid: "sim_"+uuid, from_number: "+15550000000", state: "screening" })
3. for each turn in SCENARIOS[scenario]:
     appendEvent(transcript, { text: turn.callerUtterance, speaker: "caller" })
     result = await engine({ callSid, speechResult: turn.callerUtterance, … })
     if (result.nextState changed) appendEvent(state_change)
     updateCall(…)
4. if final risk_level in ["medium","high"]:
     await sendAlerts(context)
5. if final risk_level === "high":
     await buildAndStoreReport(call.id)
6. return { callId: call.id, riskLevel, riskScore, outcome }
```

### Scenario scripts

```typescript
const SCENARIOS = {
  grandparent_scam: [
    { callerUtterance: "Hi it's me, your grandson Tommy." },
    { callerUtterance: "I'm in jail, I need bail money right now." },
    { callerUtterance: "Please don't tell anyone, send gift cards." },
  ],
  cra_scam: [
    { callerUtterance: "This is the CRA calling about your tax account." },
    { callerUtterance: "You owe two thousand dollars, pay immediately or be arrested." },
    { callerUtterance: "Wire transfer to this account, don't call anyone." },
  ],
  tech_support: [
    { callerUtterance: "Hello, I'm calling from Microsoft support." },
    { callerUtterance: "Your computer has a virus, install AnyDesk right now." },
    { callerUtterance: "Give me the access code on your screen." },
  ],
  legitimate_caller: [
    { callerUtterance: "Hi, this is Dr. Rivera calling about an appointment." },
    { callerUtterance: "I just wanted to confirm tomorrow at 2pm." },
  ],
};
```

---

## Realtime subscription pattern

```typescript
// client component
const channel = browserDb()
  .channel("calls:" + householdId)
  .on("postgres_changes", {
    event: "*",
    schema: "public",
    table: "calls",
    filter: `household_id=eq.${householdId}`,
  }, (payload) => {
    // merge payload.new into local state
  })
  .subscribe();

// cleanup
return () => { channel.unsubscribe(); };
```

---

## Testing strategy

| Test file | What it covers |
|---|---|
| `tests/simulate.test.ts` | Each scenario ends with the expected risk level; 404 when ENABLE_SIMULATOR unset |
| `tests/settings.test.ts` | Safe-word route hashes correctly and never echoes plaintext; contact CRUD round-trips |
| Manual | Open dashboard on two browser tabs; trigger a simulated call; confirm the call list updates live in both tabs; verify unread dot appears and clears on navigation |
