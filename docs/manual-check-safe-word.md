# Manual check: safe word seed (task 4b)

**Status: NOT DONE.** This check needs the real Supabase project and the dev
phone. It has not been run. The automated part (prefix test) is in
`tests/safe-word.test.ts`.

Do not paste the safe word or any hash into the PR, chat or logs. Record only
pass or fail.

## 1. Run the seed

In the Supabase SQL editor, run the contents of `supabase/seeds/demo.sql`.
It hashes the word with `crypt('pumpkin', gen_salt('bf', 12))`.

## 2. Confirm the hash prefix

```sql
select left(safe_word_hash, 4) as prefix from households;
```

Expected: `$2a$` for the demo household. Do not select the full hash.

## 3. Confirm on the dev phone

1. Start the app (`npm run dev`) with real Supabase env vars (see `DEV-PHONE.md`).
2. Open `/dev/phone` and start a call as an unknown caller.
3. Claim to be family (for example: "Grandma, it's me, your grandson").
4. When asked "What's the family word?", say `pumpkin`.
5. Expected: the call is accepted as verified and the score drops by 40
   (check on `/calls`). A wrong word must not verify.

Steps 3 to 5 depend on tasks 6 and 7 (`lib/safe-word.ts` and the engine
challenge). Until they land, only steps 1 and 2 can be run.

## Result

- [ ] Seed ran
- [ ] Prefix is `$2a$`
- [ ] "pumpkin" accepted on the dev phone
