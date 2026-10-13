# Survival AI (real version)
Node 18+, zero dependencies. `cp .env.example .env`, fill it, then `set -a; . ./.env; set +a; node server.js`.

**What is real:** append-only AUD ledger (integer cents); Stripe Checkout deposits credited only by signature-verified webhooks (idempotent); withdrawals = Stripe payouts, only after you approve and retype the exact amount; the agent calls Claude on a timer and its actual token cost is booked as an expense; it shuts down at $0; daily spend cap; long-term memory (agent `remember` tool + your own entries, last 40 fed into each run).

**Safety design:** the agent cannot move or spend money. It can only remember and *propose* actions that you carry out. No private keys/seed phrases anywhere. Crypto is intentionally not included: use a custody provider rather than self-hosted keys.

**Go live in order:** 1) run with `sk_test_` keys + `stripe listen --forward-to localhost:3000/webhook/stripe`, test a deposit with card 4242 4242 4242 4242 and a payout. 2) Deploy behind HTTPS (set BASE_URL, point the Stripe webhook at `/webhook/stripe`). 3) Only then switch to `sk_live_`.

**Limits to know:** single owner, single process, JSON/JSONL files (back up `data/`). Withdrawal payouts draw on your *Stripe balance* (funds settle after a delay), so a payout can fail even if the ledger shows a balance; failures show on the withdrawal. Not tested against live Stripe/Anthropic APIs. Check Stripe's rules for your business and AU tax/ASIC obligations before taking other people's money.
