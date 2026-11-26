# Tasks — dashboard-and-simulator

---

## R1 — Dashboard layout and branding

- [ ] `app/(dashboard)/layout.tsx` exists with dark-theme shell, cassette-tape icon,
  "GHOSTLINE" in a monospace font, and an accessible red blinking dot for unread
  alerts.
  - _Proof: Manual — open `/`; confirm header appears with correct branding.
    Automated: `tests/dashboard.test.ts` — render the layout; assert the heading
    text is "GHOSTLINE" and the font class is monospace._

  > **Status:** `app/layout.tsx` exists but is the root Next.js scaffold; there
  > is no `app/(dashboard)/layout.tsx` and the header component does not exist.

- [ ] Every risk indicator in the UI shows both a colour swatch and a text label
  (`LOW`, `MEDIUM`, or `HIGH`).
  - _Proof: Manual — navigate the call list; confirm each row's risk cell has both
    a coloured badge and a text label. No risk shown with colour alone._

---

## R2 — Call list page

- [ ] `app/(dashboard)/page.tsx` (or `app/page.tsx`) renders a table of recent calls
  with the required columns: time, caller number, claimed identity, risk (colour +
  label), score, outcome, and a detail link.
  - _Proof: Manual — open `/`; confirm the call table renders with all columns._

  > **Status:** `app/page.tsx` is still the default Next.js starter template.
  > No call list exists.

- [ ] The call list subscribes to Supabase Realtime and inserts new rows at the top
  without a page reload.
  - _Proof: Manual — open the dashboard on two tabs; use the simulator to create a
    new call; confirm it appears in both tabs without refreshing._

---

## R3 — Call detail page

- [ ] `app/(dashboard)/calls/[id]/page.tsx` exists and renders all call fields,
  the event timeline, a fraud report link (when present), and live Realtime
  updates while the call is active.
  - _Proof: Manual — open a call detail page for an active call; watch the risk
    score update in real time as simulator turns progress._

  > **Status:** No `calls/[id]` page exists.

---

## R4 — Settings page

- [ ] `app/(dashboard)/settings/page.tsx` exists with editable household name,
  trusted contacts CRUD, family members CRUD with `gets_alerts` and
  `is_callback_target` toggles, time-waster toggle, and safe-word change form.
  - _Proof: Manual — open `/settings`; add and remove a trusted contact; confirm
    the change persists on page reload._

  > **Status:** No settings page exists.

- [ ] `POST /api/settings/safe-word` hashes the new word with bcrypt (cost 12) and
  stores only the hash. The plaintext is never stored, logged, or returned.
  - _Proof: `tests/settings.test.ts` — POST a new word; query the DB; assert
    `safe_word_hash` is a bcrypt string starting with `$2b$12$`; assert the
    response body does not contain the plaintext._

---

## R5 — Unread alert indicator

- [ ] The header blinking dot appears when any call in the household has
  `risk_level IN ('medium','high')` and has not been viewed.
  - _Proof: Manual — create a HIGH-risk simulated call; confirm the dot appears.
    Navigate to the call detail page; confirm the dot disappears._

- [ ] The read/unread state clears when the call detail page is visited.
  - _Proof: Manual — as above._

  > **Status:** No read/unread tracking exists anywhere in the codebase.

---

## R6 — Simulator endpoint

- [ ] `app/api/simulate/route.ts` exists and accepts
  `{ scenario, householdId }`.
  - _Proof: `tests/simulate.test.ts` — POST each scenario; assert 200 and
    `{ callId, riskLevel, riskScore, outcome }` in the response._

  > **Status:** Route does not exist.

- [ ] Each scenario produces the expected risk level:
  - `grandparent_scam` → HIGH
  - `cra_scam` → HIGH
  - `tech_support` → HIGH
  - `legitimate_caller` → LOW
  - _Proof: `tests/simulate.test.ts` — one assertion per scenario._

- [ ] The simulator calls `sendAlerts()` for MEDIUM/HIGH results.
  - _Proof: `tests/simulate.test.ts` — mock `sendAlerts`; run a HIGH scenario;
    assert it was called._

- [ ] The simulator calls `buildAndStoreReport()` for HIGH results.
  - _Proof: `tests/simulate.test.ts` — mock `buildAndStoreReport`; run a HIGH
    scenario; assert it was called._

---

## R7 — Simulator security

- [ ] The simulate route returns 404 when `ENABLE_SIMULATOR` is not `"true"`.
  - _Proof: `tests/simulate.test.ts` — unset the env var; POST to the route;
    assert 404._

---

## R8 — Realtime updates

- [ ] The call list client subscribes to Supabase Realtime `calls` INSERT/UPDATE
  filtered by `household_id` and merges rows without a reload.
  - _Proof: Manual — described in R2._

---

## R9 — Server vs browser client

- [ ] Server components (initial data fetch) use `adminDb()` with the service role
  key. Client components (Realtime) use `createBrowserClient()` with the anon key.
  The service role key does not appear in any `"use client"` file.
  - _Proof: `grep -r "SUPABASE_SERVICE_ROLE_KEY" app/` returns only server-side
    files (no `"use client"` at the top). `grep -r "createBrowserClient"` appears
    only in client components._

---

## R10 — Accessibility

- [ ] Every `<Switch>`, `<Button>`, and `<Link>` in the dashboard has an accessible
  label (either visible text or `aria-label`).
  - _Proof: Manual — run axe-core or Lighthouse accessibility audit on each page;
    assert no "Elements must have accessible names" violations._

---

## Extra tasks

- [ ] Create `app/(dashboard)/layout.tsx` with the Ghostline header (cassette icon,
  monospace "GHOSTLINE", blinking unread dot) using shadcn/ui and Tailwind only.
  - _Proof: Manual — header is visible on all dashboard pages with correct styling._

- [ ] Create `app/(dashboard)/page.tsx` with the call list table and Supabase
  Realtime subscription, replacing the current Next.js starter template.
  - _Proof: Manual — call list loads and updates live._

- [ ] Create `app/(dashboard)/calls/[id]/page.tsx` with event timeline and live
  risk updates.
  - _Proof: Manual — open an active call; watch score update._

- [ ] Create `app/(dashboard)/settings/page.tsx` with all four sections.
  - _Proof: Manual — settings page CRUD round-trips._

- [ ] Create `app/api/simulate/route.ts` with the four scenarios, engine execution
  loop, and `ENABLE_SIMULATOR` gate.
  - _Proof: `tests/simulate.test.ts` — all scenario assertions pass._

- [ ] Write `tests/simulate.test.ts` covering all four scenarios, risk levels,
  `sendAlerts`/`buildAndStoreReport` calls, and the 404 gate.
  - _Proof: `npx vitest run tests/simulate.test.ts` passes._

- [ ] Write `tests/settings.test.ts` covering safe-word hashing, contact CRUD API
  routes, and the time-waster toggle.
  - _Proof: `npx vitest run tests/settings.test.ts` passes._
