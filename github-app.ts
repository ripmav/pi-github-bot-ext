// ripmav-bot Pi extension — keeps a fresh GitHub App installation token in
// GH_TOKEN / GITHUB_TOKEN (bash calls inherit process.env). The cached token is
// checked against its expiry before every agent turn and right before every
// bash call, and re-minted once it is expired or within the 10 min margin.
//
// Config dir (default ~/.config/ripmav-bot, override: RIPMAVBOT_CONFIG_DIR):
//   app.id                       GitHub App numeric ID
//   app.pem                      App private key (PEM)
//   app.<owner>.installation.id  one file per installed account
//   app.bot.name                 optional: App login for commit identity
//   app.bot.user.id              optional: numeric user ID of the bot
//
// The active installation is picked by the current repo's `origin` remote owner
// (https or ssh); without a match the first installation (alphabetical) is used
// and marked as fallback. Without config the extension stays disabled+silent.
//
// Commands:
//   /ghapp          active selection + status of all installations (masked)
//   /ghapp refresh  force a new token for the active installation
//
// Type-only import on purpose: a value import pulls the whole
// @earendil-works/pi-coding-agent barrel into extension load (~250ms, see rtk.ts #2753).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyBotIdentity, createTokenProvider, loadConfig } from "./github-app-auth.mjs";

const shortError = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 200);

export default function (pi: ExtensionAPI) {
  let provider: ReturnType<typeof createTokenProvider> | undefined;
  try {
    provider = createTokenProvider({ config: loadConfig(process.env.RIPMAVBOT_CONFIG_DIR) });
  } catch (e) {
    // No config dir / incomplete: disabled, reported once, never blocks sessions.
    console.warn(`[ripmav-bot] disabled: ${shortError(e)}`);
  }
  let lastError: string | undefined;
  let applied: { token: string; expiresAtMs: number; owner: string } | undefined; // token currently in process.env

  const apply = (t: { token: string }) => {
    process.env.GH_TOKEN = t.token;
    process.env.GITHUB_TOKEN = t.token;
  };

  // Guards against a stale in-process module cache after /reload (dependency .mjs
  // not re-imported): a failed apply must never escape as a handler crash.
  const safeApplyIdentity = (sel: { matched?: boolean } | null) => {
    try {
      applyBotIdentity(process.env, sel, provider?.config.bot);
    } catch (e) {
      console.warn(`[ripmav-bot] identity apply failed — restart pi after extension updates: ${shortError(e)}`);
    }
  };

  // Fail-open: token problems must never break an agent turn. Returns the
  // outcome so callers can surface it:
  //   fresh      cached token still valid (nothing happened)
  //   refreshed  re-minted before expiry (routine, ~hourly)
  //   recovered  the applied token had actually expired and was re-minted
  //   failed     re-mint failed — the old token (possibly expired) stays in env
  //   disabled   no config
  type EnsureResult =
    | { state: "fresh" | "refreshed" | "recovered"; token: string; expiresAtMs: number; owner: string; installationId: string; matched: boolean }
    | { state: "failed"; wasExpired: boolean }
    | { state: "disabled" };
  const ensure = async (cwd: string, force = false): Promise<EnsureResult> => {
    if (!provider) {
      safeApplyIdentity(null);
      return { state: "disabled" };
    }
    const wasExpired = !!applied && applied.expiresAtMs <= Date.now();
    try {
      const t = await provider.ensureFor({ cwd, force });
      const reMinted = !applied || t.token !== applied.token;
      apply(t);
      safeApplyIdentity(t); // bot commit identity only for matched repos
      applied = { token: t.token, expiresAtMs: t.expiresAtMs, owner: t.owner };
      lastError = undefined;
      const base = { token: t.token, expiresAtMs: t.expiresAtMs, owner: t.owner, installationId: t.installationId, matched: t.matched };
      return { state: reMinted ? (wasExpired ? "recovered" : "refreshed") : "fresh", ...base };
    } catch (e) {
      lastError = shortError(e);
      safeApplyIdentity(null);
      console.warn(`[ripmav-bot] ${lastError}`);
      return { state: "failed", wasExpired };
    }
  };

  const notify = (ctx: unknown, msg: string, type: "info" | "error" = "info") => {
    (ctx as { ui?: { notify?: (m: string, t?: string) => void } } | undefined)?.ui?.notify?.(msg, type);
  };

  // Status line updates on every ensure; notifications only on the events that
  // matter (session start, expiry recovery, failure) — a routine margin
  // refresh (~hourly) just updates the status line.
  const report = (ctx: unknown, r: EnsureResult, mode: "always" | "notable") => {
    const ui = (ctx as { ui?: { setStatus?: (k: string, s: string) => void } } | undefined)?.ui;
    if (r.state === "disabled") return; // unconfigured: stay silent, /ghapp explains
    if (r.state === "failed") {
      const msg = `token ${r.wasExpired ? "EXPIRED" : "refresh failed"} — ${lastError ?? "unknown"}`;
      ui?.setStatus?.("ripmav-bot", msg.slice(0, 100));
      notify(ctx, `ripmav-bot: ${msg}`, "error");
      return;
    }
    const min = Math.max(0, Math.round((r.expiresAtMs - Date.now()) / 60_000));
    const label = r.state === "fresh" ? "token ready" : r.state === "refreshed" ? "token refreshed" : "token expired → refreshed";
    ui?.setStatus?.("ripmav-bot", `${label} (${r.owner}) · ${min} min left`);
    if (mode === "always") {
      notify(ctx, `ripmav-bot: GH_TOKEN ${label.toLowerCase()} — active: ${r.owner} (${r.installationId})${r.matched ? "" : " (fallback)"} · ${min} min left`);
    } else if (r.state === "recovered") {
      notify(ctx, `ripmav-bot: ${label} (${r.owner}) · ${min} min left`, "error");
    }
  };

  // Idle tick: recompute the status line from the applied token so the
  // countdown stays live between turns. Display only — the expiry check and
  // re-mint still happen on every turn/bash call.
  let statusTimer: { unref?: () => void } | undefined;
  const startStatusTimer = (ctx: unknown) => {
    if (!provider || statusTimer) return;
    const ui = (ctx as { ui?: { setStatus?: (k: string, s: string) => void } } | undefined)?.ui;
    statusTimer = setInterval(() => {
      if (!applied || !ui) return;
      const min = Math.max(0, Math.round((applied.expiresAtMs - Date.now()) / 60_000));
      const msg = applied.expiresAtMs <= Date.now()
        ? `token EXPIRED (${applied.owner}) — will refresh on next run`
        : `token ready (${applied.owner}) · ${min} min left`;
      ui.setStatus?.("ripmav-bot", msg);
    }, 60_000);
    statusTimer.unref?.(); // never keep the pi process alive
  };

  pi.on("session_start", async (_event, ctx) => {
    report(ctx, await ensure(process.cwd()), "always");
    startStatusTimer(ctx);
  });

  pi.on("session_shutdown", () => {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = undefined;
  });

  // Before each agent turn: re-mint only when the cached token is close to expiry,
  // so long sessions never hand an expired token to a bash call.
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = (event as { systemPromptOptions?: { cwd?: string } } | undefined)?.systemPromptOptions?.cwd ?? process.cwd();
    report(ctx, await ensure(cwd), "notable");
  });

  // Right before every bash call (incl. nested calls from codemode): the margin
  // check runs again, so a long turn can never consume a token that expired
  // mid-turn. The check itself is in-memory; a re-mint only happens when the
  // cached token is expired or within REFRESH_MARGIN_MS of expiry.
  pi.on("tool_call", async (event, ctx) => {
    if ((event as { toolName?: string } | undefined)?.toolName !== "bash") return;
    report(ctx, await ensure(process.cwd()), "notable");
  });

  pi.registerCommand("ghapp", {
    description: "ripmav-bot: active installation + token status; arg 'refresh' forces a new token",
    handler: async (args: unknown, ctx) => {
      if (!provider) {
        notify(ctx, "ripmav-bot: no config found (~/.config/ripmav-bot or RIPMAVBOT_CONFIG_DIR)", "error");
        return;
      }
      const force = /refresh/i.test(String(args ?? ""));
      const cwd = process.cwd();
      await ensure(cwd, force);
      const status = lastError ? `${provider.statusFor(cwd)}\nlast error: ${lastError}` : provider.statusFor(cwd);
      notify(ctx, `ripmav-bot:\n${status}`, lastError ? "error" : "info");
    },
  });
}
