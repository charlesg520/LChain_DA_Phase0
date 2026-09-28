---
name: git-workflow
description: Branching, commit and pull-request conventions for work in /workspace repos. Use whenever you clone, branch, commit or prepare a change for review.
---

# Git workflow

- **Clone** into `/workspace/<repo-name>`. If it already exists, `git fetch` and check `git status` before doing anything.
- **Branch** from an up-to-date default branch: `git switch -c hq/<short-kebab-description>`. Never commit directly to `main`/`master`.
- **Commit** in logical steps. Message format: imperative subject under 72 chars, blank line, then why the change was needed. One concern per commit.
- **Never** force-push, rewrite published history, or commit secrets. Check `git diff --staged` before each commit; `.env`, keys, tokens and credentials must never be staged.
- **Before handing off:** run the tests, then `git log --oneline <base>..HEAD` and `git diff --stat <base>...HEAD` so the report can list exactly what changed.
- **Pushing** requires credentials C has configured for that repo. If a push fails for auth reasons, stop and report; don't try to work around it.
