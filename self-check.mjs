// self-check.mjs — assert-based self-check for github-app-auth.mjs. No network.
// Run: node self-check.mjs  (exit 0 = all green)
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mod = await import("./github-app-auth.mjs");
const { buildJwt, loadPrivateKey, mintInstallationToken, loadConfig, gitRemoteOwner, createTokenProvider, applyBotIdentity } = mod;

const NOW = 1_750_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const pubPem = publicKey.export({ type: "spki", format: "pem" });

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

function mockFetch(responses) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const r = typeof responses === "function" ? responses(url, opts, calls.length - 1) : responses;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body ?? "",
    };
  };
  return { calls, impl };
}

// --- config dir fixtures ---
const cfgDir = mkdtempSync(join(tmpdir(), "ripmav-bot-cfg-"));
writeFileSync(join(cfgDir, "app.id"), "123\n");
writeFileSync(join(cfgDir, "app.pem"), pem);
writeFileSync(join(cfgDir, "app.foo.installation.id"), "111\n");
writeFileSync(join(cfgDir, "app.Bar.installation.id"), "222\n");
writeFileSync(join(cfgDir, "app.client.id"), "Iv1.x\n"); // must be ignored

function makeRepo(dir, remote) {
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
}
const repoFoo = mkdtempSync(join(tmpdir(), "ripmav-bot-repo-foo-"));
makeRepo(repoFoo, "https://github.com/Foo/x.git");
const repoBar = mkdtempSync(join(tmpdir(), "ripmav-bot-repo-bar-"));
makeRepo(repoBar, "git@github.com:Bar/y.git");
const noGit = mkdtempSync(join(tmpdir(), "ripmav-bot-nogit-"));

// --- JWT / key / mint (unchanged behavior) ---
await check("jwt: header, claims, 9-minute lifetime", () => {
  const jwt = buildJwt({ appId: 123, privateKeyPem: pem, now: NOW });
  const [h, p, s] = jwt.split(".");
  assert.ok(s, "signature present");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(header.alg, "RS256");
  assert.equal(header.typ, "JWT");
  assert.equal(payload.iss, 123);
  const iat = Math.floor(NOW / 1000) - 60;
  assert.equal(payload.iat, iat);
  assert.equal(payload.exp, iat + 540);
});

await check("jwt: signature verifies, tampered payload fails", () => {
  const jwt = buildJwt({ appId: 123, privateKeyPem: pem, now: NOW });
  const [h, p, s] = jwt.split(".");
  const sig = Buffer.from(s, "base64url");
  assert.equal(verify("sha256", Buffer.from(`${h}.${p}`), pubPem, sig), true);
  assert.equal(verify("sha256", Buffer.from(`${h}.${p}x`), pubPem, sig), false);
});

await check("loadPrivateKey: path, inline PEM, bad path throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "ripmav-bot-"));
  const file = join(dir, "app.pem");
  writeFileSync(file, "INLINE_PEM_CONTENT");
  assert.equal(loadPrivateKey(file), "INLINE_PEM_CONTENT");
  assert.equal(loadPrivateKey("-----BEGIN FAKE-----\nabc"), "-----BEGIN FAKE-----\nabc");
  assert.throws(() => loadPrivateKey("/does/not/exist/app.pem"), /does not exist/);
  assert.throws(() => loadPrivateKey("  "), /empty/);
});

await check("mint: posts JWT to installations endpoint, parses response", async () => {
  const iso = new Date(NOW + 3_600_000).toISOString();
  const { calls, impl } = mockFetch({ status: 201, body: JSON.stringify({ token: "ghs_test1234", expires_at: iso }) });
  const out = await mintInstallationToken({ appId: 123, privateKeyPem: pem, installationId: 456, fetchImpl: impl, now: NOW });
  assert.equal(out.token, "ghs_test1234");
  assert.equal(out.expiresAtMs, NOW + 3_600_000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/app/installations/456/access_tokens");
  assert.match(calls[0].opts.headers.Authorization, /^Bearer \S+\.\S+\.\S+$/);
  assert.equal(calls[0].opts.headers.Accept, "application/vnd.github+json");
});

await check("mint: non-2xx throws with status", async () => {
  const { impl } = mockFetch({ status: 401, body: "Bad credentials" });
  await assert.rejects(
    mintInstallationToken({ appId: 123, privateKeyPem: pem, installationId: 456, fetchImpl: impl, now: NOW }),
    /401/,
  );
});

// --- config discovery ---
await check("loadConfig: app.id, pem, installations lowercased + sorted, ignores other files", () => {
  const cfg = loadConfig(cfgDir);
  assert.equal(cfg.appId, "123");
  assert.ok(cfg.privateKeyPem.includes("PRIVATE KEY"));
  assert.deepEqual(cfg.installations, [
    { owner: "bar", installationId: "222" },
    { owner: "foo", installationId: "111" },
  ]);
});

await check("loadConfig: missing file throws with path", () => {
  const d2 = mkdtempSync(join(tmpdir(), "ripmav-bot-cfg2-"));
  assert.throws(() => loadConfig(d2), /app\.id/);
});

await check("loadConfig: bot identity from app.bot.name + app.bot.user.id", () => {
  const d = mkdtempSync(join(tmpdir(), "ripmav-bot-bot-"));
  writeFileSync(join(d, "app.id"), "123\n");
  writeFileSync(join(d, "app.pem"), pem);
  writeFileSync(join(d, "app.foo.installation.id"), "111\n");
  writeFileSync(join(d, "app.bot.name"), "my-bot\n");
  writeFileSync(join(d, "app.bot.user.id"), "424242\n");
  assert.deepEqual(loadConfig(d).bot, { name: "my-bot[bot]", email: "424242+my-bot[bot]@users.noreply.github.com" });
  writeFileSync(join(d, "app.bot.name"), "my-bot[bot]\n"); // explicit suffix is not doubled
  assert.equal(loadConfig(d).bot.name, "my-bot[bot]");
});

await check("loadConfig: missing or partial bot files -> no bot identity, not fatal", () => {
  const d = mkdtempSync(join(tmpdir(), "ripmav-bot-nobot-"));
  writeFileSync(join(d, "app.id"), "123\n");
  writeFileSync(join(d, "app.pem"), pem);
  writeFileSync(join(d, "app.foo.installation.id"), "111\n");
  assert.equal(loadConfig(d).bot, undefined); // nothing configured
  writeFileSync(join(d, "app.bot.name"), "my-bot\n");
  assert.equal(loadConfig(d).bot, undefined); // name only
  writeFileSync(join(d, "app.bot.user.id"), "not-a-number\n");
  assert.equal(loadConfig(d).bot, undefined); // invalid user id
  assert.equal(loadConfig(d).appId, "123"); // core config still loads
});

// --- repo owner resolution ---
await check("gitRemoteOwner: https + ssh remotes, non-repo null", () => {
  assert.equal(gitRemoteOwner(repoFoo), "foo");
  assert.equal(gitRemoteOwner(repoBar), "bar"); // git@github.com:Bar/y.git
  assert.equal(gitRemoteOwner(noGit), null);
});

// --- bot identity env ---
const BOT = { name: "ripmav-bot[bot]", email: "353694380+ripmav-bot[bot]@users.noreply.github.com" };

await check("applyBotIdentity: sets bot identity when matched + configured, clears otherwise", () => {
  const env = {};
  applyBotIdentity(env, { owner: "ripmav", installationId: "1", matched: true }, BOT);
  assert.equal(env.GIT_AUTHOR_NAME, "ripmav-bot[bot]");
  assert.equal(env.GIT_AUTHOR_EMAIL, "353694380+ripmav-bot[bot]@users.noreply.github.com");
  assert.equal(env.GIT_COMMITTER_NAME, "ripmav-bot[bot]");
  assert.equal(env.GIT_COMMITTER_EMAIL, "353694380+ripmav-bot[bot]@users.noreply.github.com");
  applyBotIdentity(env, { owner: "ripmav", installationId: "1", matched: false }, BOT);
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    assert.equal(env[k], undefined);
  }
  applyBotIdentity(env, null, BOT); // no selection -> stays cleared
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    assert.equal(env[k], undefined);
  }
  applyBotIdentity(env, { owner: "ripmav", installationId: "1", matched: true }, undefined); // matched but no bot configured
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
    assert.equal(env[k], undefined);
  }
});

await check("applyBotIdentity: real git commit is authored + committed by the bot", () => {
  const dir = mkdtempSync(join(tmpdir(), "ripmav-bot-commit-"));
  execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
  writeFileSync(join(dir, "f.txt"), "x");
  const env = { ...process.env };
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete env[k];
  applyBotIdentity(env, { owner: "ripmav", installationId: "1", matched: true }, BOT);
  execFileSync("git", ["add", "."], { cwd: dir, env, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "test"], { cwd: dir, env, stdio: "ignore" });
  const id = execFileSync("git", ["log", "-1", "--format=%an <%ae> | %cn <%ce>"], { cwd: dir, env, encoding: "utf8" }).trim();
  assert.equal(id, "ripmav-bot[bot] <353694380+ripmav-bot[bot]@users.noreply.github.com> | ripmav-bot[bot] <353694380+ripmav-bot[bot]@users.noreply.github.com>");
});

// --- multi-installation provider ---
let t2 = NOW;
const clock2 = () => t2;
const { calls, impl } = mockFetch((url) => ({
  status: 201,
  body: JSON.stringify({ token: `ghs_tok${url.match(/\/(\d+)\/access_tokens/)[1]}`, expires_at: new Date(NOW + 3_600_000).toISOString() }),
}));
const cfg = loadConfig(cfgDir);
const prov = createTokenProvider({ config: cfg, fetchImpl: impl, now: clock2 });

await check("provider: picks installation by repo owner, caches per installation, fallback first", async () => {
  const a = await prov.ensureFor({ cwd: repoFoo });
  assert.equal(a.installationId, "111");
  assert.equal(a.owner, "foo");
  assert.equal(a.matched, true);
  assert.equal(a.token, "ghs_tok111");
  await prov.ensureFor({ cwd: repoFoo }); // cached
  assert.equal(calls.length, 1);
  const b = await prov.ensureFor({ cwd: repoBar });
  assert.equal(b.installationId, "222");
  assert.equal(b.token, "ghs_tok222");
  assert.equal(calls.length, 2);
  const c = await prov.ensureFor({ cwd: noGit }); // fallback = alphabetically first (bar)
  assert.equal(c.installationId, "222");
  assert.equal(c.matched, false);
  assert.equal(calls.length, 2); // cached, no new mint
});

await check("provider: re-mints near expiry, force bypasses", async () => {
  const n0 = calls.length;
  t2 = NOW + 55 * 60_000;
  await prov.ensureFor({ cwd: repoFoo });
  assert.equal(calls.length, n0 + 1);
  t2 = NOW + 55 * 60_000 + 1_000;
  await prov.ensureFor({ cwd: repoFoo, force: true });
  assert.equal(calls.length, n0 + 2);
});

await check("provider: statusFor shows active selection + all installations, masked", async () => {
  const s = prov.statusFor(repoFoo);
  assert.match(s, /active: foo \(111\)/);
  assert.match(s, /bar 222/);
  assert.match(s, /foo 111/);
  assert.doesNotMatch(s, /ghs_tok111/);
  assert.match(s, /ghs_…k111/);
  assert.match(prov.statusFor(noGit), /fallback/);
});

// --- extension wiring: tool_call hook re-checks the token before each bash call ---
// The extension binds `fetch` and the config dir at factory time, so swap both
// before loading it. The mock pins expires_at to (past) NOW, so the margin check
// sees every minted token as expired and re-mints on every bash call.
let extFactory;
try {
  extFactory = (await import("./github-app.ts")).default;
} catch (e) {
  console.log(`skip - extension wiring not loadable on this Node: ${String(e?.message ?? e).slice(0, 80)}`);
}
if (typeof extFactory === "function") {
  const extCfg = mkdtempSync(join(tmpdir(), "ripmav-bot-ext-"));
  writeFileSync(join(extCfg, "app.id"), "123\n");
  writeFileSync(join(extCfg, "app.pem"), pem);
  writeFileSync(join(extCfg, "app.foo.installation.id"), "111\n");
  let mintOk = true;
  const extFetch = mockFetch((url, opts, idx) => mintOk
    ? { status: 201, body: JSON.stringify({ token: `ghs_ext${idx + 1}`, expires_at: new Date(NOW + 3_600_000).toISOString() }) }
    : { status: 401, body: "Bad credentials" });
  const prevFetch = globalThis.fetch;
  const prevCfgEnv = process.env.RIPMAVBOT_CONFIG_DIR;
  globalThis.fetch = extFetch.impl;
  process.env.RIPMAVBOT_CONFIG_DIR = extCfg;
  try {
    const handlers = {};
    const commands = {};
    extFactory({
      on: (type, handler) => (handlers[type] = handler),
      registerCommand: (name, spec) => (commands[name] = spec),
    });
    await check("extension: registers session_start, before_agent_start, tool_call, /ghapp", () => {
      for (const t of ["session_start", "before_agent_start", "tool_call"]) assert.ok(typeof handlers[t] === "function", `missing ${t} handler`);
      assert.ok(commands.ghapp);
    });
    await check("extension: bash tool call verifies + refreshes token, non-bash skips", async () => {
      const statuses = [];
      const notes = [];
      const ctx = { ui: { setStatus: (k, s) => statuses.push(s), notify: (m, t) => notes.push([m, t]) } };
      await handlers.tool_call({ toolCallId: "1", toolName: "read", input: { path: "x" } }, ctx);
      assert.equal(extFetch.calls.length, 0, "non-bash tool call must not touch the token");
      await handlers.tool_call({ toolCallId: "2", toolName: "bash", input: { command: "echo one" } }, ctx);
      assert.equal(extFetch.calls.length, 1, "bash tool call mints");
      assert.equal(process.env.GH_TOKEN, "ghs_ext1");
      assert.equal(process.env.GITHUB_TOKEN, "ghs_ext1");
      await handlers.tool_call({ toolCallId: "3", toolName: "bash", input: { command: "echo two" } }, ctx);
      assert.equal(extFetch.calls.length, 2, "expired cached token is re-minted before the next bash call");
      assert.match(statuses.at(-1), /token expired → refreshed \(foo\)/, "expiry recovery shows in the status line");
      assert.ok(notes.some(([m, t]) => t === "error" && /expired → refreshed/.test(m)), "expiry recovery is notified as an error");
    });

    await check("extension: failed refresh of an expired token shows EXPIRED, keeps old token (fail-open)", async () => {
      const statuses = [];
      const notes = [];
      const ctx = { ui: { setStatus: (k, s) => statuses.push(s), notify: (m, t) => notes.push([m, t]) } };
      const before = process.env.GH_TOKEN;
      mintOk = false;
      await handlers.tool_call({ toolCallId: "4", toolName: "bash", input: { command: "echo three" } }, ctx);
      assert.match(statuses.at(-1), /token EXPIRED/, "expired token + failed refresh is visible in the status line");
      assert.ok(notes.some(([m, t]) => t === "error" && /token EXPIRED/.test(m)), "failure is notified as an error");
      assert.equal(process.env.GH_TOKEN, before, "fail-open: old token stays in env");
    });
    await check("extension: idle timer keeps the status line current between turns", async () => {
      const future = new Date(Date.now() + 55 * 60_000).toISOString();
      const timerFetch = mockFetch({ status: 201, body: JSON.stringify({ token: "ghs_timer1", expires_at: future }) });
      const realSetInterval = globalThis.setInterval;
      let tick = undefined;
      globalThis.setInterval = (fn) => { tick = fn; return realSetInterval(() => {}, 2147483647); };
      const statuses = [];
      const ctx = { ui: { setStatus: (k, s) => statuses.push(s), notify: () => {} } };
      try {
        globalThis.fetch = timerFetch.impl;
        const handlers2 = {};
        extFactory({ on: (t, h) => (handlers2[t] = h), registerCommand: () => {} });
        await handlers2.session_start(undefined, ctx);
        assert.match(statuses.at(-1), /token refreshed \(foo\) · 55 min left/, "first mint reports refreshed");
        assert.ok(typeof tick === "function", "idle status timer registered on session start");
        assert.equal(timerFetch.calls.length, 1, "session start mints once");
        tick(); // simulate an idle minute without any agent activity
        assert.match(statuses.at(-1), /token ready \(foo\) · 55 min left/, "idle tick re-renders the countdown");
        assert.equal(timerFetch.calls.length, 1, "idle tick is display-only, never mints");
        // same wiring with an already-expired token: tick must show EXPIRED
        const staleFetch = mockFetch({ status: 201, body: JSON.stringify({ token: "ghs_stale1", expires_at: new Date(NOW + 3_600_000).toISOString() }) });
        globalThis.fetch = staleFetch.impl;
        const statuses2 = [];
        const ctx2 = { ui: { setStatus: (k, s) => statuses2.push(s), notify: () => {} } };
        const handlers3 = {};
        extFactory({ on: (t, h) => (handlers3[t] = h), registerCommand: () => {} });
        await handlers3.session_start(undefined, ctx2);
        tick(); // captured from the third instance now
        assert.match(statuses2.at(-1), /token EXPIRED \(foo\) — will refresh on next run/);
      } finally {
        globalThis.fetch = prevFetch;
        globalThis.setInterval = realSetInterval;
      }
    });
  } finally {
    globalThis.fetch = prevFetch;
    if (prevCfgEnv === undefined) delete process.env.RIPMAVBOT_CONFIG_DIR;
    else process.env.RIPMAVBOT_CONFIG_DIR = prevCfgEnv;
  }
}

console.log(`self-check: ${passed} passed`);
