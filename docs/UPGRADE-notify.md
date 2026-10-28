# Upgrade: notifications, visible retries, honest status

About 10 minutes. Adds:

- **Phone notifications (ntfy)** when a longer run finishes, a run stops on an error, or HQ needs your approval. Tap one to open that chat; approvals have **Approve / Reject** buttons.
- **No more silent waits:** when the model provider times out (like the Cloudflare 524s on 2026-10-28), the chat shows *"The model provider timed out… Retrying in 30s (1/3)"*. If every try fails, the chat says so in one line and your phone buzzes.
- **Honesty rules** for HQ: it can't message you between runs, so it never promises to "ping" you; when blocked it states the exact error and stops; it never invents accounts or people; it knows a git 403 means the gateway token lacks access to that repo.
- Stopping a chat that waits for approval no longer brings the approval back after a restart.
- On phones the side panel starts closed, so a notification opens straight into the chat.

## 1. On your PC (PowerShell)

```powershell
cd $HOME\Documents\hq
git pull $HOME\Downloads\hq-notify.bundle main
git push origin main
```

## 2. On the VPS (`ssh hq`)

```bash
cd ~/hq && git pull
python3 scripts/init_env.py .env      # adds a random NTFY_TOPIC (keeps everything else)
echo 'MODEL_CONTEXT_TOKENS=80000' >> .env
make up
docker compose restart caddy          # new route for the notification buttons
```

`MODEL_CONTEXT_TOKENS=80000` makes long chats summarize their older part at around 68k tokens, so each step stays small and is less likely to time out. Leave it out if you'd rather keep full history in every step.

## 3. On your phone

1. Install **ntfy** (App Store / Google Play, free).
2. In the HQ console: **Settings → Notifications**. Copy the topic (starts with `hq-`).
3. In the ntfy app: **+** → paste the topic → Subscribe (server: ntfy.sh, the default).
4. Back in Settings, press **send a test**. Your phone should buzz with "HQ test notification".

Keep the topic private: anyone who knows it can read the notifications (they only carry chat titles and status, never code or secrets).

## Optional

- `MODEL_BACKUP=anthropic:glm-5.3` in `.env` (then `make up`): when the main model keeps failing, steps switch to GLM instead of stopping. Works best when the backup goes through a different provider or key.
- `NTFY_DONE_MIN_SECONDS=60` (default): "finished" notifications only for runs that took at least this long, since you were probably watching the short ones.
