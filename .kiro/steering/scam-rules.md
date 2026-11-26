---
inclusion: fileMatch
fileMatchPattern: "lib/scoring/**"
---
Scam red flags and weights (rules layer)
| Flag id | Signals (examples) | Points |
| payment_method | gift card, iTunes, Google Play, bitcoin, crypto, wire, Western Union, courier, "someone will pick it up" | 40 |
| secrecy | don't tell mom/dad, keep this between us, don't call anyone | 30 |
| authority | bank, CRA, police, RCMP, lawyer, court, Microsoft support | 30 |
| emergency_story | jail, arrested, bail, accident, hospital, kidnapped | 25 |
| urgency | right now, tonight, immediately, before it's too late | 20 |
| remote_access | install, AnyDesk, TeamViewer, give me the code | 30 |
| safe_word_fail | wrong or refused safe word (each failure) | 50 |
| callback_denied | real family member confirms they are NOT calling | 100 |
Bands: LOW 0-39 (connect or take message), MEDIUM 40-69 (take message + alert),
HIGH 70+ (block, alert, report). Score = max(rules score, AI score). The AI may raise a
score, never lower it. A correct safe word subtracts 40, floor 0, but never cancels
callback_denied.