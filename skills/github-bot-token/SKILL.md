---
name: github-bot-token
description: "Trigger: gh cli, gh auth, git push, git clone, git remote, github api, pull request, issue, release, workflow dispatch, bot token. Keep every GitHub communication (gh CLI, git, API) in ripmav-bot covered repos authenticated with the bot's GitHub App installation token, never a personal token."
license: MIT
metadata:
  author: Sebastian Burmester
  version: "1.0"
---

## Activation Contract

Activate before any GitHub-network communication in a session where ripmav-bot is active: `gh` commands (pr, issue, run, api, release, auth status), git operations that reach the network (clone, fetch, pull, push), and direct API calls.

Do not activate for: local-only git (status, log, diff, commit), repos the App is not installed on, or environments without the extension where the human explicitly handles auth.

## Hard Rules

- Authenticate every GitHub call with the bot's installation token — the `GH_TOKEN` / `GITHUB_TOKEN` the extension exports (prefix `ghs_`). Never fall back to a personal `gh auth` login or a personal token embedded in a remote URL.
- Reuse the cached token. Refresh only via `/ghapp refresh` or one explicit mint; never mint per request (5000 requests/h per installation).
- In matched repos, commit identity must be the bot's — `<bot-login>[bot]` with the noreply email (the extension sets `GIT_AUTHOR_*` / `GIT_COMMITTER_*`).
- Never print, commit, or paste the PEM, App ID, installation IDs, or full tokens. Mask tokens to their last 4 characters.

## Decision Gates

| Situation | Action |
| --- | --- |
| Status `token ready (owner) · N min left` | Use `GH_TOKEN` from the environment as-is |
| `token EXPIRED`, `refresh failed`, or < 10 min left | Run `/ghapp refresh` once, then continue |
| No config, or status shows `fallback` (repo owner not installed) | Stop and report: App not installed on this repo. Do not silently use a personal token |
| 403 / permission denied on a gh operation | Report as an App permission gap (e.g. missing `actions`); do not retry under a personal identity |
| Human explicitly says to use a personal token | The human's decision wins; state it in the output |

## Execution Steps

1. Check the active selection: `/ghapp` (or the TUI status line). Expect the right owner and `token ready`.
2. Before the first gh command, verify the identity: `gh api user --jq .login` must end in `[bot]`.
3. Git over HTTPS: use `https://x-access-token:${GH_TOKEN}@github.com/<owner>/<repo>.git`. If a remote URL embeds a personal token, report it and switch it to the bot token (or the ssh URL when one exists).
4. After pushing, verify commit identity: `git log -1 --format='%an <%ae>'` must show `<bot-login>[bot]` / `<user_id>+<bot-login>[bot]@users.noreply.github.com` (matched repos only).
5. If `gh auth status` shows a personal account, the environment token is missing or stale: run `/ghapp refresh` and retry once.

## Output Contract

- The identity actually used for each GitHub call (bot login, or personal only after explicit human instruction).
- Verification commands run and their results (`gh api user` login, commit identity line).
- Unresolved gaps: missing App permission, repo not installed, token failures.

## References

- `../../github-app-setup.md` — App setup, config files, minting details (ships with the package).
- `../../github-app-auth.mjs` — config schema, installation selection, refresh margin.
- `../../self-check.mjs` — `node self-check.mjs` for wiring checks without network.
