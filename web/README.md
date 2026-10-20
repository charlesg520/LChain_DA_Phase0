# HQ console

The web UI for HQ, plus the small Node server behind it.

```
pnpm install
pnpm start          # mock server on :3000 + Vite on http://localhost:5173 (no agent needed)
pnpm -r typecheck
pnpm --filter server test
pnpm build          # ui/dist, served by the server in production
```

`server` runs in one of two modes:

- **mock** (default): a scripted backend implementing the whole contract, with a demo run (plan, file reads, a sub-agent, an approval, a skill loading mid-run), a virtual file system with media, memory, skills, tools, MCP servers and history. `MOCK_SPEED=2` plays it twice as fast.
- **live** (`HQ_WEB_MODE=live`, or whenever `HQ_API_URL` is set): a bridge to HQ. The browser speaks the same contract; the server turns it into Agent Protocol runs on Aegra and `/ops` calls, holding `HQ_API_TOKEN` itself. This is what `compose.yaml` runs.

| Env | Default | |
|---|---|---|
| `PORT`, `HOST` | `3000`, `0.0.0.0` | |
| `WEB_TOKEN` | `HQ_API_TOKEN` in live, none in mock | browser sign-in token (16+ chars in live) |
| `HQ_API_URL`, `HQ_API_TOKEN` | `http://agent:8000` | live only |
| `WEB_DATA_DIR` | `server/data` | live: chat transcripts (incl. sub-agent messages) |
| `UI_DIST` | `ui/dist` | built UI to serve |

## Notes: choices the spec left open

- **Extensions are additive.** Everything the spec defines works as written; HQ adds optional fields and frames (`status`, `notice`, `memory-save`, `hello.mode/features/projects`, skill `category/enabled/version`, tool `agents/source/approval`, MCP `agents` and `http` transport, message `status/thinking`, task `partial`). A server that only speaks the base contract still drives the UI.
- **Header labels:** READY, LIVE, PAUSED, APPROVAL (waiting on you), STOPPED (the last run ended), OFFLINE, CONNECTING, NO ACCESS (bad token).
- **Pause / resume (live):** pause interrupts the run at the current step; resume continues from the last checkpoint, so a step that was cut off runs again.
- **Approvals (live):** approve, approve with edited arguments, or reject with a note (the agent receives the note as the tool result). An approval note on *approve* is shown in the UI but not sent to the agent.
- **Skills toggle (live):** clicking a skill card enables or disables it for every agent (disabled skills move out of `/skills` and back, with history). In mock mode it toggles loaded/idle as the spec describes.
- **MCP from the browser:** `stdio` servers execute inside the agent container, so live mode accepts them only with `HQ_ALLOW_STDIO_MCP=true`. Literal secrets in env/headers are masked when shown; `${VAR}` references are shown as written.
- **Sub-agent streams:** Aegra names each sub-agent's stream by its tool-call namespace, not by the `task` call id, so the bridge pairs them: a new namespace goes to the running task whose agent name matches, else the oldest unpaired one. With several sub-agents of the same type running in parallel, their inner messages could be attributed to each other; reports and results are always correct.
- **Parallel chats (live):** you can open other chats or start a new one while HQ works; a banner links back to any chat that's still working or waiting for approval. After a page reload you land in it automatically.
- **Recovery:** runs continue in HQ if the console restarts; on start it re-attaches to running chats and re-offers pending approvals from the last 14 days.
- **History** lists the newest 500 chats (Aegra pages by creation time).
- **Token counts** come from the provider's usage report; a provider that leaves `input_tokens` out of its stream end reports 0 in.
- **Media previews:** images, H.264 video, audio and PDF preview in the browser; anything else can be downloaded.
- **Settings** live in `localStorage["deepagent.settings"]` (host, ws path, token, accent); UI layout prefs are kept separately.
