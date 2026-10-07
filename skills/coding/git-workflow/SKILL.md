---
name: git-workflow
description: Cloning, branching, committing and pushing in /workspace repos through HQ's git gateway. Use whenever you clone, branch, commit, push or prepare a change for review.
---

# Git workflow

HQ's sandboxes reach GitHub through a gateway that holds the credentials. You never see or need a token, and you should never ask for one.

- **Clone** with the normal URL: `git clone https://github.com/<owner>/<repo>.git /workspace/<repo>`. SSH-style URLs (`git@github.com:...`) work too. If the repo already exists, `git fetch` and check `git status` before doing anything.
- **Branch** from an up-to-date default branch: `git switch -c hq/<short-kebab-description>`. Only `hq/*` branches can be pushed. Never commit directly to `main`/`master`.
- **Commit** in logical steps. Message format: imperative subject under 72 chars, blank line, then why the change was needed. One concern per commit. Your commits are authored as "HQ Agent" automatically.
- **Never** force-push, rewrite published history, or commit secrets. Check `git diff --staged` before each commit; `.env`, keys, tokens and credentials must never be staged.
- **Push before you're done:** `git push -u origin hq/<branch>`. A task with unpushed commits isn't finished. If there's a real reason not to push, say so explicitly in your report.
- **Before handing off:** run the tests, then `git log --oneline <base>..HEAD` and `git diff --stat <base>...HEAD` so the report lists exactly what changed. Include the repo and branch name, and the compare link `https://github.com/<owner>/<repo>/compare/<base>...hq/<branch>`.
- **Pull requests:** if GitHub tools are available (e.g. `github_create_pull_request`), open a PR from the pushed branch. Otherwise the compare link is enough; C opens it.

## When the gateway refuses

The error text says why. Don't work around it; report it.

- `HQ only pushes branches under hq/` means you tried to push `main` or another non-`hq/` ref. Push an `hq/` branch instead.
- `pushes to <owner>/<repo> are not allowed` means C hasn't allowlisted that repo. Tell C which repo you need.
- `<repo> is private or doesn't exist, and it's not in GIT_GATEWAY_ALLOWED_REPOS` means check the URL, or ask C to allowlist it.
- `GitHub rejected the gateway token` means the token expired or lacks access. Tell C.
