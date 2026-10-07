# Upgrading the VPS to Phase 1

About 15 minutes. Your Postgres data (threads, checkpoints) lives in a Docker volume and is untouched. Your memories move with `data/`.

## 1. Create the GitHub token (on your PC, in the browser)

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token:

- **Repository access:** Only select repositories → pick the repos HQ may work on.
- **Permissions:** Contents → *Read and write*. Metadata → *Read* (added automatically). If you'll use the GitHub MCP tools for PRs, also Pull requests → *Read and write*.
- Expiration: your call. The gateway tells the agent clearly when the token expires, and the agent tells you.

Optional, recommended: in each of those repos, Settings → Rules → Rulesets → protect `main` (require a pull request, **no bypass**). The gateway already refuses pushes to `main`. This makes even a leaked token unable to touch it.

## 2. Move the VPS checkout to the flat layout

Phase 0 was cloned nested (`~/hq/deepagent-hq`). The repo is now flat, so the stack runs from `~/hq` itself.

```bash
ssh hq
cd ~/hq/deepagent-hq && docker compose down       # stop Phase 0 (volumes are kept)
cd ~/hq
mkdir -p ~/phase0-backup && cp -a deepagent-hq/.env deepagent-hq/data ~/phase0-backup/   # safety copy
git pull                                          # flattens the repo, deletes the old zip
mv deepagent-hq/.env deepagent-hq/data .          # bring your config and memories along
[ -d deepagent-hq/backups ] && mv deepagent-hq/backups .
rm -rf deepagent-hq                               # only leftovers from the old layout remain
git status                                        # should be clean
```

Compose's project name is fixed (`name: hq`), so Postgres comes back with all its data.

## 3. Configure Phase 1

```bash
make init                         # adds GIT_GATEWAY_SECRET to .env, creates secrets/git-gateway.env
nano secrets/git-gateway.env      # paste the token; adjust GIT_GATEWAY_ALLOWED_REPOS if needed
nano .env                         # optional: GITHUB_MCP_TOKEN, HQ_GIT_AUTHOR_EMAIL, reaper timings
make up                           # builds the agent + git-gateway images and starts everything
```

`make up` now also creates the `hq-sandbox` network the gateway shares with sandboxes. The sandbox image itself didn't change, so there's no need to rebuild it.

## 4. Check it

```bash
make ps                                               # git-gateway should be "healthy"
make smoke                                            # /ops/info: skills, sandbox, mcp, git_gateway
source .env && H="Authorization: Bearer $HQ_API_TOKEN"
curl -s -H "$H" https://$HQ_DOMAIN/api/ops/git    | python3 -m json.tool   # token_configured: ["github.com"]
curl -s -H "$H" https://$HQ_DOMAIN/api/ops/skills | python3 -m json.tool   # 3 built-in skills at v1
curl -s -H "$H" https://$HQ_DOMAIN/api/ops/mcp    | python3 -m json.tool   # github: loaded or waiting_for_env
curl -s -H "$H" https://$HQ_DOMAIN/api/ops/sandboxes | python3 -m json.tool   # reaper running: true
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile     # the Phase 0 follow-up
```

Once your model provider is set up, the real end-to-end test is to ask HQ to clone one of your allowlisted repos, make a small change, and push it. Then `curl -s -H "$H" https://$HQ_DOMAIN/api/ops/git/audit` shows the fetch and the push, and the branch appears on GitHub as `hq/...`.

## 5. SSH hardening (the other Phase 0 follow-up)

Keep your current SSH session open the whole time.

```bash
# On Ubuntu, sshd uses the FIRST value it reads, and cloud images ship
# /etc/ssh/sshd_config.d/50-cloud-init.conf with "PasswordAuthentication yes".
# So this file must sort before it, hence the 00- prefix.
sudo tee /etc/ssh/sshd_config.d/00-hq-hardening.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '
```

All three should say `no`. Then, from a **second** terminal on your PC, confirm `ssh hq` still gets in before closing the first one.

## Home machine (when you're ready)

Sandboxes on the home machine reach the gateway over Tailscale. In the VPS `.env`:

```
GIT_GATEWAY_BIND=<VPS Tailscale IP>
GIT_GATEWAY_URL_OVERRIDES=tcp://<home Tailscale IP>:2375=http://<VPS Tailscale IP>:8081
SANDBOX_IDLE_STOP_OVERRIDES=tcp://<home Tailscale IP>:2375=180    # optional: longer idle time at home
```

Then run `make up` again.

## Rolling back

```bash
cd ~/hq && docker compose down
git checkout 39db2dc                                      # the Phase 0 upload (nested layout)
cp -a ~/phase0-backup/.env ~/phase0-backup/data deepagent-hq/
cd deepagent-hq && make up
```
