# How we used Kiro

Evidence for Kiroween 2026, Resurrection category. Everything below comes from the git history, `.kiro/`, `tests/`, `docs/` and the saved Kiro chat reports in `docs/kiro-evidence/`. The one item the repo cannot confirm is marked <TO CONFIRM>.

## Timeline (git log, all 2026-11-26, times -0500)

| Time | Commit | Message |
| --- | --- | --- |
| 01:09 | e8929d6 | Initial commit |
| 01:39 | ef86b27 | Kiro steering docs and Next.js scaffold |
| 01:41 | e83bd6b | Merge branch 'main' |
| 02:26 | c2c1d8e | Code for specs 3-7 (pre-spec), review findings |
| 03:05 | 2af71d4 | specs |
| 03:53 | a431342 | Voice route tests (33 passing), vite dev dependency |
| 04:23 | a9804f8 | Full specs |
| 04:29 | 6556e33 | MVP plan: specs split into MVP and deferred |
| 04:51 | 6ba84a0 | Item 1 + item 10: real engine, silence fix, 30 fixtures, property tests |
| 04:57 | 2fcf934 | Task 16 |
| 05:02 | 3817f8e | Courier rule needs money context; fixtures updated |
| 05:30 | 63884b2 | Items 2, 4, 11, 12: shared turn code, RLS + passcode, Live and Calls pages |
| 05:59 | 281c7e7 | Items 1b, 3, 9: no first-turn connect, report page, report on HIGH |
| 06:27 | 7f984c1 | Item 5: safe word check, redaction, family-claim detection |
| 06:32 | 89da7fe | Scan failed safe word answers for red flags; amount extractor fix |
| 07:44 | 60d76f6 | Items 6 + 7: callback check, time-waster limit |
| 08:15 | a398b64 | ASCII-only SMS and prompts; fix corrupted Gemini prompt |
| 11:38 | 7a14bc3 | ASCII-only SMS and prompts; fix corrupted Gemini prompt |
| 11:48 | 0289eae | Item 14: startup guard, dev tools gate, dev phone fixes |
| 11:51 | acc8238 | Callback score effect tests |
| 12:04 | dded36c | Fix production build; tick finished tasks; ignore local SQL |

The commit dates show the whole project in one calendar day. The submission deadline in the specs is Dec 4, 2026.

## Specs

Seven specs live in `.kiro/specs/`, each with `requirements.md`, `design.md` and `tasks.md`. Five also have a `tasks.meta.json` (Kiro's task execution record): alerts-and-report, conversation-and-scoring, dashboard-and-simulator, safe-word-and-callback, time-waster.

| Spec | What it covers |
| --- | --- |
| data-model | Supabase schema, households, contacts, family members, calls, call events, fraud reports, the demo seed. |
| call-handling | The Twilio voice webhooks (incoming, turn, status), signature validation, the call state machine, TwiML. |
| conversation-and-scoring | The multi-turn screening conversation, the rules layer plus one Gemini call per turn, score combination. |
| safe-word-and-callback | The safe word challenge (R1-R13) and the callback to a family member. |
| time-waster | The grandmother persona on HIGH calls, 3-minute limit, disabled means BLOCK (R1-R14). |
| alerts-and-report | Risk SMS, money-move checklist SMS, fraud report and CAFC text. |
| dashboard-and-simulator | Live, Calls and Settings pages, the Simulate button, test mode and `/dev/phone`. |

### Spec-driven compared with vibe coding

What the history shows:

- **Vibe-coded first.** Commit c2c1d8e ("Code for specs 3-7 (pre-spec), review findings", 02:26) added 24 files and 3,215 lines of code (webhooks, scoring, alerts, report, db, TwiML) together with only two specs: call-handling and data-model. The other five specs did not exist yet.
- **The review.** The review ran in a Kiro chat session. Its report is saved in `docs/kiro-evidence/` (the spec review; the codebase inventory is saved there too). It found that five specs were missing and that the safe word was not wired into any live route (see below). The commit message records it as "review findings".
- **Back-filled specs.** 2af71d4 (03:05) added the five missing specs (conversation-and-scoring, safe-word-and-callback, time-waster, alerts-and-report, dashboard-and-simulator), 2,516 lines. a9804f8 ("Full specs", 04:23) rewrote all five.
- **Specs written from the code.** The new `tasks.md` files open with "Status was checked by reading the code and imports, not from earlier notes." A task is ticked only if the code does it and a route reaches it. The files list what existed but was not wired:
  - safe-word-and-callback: "Nothing in the safe-word or callback behaviour meets that bar today". The safe word hash, callback targets and event types existed, but no live route passed `callbackDenied`. An earlier version of the file had cited a proof that did not exist and a wrong expected value (60 instead of at least 100).
  - alerts-and-report: `sendAlerts`, `buildAlertSms`, `buildChecklistSms` and the report builder existed but nothing called them. The earlier version had ticked about ten items and cited `tests/alerts.test.ts` and `tests/report.test.ts`, which did not exist. The report page did not compile.
  - conversation-and-scoring: `app/api/voice/turn/route.ts` imported the stub `runTurn`, which always returned the same safe defaults, so a real call never reached the real engine.
  - dashboard-and-simulator: `createBrowserClient()`, the Realtime publication, and `MockTelephony` were unreachable.
- **Specs drove the fixes.** After the specs, commits are named by build item and map to spec tasks: Item 1 real engine (6ba84a0), Items 2/4/11/12 shared turn code, RLS and passcode, Live and Calls pages (63884b2), Items 1b/3/9 report page and report on HIGH (281c7e7), Item 5 safe word (7f984c1), Items 6/7 callback and time-waster limit (60d76f6), Item 14 startup guard and dev gate (0289eae). Each task in the specs carries a "Proof:" line naming the test that shows it works.

What we can say about the comparison: the vibe-coded pass produced a large amount of code fast, and the spec pass found that several parts did not connect (the stub engine, the unwired safe word and alerts, tests cited but missing). A codebase inventory then found one more real bug: scam calls were connected to the senior after one harmless first line (fixed as Item 1b in 281c7e7, "no first-turn connect"). Time spent in each mode is not recorded.

Items 8 and 13 have no commit of their own. Item 13, the simulator, was built in the "Items 2, 4, 11, 12" batch (63884b2, 05:30). Item 8 (alert quotes, SMS length limits, at-most-once alerts, `alertCall`) was built after Item 7 (60d76f6, 07:44); the nearest commits are the SMS work in a398b64 and 7a14bc3 ("ASCII-only SMS and prompts").

## Steering docs

Seven files in `.kiro/steering/`. Five are always included, two load only when matching files are in play.

| File | Inclusion | What it controlled |
| --- | --- | --- |
| `product.md` | always | What Ghostline is, who the users are, the hackathon category, and the rule never to promise deepfake detection (the safe word is the defence). |
| `tech.md` | always | The stack, Twilio signature validation on every webhook, Gemini `gemini-2.5-flash` with zod, state in the database keyed by CallSid, the 10-second webhook limit, and (added in a431342) "All external services go through lib/providers". It said Next.js 15 until we corrected it to Next.js 16 (installed: 16.4.6). |
| `structure.md` | always | File layout: webhooks under `app/api/voice/*`, "No business logic inside route files", one function per file, tests and fixtures in `tests/`. |
| `privacy.md` | always | Every screened call announces itself, safe word stored only as a bcrypt hash, no keys, tokens or full phone numbers in logs, fraud reports never auto-submitted, demo data uses fake names and teammates' verified numbers. Tests: `log-privacy.test.ts`, `safe-word.test.ts`. |
| `voice-persona.md` | always | The fixed opening line, short sentences (max 2 per turn, under 25 words), never accuse a caller, never reveal the safe word, the time-waster persona and its 3-minute cap. Tests: `reply-guard.test.ts`, `time-waster-*.test.ts`. |
| `scam-rules.md` | fileMatch `lib/scoring/**` | The red-flag table and weights, the LOW/MEDIUM/HIGH bands, "the AI may raise a score, never lower it", and the safe word and callback adjustments. Mirrored in `lib/scoring/rules.ts`. |
| `ui.md` | fileMatch `app/**/*.tsx` | Dark theme, risk colours with a text label (not colour only), 16px base text, header with cassette icon. |

The workspace also has an `AGENTS.md` block that tells the agent to read `node_modules/next/dist/docs/` before writing Next.js code. It was used when fixing the build (see Audit).

## Agent hooks

None. There is no `.kiro/hooks` directory in the repo.

## MCP

None configured in the workspace: there is no `.kiro/settings/mcp.json` in the repo. User-level MCP configuration is outside the repo. <TO CONFIRM>

## Property-based testing

Library: fast-check with vitest. 20 test files use `fc.assert`. The properties:

- **Scoring** (`scoring-properties.test.ts`, 4 properties, 200 runs each):
  - (a) the rules score never decreases when utterances are appended;
  - (b) payment plus urgency signals score at least 60 and at least MEDIUM;
  - (c) `callbackDenied` is always HIGH, even with a correct safe word;
  - (d) without a safe word, the combined score is at least `min(100, rulesScore)` and is monotonic in the AI score.
- **Score combination** (`scoring-combine.test.ts`): score stays within 0..100, is at least the prior score when that is 100 or less, and a denial is always HIGH for any prior score.
- **Callback** (`callback.test.ts`): a denial forces HIGH for any prior score; a confirmation lowers any stored score by exactly 40 with a floor of 0.
- **Rule quotes** (`scoring-rules.test.ts`): every quote is non-empty, at most 120 characters, and matches its flag.
- **Reply guard** (`reply-guard.test.ts`): any accepted reply is under 25 words and at most 2 sentences.
- **Safe word** (`safe-word.test.ts`): `normalise` is idempotent. Failed-attempt text and hashes are never logged.
- **Family claim** (`family-claim.test.ts`): the detector never throws and is deterministic.
- **Time-waster** (`time-waster-properties.test.ts`, `time-waster-engine.test.ts`): the call ends exactly when elapsed time reaches the limit.
- **Alerts** (`alerts.test.ts`): SMS text is ASCII, at most 320 characters, ends with the exact link, contains no other URL, and never includes the caller's payment text.
- **Privacy** (`log-privacy.test.ts`): `MockTelephony` never logs a body or a full number for any input.
- **Dashboard** (`dashboard-auth.test.ts`, `dev-gate.test.ts`): a token is valid only for its own passcode; the dev gate matches its rule for every env combination.
- **Dashboard data** (`calls-list.test.ts`, `live-poll.test.ts`, `live-format.test.ts`, `live-status.test.ts`, `call-id.test.ts`, `report-view.test.ts`, `simulate-routes.test.ts`): page size never exceeded; polled events are unique, sorted and idempotent; values clamp to 0..100; ids accept every generated uuid and reject others; the simulator rate limit holds.

Fixture tests: 30 scripted calls in `tests/fixtures/` (15 scams across grandparent, CRA, bank, tech and romance; 15 legitimate calls from doctors, pharmacies, deliveries, grandchildren and neighbours). `fixtures.test.ts` checks each against its expected level. A fixture marked `knownGap` runs under `it.fails`, so when the rules improve the test flips and prompts removal of the mark. `fixtures-engine.test.ts` replays every fixture turn by turn through the real engine with the mock AI.

### Bugs found

- **Bare "courier", "wire", "bank" and "install" over-flagged (3817f8e, 05:02).** The `scoring-rules` tests failed against requirement R3 (task 17). The rules treated a bare "courier will pick up", "wire", "bank" or "install" as a scam signal, so a real delivery could be scored MEDIUM. We changed R3 to require money context in the same caller turn. Tests now assert that "the courier is dropping off your parcel today", "your bank called about your appointment" and "I need to wire the new lamp in the hall" stay LOW, and that "wire the money tonight" and "a courier will pick up the cash" flag `payment_method`. This was found by the example-based `scoring-rules` tests and the fixtures, not by a property test.
- **Same change fixed a missed scam.** The bank fixture `scam-bank-3` ("withdraw cash and give it to our courier today", keep this secret) had been marked `knownGap` with the reason "only secrecy fires, score 30 (LOW)". The money-context rule moved it from LOW to HIGH, and the `knownGap` mark was removed.
- **Amount 3000 became 300 (89da7fe, 06:32).** `extractAmount` in `lib/extract-evidence.ts` cut "3000" to "300". The new safe-word engine test for scanning failed answers (task 7b, `tests/safe-word-engine.test.ts`) caught it. It was not a property test. The fix adds a plain-digits alternative to the pattern.
- **Failed safe word answers hid red flags (89da7fe).** A scammer's wrong "answer" can itself contain a payment request or amount. Decision: scan failed answers in memory for red flags and amounts, and never store the attempt text. The tests assert the scripted word is absent from every stored event.
- **Corrupted Gemini prompt (a398b64, 7a14bc3).** Em dashes in files were garbled by file encoding (PowerShell's default encoding). An ASCII-only check of the SMS strings exposed it. The Gemini prompt was then rewritten in plain ASCII and saved as UTF-8. `alerts.test.ts` asserts ASCII for every generated SMS.
- **`/dev/phone` frozen at build time (dded36c).** After the build fix, `/dev/phone` rendered as a static page. It now exports `dynamic = "force-dynamic"`.

Property tests guard the scoring, combine, callback, reply-guard, time-limit and alert-text invariants listed above. The bugs in this section were found by example tests, fixture tests and Kiro review sessions, not by a property failing.

## MVP re-plan

Commit 6556e33 (04:29, "MVP plan: specs split into MVP and deferred") re-planned all seven `tasks.md` files for the hackathon deadline of Dec 4, 2026. Every task is kept. Each file now has "## MVP (build now)" and "## Deferred (post-hackathon)" sections, and each `design.md` has a "Re-plan decisions" section.

- **MVP reason:** "Everything the Dec 4, 2026 demo needs: a real call through the real engine, safe word and callback checks, the alert and fraud report, and the dashboard to watch it."
- **Deferred reason:** "Not needed to show the demo (the demo household is seeded with SQL), so these wait until after the hackathon."
- **Decisions recorded in the design docs:**
  - `/api/voice/turn` calls the real engine through `processTurn()`, and the stub is removed.
  - One silent turn gets a reply and the call keeps listening; two silent turns in a row hang up. The count comes from `call_events`.
  - Realtime is replaced by 2-second polling.
  - Settings CRUD is deferred; the demo household is seeded with SQL.
  - Access uses one `DASHBOARD_PASSCODE` and RLS on every table with no policies. Supabase Auth, `family_members.user_id` and the read policies are deferred (see `0004_dashboard.sql`).
  - The twiml and twilio-validate unit tests and extra incoming tests (call-handling tasks 8, 9, 10) are deferred.
  - The simulator reads scenarios from the 30 fixtures and always labels its output SIMULATED. It needs `ENABLE_SIMULATOR`, a demo household and a rate limit.

## Full audit and the build failure

The full completion audit ran in a Kiro chat session and its report is saved in `docs/kiro-evidence/` (the full completion audit; the MVP re-plan report is saved there too). The fixes landed in dded36c (12:04, "Fix production build; tick finished tasks; ignore local SQL").

What the repo and history show:

- `npm run build` failed with 19 errors. `next.config.ts` had `cacheComponents: true`, and 15 API routes exported `runtime = "nodejs"` while 4 pages (calls, calls/[id], live, unlock) exported `dynamic = "force-dynamic"`. The Next.js docs in `node_modules/next/dist/docs/` (read as `AGENTS.md` requires) say Cache Components does not support the `runtime` export and removes `dynamic`.
- The fix turned off `cacheComponents` and `partialPrefetching` in `next.config.ts`, which this app does not need because every page must show fresh per-request data. No route exports were changed. The build then listed every API route and dashboard page as dynamic.
- The failure showed up only in `npm run build`, run during the audit. `vitest` and `tsc` do not run the Next.js build, so neither would report it.
- Final state at the last run: build succeeds, 46 test files, 661 tests passing plus 6 expected failures (667), `tsc --noEmit` with 0 errors.
- The same commit ticked the finished tasks: call-handling 7 and 11, data-model 5, dashboard-and-simulator 14, and added `*.local.sql` to `.gitignore`. Data-model task 5 is confirmed done: the intended MVP design is RLS on with no policies (the browser and anon role read nothing; the server uses the service role), plus a dashboard passcode checked in `proxy.ts`. Supabase Auth policies are deferred (see `0004_dashboard.sql`).

Manual checks, from `docs/`: `docs/manual-check-safe-word.md` is marked "NOT DONE" (needs a real Supabase project and the dev phone), and `docs/manual-check-simulate.md` needs a human with a browser and a screen recording. Their latest results are not recorded in the repo.
