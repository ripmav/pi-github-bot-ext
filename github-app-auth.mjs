// github-app-auth.mjs — zero-dependency core for the ripmav-bot GitHub App extension.
// Mints GitHub App installation tokens (RS256 JWT -> short-lived access token) with
// per-installation caching, and picks the installation by the current repo's owner.
//
// Config dir (default ~/.config/ripmav-bot, override via RIPMAVBOT_CONFIG_DIR):
//   app.id                       GitHub App numeric ID
//   app.pem                      App private key (PEM)
//   app.<owner>.installation.id  one file per installed account
//
// Security: never logs the private key or the full token; status output is masked.

import { createSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Re-mint when less than this much lifetime is left (token lifetime is 1 h).
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// GitHub App JWT (RS256). Lifetime 9 min: GitHub allows up to 10 min.
// iat is backdated 60 s to absorb clock skew (GitHub allows up to 60 s).
export function buildJwt({ appId, privateKeyPem, now = Date.now() }) {
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: Number(appId), iat, exp: iat + 540 }));
  const signature = createSign("sha256").update(`${header}.${payload}`).sign(privateKeyPem);
  return `${header}.${payload}.${b64url(signature)}`;
}

// Accepts a file path (optional leading "~") or inline PEM content.
export function loadPrivateKey(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("private key is empty");
  }
  let v = value.trim();
  if (v.startsWith("~")) v = homedir() + v.slice(1);
  if (v.includes("-----BEGIN")) return v; // inline PEM
  if (existsSync(v)) return readFileSync(v, "utf8");
  throw new Error(`private key path does not exist: ${v}`);
}

// Exchange the App JWT for an installation access token (1 h lifetime).
export async function mintInstallationToken({
  appId,
  privateKeyPem,
  installationId,
  baseUrl = "https://api.github.com",
  fetchImpl = fetch,
  now = Date.now,
}) {
  const jwt = buildJwt({ appId, privateKeyPem, now: typeof now === "function" ? now() : now });
  const res = await fetchImpl(`${baseUrl}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "ripmav-bot",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub App token mint failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text);
  if (!data.token) throw new Error("GitHub App token mint: no token in response");
  return { token: data.token, expiresAtMs: Date.parse(data.expires_at) };
}

// Read the config dir: app.id, app.pem, and all app.<owner>.installation.id files.
// Owners are lowercased; installations sorted by owner for a deterministic fallback.
export function loadConfig(configDir = join(homedir(), ".config", "ripmav-bot")) {
  const read = (name) => {
    const p = join(configDir, name);
    if (!existsSync(p)) throw new Error(`ripmav-bot config missing: ${p}`);
    return readFileSync(p, "utf8").trim();
  };
  const appId = read("app.id");
  const privateKeyPem = loadPrivateKey(read("app.pem"));
  const installations = [];
  for (const f of readdirSync(configDir)) {
    const m = f.match(/^app\.(.+)\.installation\.id$/);
    if (!m) continue;
    installations.push({ owner: m[1].toLowerCase(), installationId: read(f) });
  }
  if (!installations.length) {
    throw new Error(`ripmav-bot config: no app.<owner>.installation.id files in ${configDir}`);
  }
  installations.sort((a, b) => a.owner.localeCompare(b.owner));
  return { configDir, appId, privateKeyPem, installations };
}

// Owner of the `origin` remote of the git repo in `cwd`, lowercased; null if
// not a git repo, no origin, non-github remote, or git fails (e.g. timeout).
export function gitRemoteOwner(cwd) {
  let url;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
  const m = url.match(/github\.com[:/]([A-Za-z0-9_.-]+)/);
  return m ? m[1].toLowerCase() : null;
}

// Pick the installation for a working directory: the one whose owner matches the
// repo's remote owner; otherwise the first (alphabetical) installation, matched: false.
export function pickInstallation(installations, cwd) {
  const owner = gitRemoteOwner(cwd);
  const match = owner && installations.find((i) => i.owner === owner);
  return match ? { ...match, matched: true } : { ...installations[0], matched: false };
}

// Bot identity for commit attribution: author + committer as the app bot.
// Email uses the documented noreply pattern <user_id>+<login>[bot]@… with the
// bot's user ID (353694380) — matches the repo-local git config already in use.
export const BOT_IDENTITY = {
  name: "ripmav-bot[bot]",
  email: "353694380+ripmav-bot[bot]@users.noreply.github.com",
};

const IDENTITY_ENV = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];

// Set the bot identity env vars only while a matched installation selection is
// active (the bot's token actually covers this repo); otherwise clear them so the
// user's own git identity is used. `selection` is the ensureFor() result or null.
export function applyBotIdentity(env, selection) {
  if (selection?.matched) {
    env.GIT_AUTHOR_NAME = BOT_IDENTITY.name;
    env.GIT_AUTHOR_EMAIL = BOT_IDENTITY.email;
    env.GIT_COMMITTER_NAME = BOT_IDENTITY.name;
    env.GIT_COMMITTER_EMAIL = BOT_IDENTITY.email;
  } else {
    for (const k of IDENTITY_ENV) delete env[k];
  }
}

// Caching token provider for a loaded config. Tokens are cached per installation.
export function createTokenProvider({ config, fetchImpl = fetch, now = () => Date.now() }) {
  const cache = new Map(); // installationId -> { token, expiresAtMs }

  async function ensureFor({ cwd, force = false } = {}) {
    const pick = pickInstallation(config.installations, cwd);
    const t = now();
    let entry = cache.get(pick.installationId);
    if (!force && entry && entry.expiresAtMs - t > REFRESH_MARGIN_MS) {
      return { ...entry, ...pick };
    }
    entry = await mintInstallationToken({
      appId: config.appId,
      privateKeyPem: config.privateKeyPem,
      installationId: pick.installationId,
      fetchImpl,
      now: t,
    });
    cache.set(pick.installationId, entry);
    return { ...entry, ...pick };
  }

  function statusFor(cwd) {
    const pick = pickInstallation(config.installations, cwd);
    const lines = [`active: ${pick.owner} (${pick.installationId})${pick.matched ? "" : " — fallback, no repo match"}`];
    for (const i of config.installations) {
      const e = cache.get(i.installationId);
      const state = e
        ? `token ghs_…${e.token.slice(-4)} (${Math.max(0, Math.round((e.expiresAtMs - now()) / 60_000))} min left)`
        : "no token yet";
      lines.push(`  ${i.owner} ${i.installationId}: ${state}`);
    }
    return lines.join("\n");
  }

  return { config, ensureFor, statusFor };
}
