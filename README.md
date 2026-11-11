# GitHub App auth for Pi coding agents

A zero-dependency [Pi](https://pi.dev) extension that gives coding agents a fresh
GitHub App installation token (`GH_TOKEN` / `GITHUB_TOKEN`) for every run — no
personal credentials, scoped to the repos the App is installed on, fully revocable.

## How it works

1. The extension signs a GitHub App **JWT** (RS256, 9 min lifetime, backdated 60 s
   for clock skew) with your App's private key.
2. It exchanges the JWT for a short-lived **installation access token** (1 h).
3. Tokens are cached per installation and **re-minted before expiry** (10 min
   margin). The expiry is checked before every agent turn *and* right before every
   bash call, so a long turn can never consume a token that expired mid-turn.

The active installation is picked from the current repo's `origin` remote owner
(https or ssh, case-insensitive); without a match the first installation
(alphabetical) is used and marked `fallback` in the status.

## Token status in the TUI

| Situation | Status line | Notification |
|---|---|---|
| Token valid | `token ready (owner) · N min left` | session start only |
| Routine pre-expiry refresh | `token refreshed (owner) · N min left` | — |
| Token expired → re-minted | `token expired → refreshed (owner) · N min left` | warning |
| Refresh failed, token expired | `token EXPIRED — <error>` | warning |

The status line also ticks down every minute while the session is idle
(display only — checking and minting happen on every run).

## Commit identity

In repos that match the active installation, commits are authored and committed as
the App's bot identity — `<bot-login>[bot]` with the noreply address
`<user_id>+<bot-login>[bot]@users.noreply.github.com` — via `GIT_AUTHOR_*` /
`GIT_COMMITTER_*` env vars (no git config files touched). The identity comes from
`app.bot.name` + `app.bot.user.id` in the config dir; without both, your own git
identity is used. Override a single commit
with `git commit --author="Name <email>"`.

Verified commit signatures are not possible for `[bot]` accounts — GitHub does not
allow registering signing keys on them.

## Requirements

- A GitHub App (create one under *Profile → Settings → Developer settings →
  GitHub Apps*) with at least `Contents: read/write`, installed on the repos the
  agent may use. Note the **App ID**, generate a **private key** (PEM), and collect
  one **installation ID** per account/org.
- [Pi](https://pi.dev).
- Node.js ≥ 23 for the full self-check (older Node runs it with the
  extension-wiring checks skipped).

## Install

From npm (published as [`ripmav-bot`](https://www.npmjs.com/package/ripmav-bot)):

```bash
pi install npm:ripmav-bot
```

Or from a clone (development, latest `main`):

```bash
pi install /path/to/pi-github-bot-ext
```

Local installs load the repo in place — no copy (remove with `pi remove`, list
with `pi list`, update with `pi update --extensions`).
Existing sessions: `/reload` or restart Pi.

## Configure

Config dir: `~/.config/ripmav-bot` (override: `RIPMAVBOT_CONFIG_DIR`):

```text
app.id                       App ID (number)
app.pem                      App private key (PEM, chmod 600)
app.<owner>.installation.id  one file per installed account, content: installation ID
app.bot.name                 optional: App login for commit identity ("[bot]" is appended)
app.bot.user.id              optional: numeric user ID of the bot (noreply email)
```

Two accounts = two files, e.g. `app.<account-1>.installation.id` and
`app.<account-2>.installation.id`. Other files (e.g. `app.client.id`) are ignored.

## Commands

- `/ghapp` — active selection + status of all installations (token masked, last 4 chars only)
- `/ghapp refresh` — force a new token for the active installation

## Bundled skill

The package ships the `github-bot-token` skill (`skills/github-bot-token/`): a
runtime contract that keeps every GitHub communication in covered repos — gh
CLI, git, API — on the bot's installation token instead of a personal one,
including identity verification and the fail-closed behavior when the App is
not installed on the current repo. Pi loads it automatically with the package;
force it with `/skill:github-bot-token`.

## Fail-open

Token problems never block an agent run: a failed mint leaves the previous token
in place, is reported as a warning, and is retried automatically on the next turn
or bash call.

## Security

- Store the PEM and IDs only locally or in a secret manager — never in the repo,
  never in agent prompts.
- Anyone who can read the PEM can mint tokens for every installed repo: keep the
  App's permissions minimal and its repo list short.
- Branch protection applies to App tokens too — allow the bot explicitly where you
  want it to push, or have agents push feature branches and open PRs.

## Self-check

```bash
node self-check.mjs   # 17 checks, no network
```

## License

[MIT](./LICENSE)
