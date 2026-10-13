# Deploy on Render (paid "Starter" web service + persistent disk, about US$7/month)
The disk is required: it keeps your ledger and memory across restarts. Free plans have no disk and would erase them.
1. Put this folder in a PRIVATE GitHub repository (never commit .env or data/; .gitignore already blocks them).
2. render.com -> New -> Blueprint -> pick the repo. Render reads render.yaml.
3. Fill the prompted values. Start with ADMIN_PASSWORD (12+ chars) and STRIPE keys as sk_test_. Leave BASE_URL as https://placeholder for now.
4. After the first deploy Render shows your https://NAME.onrender.com address. Set BASE_URL to exactly that (no trailing slash), save; it redeploys.
5. Stripe dashboard -> Developers -> Webhooks -> add https://NAME.onrender.com/webhook/stripe, event checkout.session.completed; paste its whsec_ into STRIPE_WEBHOOK_SECRET.
6. Open the address, sign in. Test a deposit with card 4242 4242 4242 4242 before ever using live keys.
Backups: Render disks support snapshots; also download data/ occasionally via Render's Shell (tar czf) since the ledger is your money record.
