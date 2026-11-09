# GitHub-App `ripmav-bot` — Setup & Agent-Authentifizierung

Ziel: AI-Agents arbeiten in ausgesuchten GitHub-Repos — ohne persönliche Credentials.
Die App ist nur auf den installierten Repos wirksam, vollständig revocierbar und auditierbar.

## Architektur

GitHub-App → **Installation** auf den ausgewählten Repos → der Agent mintet daraus
stündlich frische **Installation-Token** (`ghs_...`) und nutzt sie wie `GH_TOKEN`.
Der Agent bekommt nie deine persönliche Identität — nur die Rechte der App,
nur auf den installierten Repos.

## 1. App anlegen (einmalig)

`github.com → dein Profil → Settings → Developer settings → GitHub Apps → New GitHub App`

- **Name:** `ripmav-bot`
- **Callback URL:** nicht nötig (kein OAuth — Server-to-Server)
- **Repository permissions** (minimal, für einen Agenten der Code schreibt):
  - `Metadata` — Pflicht, wird automatisch gesetzt
  - `Contents` — Read & write
  - `Pull requests` — Read & write
  - `Issues` — Read & write (falls gewollt)
  - `Checks` — Read (falls der Agent CI-Status abfragen soll)
- **Events/Webhooks:** leer lassen, nicht nötig.

Danach: **Settings → Private keys → Generate private key** (GitHub generiert das PEM).
Lokal speichern, z. B. `~/.config/ripmav-bot/app.pem` mit `chmod 600`. **Niemals committen.**

Notieren von der App-Seite:

| Wert | Wo finden |
|---|---|
| **App ID** (Zahl) | App-Settings, oben auf der Seite |
| **Installation ID** (Zahl) | nach dem Installieren, auf der Installation-Seite |
| **Private Key** (PEM) | Settings → Private keys |

## 2. Auf ausgesuchte Repos installieren

App-Seite → **Set up app → Your account → Only select repositories** → Repos haken.
Jede Auswahl definiert den maximalen Scope, den Agenten später bekommen.
Neue Repos jederzeit nachinstallierbar (Installation → Configure).

## 3. Authentifizierung des Agents (Server-to-Server)

Zwei Schritte, die der Agent selbst erledigen kann:

1. **JWT** mit dem Private Key signieren (RS256):
   `iss` = App ID, `iat` = jetzt − 60s, `exp` ≤ jetzt + 10 min.
2. `POST /app/installations/{installation_id}/access_tokens` mit dem JWT
   → liefert ein Token, **1 h gültig**.

### Mint-Script (Node, minimal)

```js
// mint.mjs
import { App } from "@octokit/app";

const app = new App({
  appId: Number(process.env.RIPMAVBOT_APP_ID),
  privateKey: process.env.RIPMAVBOT_PRIVATE_KEY, // PEM-Inhalt
  installationId: Number(process.env.RIPMAVBOT_INSTALLATION_ID),
});

console.log((await app.getInstallationAccessToken()).token); // ghs_...
```

Python-Alternative: `InstallationAuth(app_id, app_private_key, installation_id)` in `PyGithub`.

### Einbindung in den Agenten

Runtime-agnostisch (pi, opencode, Claude Code & Co.):

```bash
export GH_TOKEN="$(node mint.mjs)"        # gh-CLI + API-Calls des Agents
# Git direkt über HTTPS:
git clone https://x-access-token:${GH_TOKEN}@github.com/ripmav/<repo>.git
```

### Betrieb

- **Caching:** Token 1 h gültig — bei ~50 min neu minten reicht.
- **Rate Limit:** 5000 Requests/h pro Installation → Token wiederverwenden,
  nie pro Request neu minten.

## Option: Pi-Extension (Token automatisch)

Statt `GH_TOKEN` manuell zu setzen, hält eine Pi-Extension das Token vor jedem
Agent-Lauf frisch. Sie liegt in diesem Repo und wird als lokales Pi-Package
installiert:

- `github-app-auth.mjs` — JWT-Mint, Token-Exchange, Cache, Config-Entdeckung (Zero-Dep, nur Node-Builtin)
- `github-app.ts` — Extension: wählt pro Lauf die richtige Installation, prüft das
  Token vor jedem Agent-Lauf und jedem bash-Aufruf auf Ablauf und setzt `GH_TOKEN`/`GITHUB_TOKEN`
- `self-check.mjs` — Selbsttest: `node self-check.mjs`

Config-Verzeichnis (Default `~/.config/ripmav-bot`, Override: `RIPMAVBOT_CONFIG_DIR`):

```text
app.id                       App ID (Zahl)
app.pem                      Private Key (PEM, chmod 600)
app.<owner>.installation.id  eine Datei pro installiertem Account, Inhalt: Installation ID (Zahl)
```

Zwei Accounts = zwei Dateien, z. B. `app.ripmav.installation.id` und
`app.sburmester.installation.id`. `app.client.id` wird ignoriert.

Installation:

```bash
pi install /home/ripmav/projects/ripmav-bot
```

lädt das Repo als lokales Package ohne Kopie (entfernen: `pi remove`,
übersicht: `pi list`). Bestehende Sessions: `/reload` oder Pi neu starten.

Verhalten:

- **Installation-Auswahl:** Die Extension liest das `origin`-Remote des aktuellen
  Repos und nimmt die Installation des passenden Owners (https- und
  ssh-Formate, case-insensitiv). Kein Repo / kein Match → erste Installation
  (alphabetisch), im Status als `fallback` markiert.
- **Ohne Config:** still (einmalige Warnung bei Start); `/ghapp` erklärt den Zustand.
- **Mit Config:** meldet sich einmal pro Session; die Statuszeile zeigt immer
  `token ready (owner) · N min left`, nach einem Refresh `token refreshed` und bei
  erkannten Ablauf `token expired → refreshed` (jeweils mit Benachrichtigung).
  Schlägt der Refresh fehl, zeigt die Statuszeile `token EXPIRED` bzw.
  `token refresh failed` mit Fehler als Warnung. Token gilt 1 h, wird vor jedem
  Agent-Lauf und jedem bash-Aufruf geprüft und bei Ablauf oder < 10 min Restlaufzeit
  neu gemintet — auch in langen Turns läuft kein bash-Call mit abgelaufenem Token.
  Im Leerlauf zieht die Statuszeile pro Minute nach (nur Anzeige; geprüft und
  gemintet wird bei jedem Lauf).
- **`/ghapp`** — aktive Auswahl + Status aller Installationen (Token maskiert,
  nur letzte 4 Zeichen); **`/ghapp refresh`** — frisches Token für die aktive Auswahl erzwingen.
- **Commit-Identität:** In Repos des aktiven Accounts (matched) setzt die Extension
  Author und Committer auf `ripmav-bot[bot]` / `353694380+ripmav-bot[bot]@users.noreply.github.com`
  (per `GIT_AUTHOR_*`/`GIT_COMMITTER_*`-Env, keine Config-Dateien). In anderen Repos
  oder ohne Bot-Token bleibt deine eigene Git-Identität unangetastet.
  Override für Einzelcommits: `git commit --author="Name <email>"`.
  (Verified-Signaturen sind für `[bot]`-Accounts platformseitig nicht möglich —
  Schlüssel lassen sich dort nicht registrieren.)
- **Fail-open:** Token-Fehler blockieren Agent-Läufe nie; sie landen als Warnung.

## Stolpersteine

- **Branch-Protection:** Gilt auch für App-Tokens. Will der Agent auf `main`
  pushen, muss `ripmav-bot` in „Allowed to push" stehen — besser: Agenten
  pushen nur Feature-Branches und öffnen PRs.
- **Secret-Hygiene:** PEM + IDs nur in Env/Secret-Manager, nie im Repo
  oder in Agent-Prompts.
- **Rechte-Minimum:** Jede Permission, die die App hat, kann jeder Agent
  nutzen, der das PEM sieht.

## Checkliste

- [ ] App `ripmav-bot` angelegt, Permissions gesetzt
- [ ] Private Key generiert, lokal gesichert (`chmod 600`), nicht committet
- [ ] App auf den Ziel-Repos installiert
- [ ] App ID + Installation ID notiert
- [ ] Token-Mint funktioniert (Extension: `node self-check.mjs` grün + `/ghapp` zeigt `token ready`; manuell: `mint.mjs` liefert `ghs_...`)
- [ ] Agent mit `GH_TOKEN` kann klonen, pushen, PRs öffnen
- [ ] (optional) `ripmav-bot` in Branch-Protection „Allowed to push"
