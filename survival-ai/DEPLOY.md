# Run permanently (Ubuntu VPS + your own domain, HTTPS automatic)
Cost: roughly $5-6/month VPS + a domain. Use a VPS with a normal disk (not a free/ephemeral host): your ledger lives in data/.

1. Buy a domain; create a VPS (Ubuntu 24.04). Add a DNS "A" record: yourdomain -> the VPS IP.
2. SSH in: `ssh root@VPS_IP`. Then:
   apt update && apt install -y nodejs unzip
   adduser --system --group --home /opt/survival-ai survival
3. Upload and unpack (from your PC): `scp survival-ai.zip root@VPS_IP:/tmp/` then on the VPS:
   unzip /tmp/survival-ai.zip -d /tmp && cp -r /tmp/survival-ai/. /opt/survival-ai/
   cd /opt/survival-ai && cp .env.example .env && nano .env
   (set ADMIN_PASSWORD, BASE_URL=https://yourdomain, and your keys; no quotes, no trailing comments)
   chown -R survival:survival /opt/survival-ai && chmod 600 .env
4. Install Caddy using the official instructions at caddyserver.com/docs/install, then
   cp /opt/survival-ai/deploy/Caddyfile /etc/caddy/Caddyfile, edit the domain, and run: systemctl reload caddy
5. Start the app so it survives reboots and crashes:
   cp deploy/survival-ai.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now survival-ai
   systemctl status survival-ai    (logs: journalctl -u survival-ai -f)
6. Open firewall for web only: ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable
7. Stripe dashboard: add webhook https://yourdomain/webhook/stripe (event: checkout.session.completed), put its whsec_ in .env, then `systemctl restart survival-ai`.
8. Backups (important): copy /opt/survival-ai/data/ off the server regularly, e.g. daily cron: tar czf /root/bk-$(date +%F).tgz /opt/survival-ai/data
Stay on sk_test_ keys until a test deposit and payout both work end to end.
