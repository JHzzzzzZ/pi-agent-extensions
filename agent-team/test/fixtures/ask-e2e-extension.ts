/**
 * Real-pi E2E fixture (test-only, never loaded in production builds).
 *
 * Runs inside a real `pi --mode rpc` child. Its `/ask-e2e` command asks one
 * question — either through the production leader-side mapping
 * (`askLeaderQuestion`) or, for the protocol-level timeout case, through a
 * direct `ctx.ui.input` with a short timeout — and persists the outcome.
 *
 * The dialog must run from a command (not from `session_start`): pi does not
 * consume RPC stdin while session-start handlers are pending, so a dialog
 * opened there could never receive its response. This mirrors pi's own
 * `examples/extensions/rpc-demo.ts` (dialogs exposed via commands).
 */

import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askLeaderQuestion, type AskToolParams } from "../../ask.ts";

export default function askE2eExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async () => {
    const ready = process.env.ASK_E2E_READY;
    if (ready) fs.writeFileSync(ready, "ready", "utf-8");
  });

  pi.registerCommand("ask-e2e", {
    description: "E2E fixture: ask one question through the production leader-side path",
    handler: async (_args, ctx) => {
      const out = process.env.ASK_E2E_OUT;
      if (!out) return;
      const directTimeout = process.env.ASK_E2E_DIRECT_TIMEOUT;
      if (directTimeout) {
        // Protocol-level case: pi's agent side auto-resolves the dialog when
        // the request carries a timeout and the client never responds.
        const value = await ctx.ui.input("[e2e] direct timeout", "placeholder", {
          timeout: Number(directTimeout),
        });
        fs.writeFileSync(
          out,
          JSON.stringify({ answered: typeof value === "string", ...(value !== undefined ? { answer: value } : {}) }),
          "utf-8",
        );
        return;
      }
      const params = JSON.parse(process.env.ASK_E2E_ARGS ?? "{}") as AskToolParams;
      const outcome = await askLeaderQuestion(ctx.ui, process.env.ASK_E2E_TEAM ?? "e2e", params);
      fs.writeFileSync(out, JSON.stringify(outcome), "utf-8");
    },
  });
}
