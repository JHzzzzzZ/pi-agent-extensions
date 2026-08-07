# Repository Guidelines

## Project Overview

Workspace of extensions for the Pi coding agent (docs/comments are Chinese; code is English). Extensions load by being copied into `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (trusted project), then `/reload` in Pi.

- **`pwr/` — primary project.** PWR (Pi Workflow Runtime) v2.2.0: users write constrained ECMAScript workflow scripts; PWR validates them, shows an approval card, then runs them by spawning child `pi` processes as sub-agents (`PiAgentRunner`). Zero-build TypeScript ESM, executed directly by Node >= 22.18 native type-stripping.
- **Satellites** (independent, same extension shape): `stream-token-speed/` (live token/s status), `chatanywhere-provider/` (model provider), `provider-quota/` (balance status + `/quota`), `safe-git-autocommit/` (two-layer git safety + `safe_git_commit` tool), `run-timer/` (session/task/turn timer widget).

## Architecture & Data Flow

PWR (`pwr/`) is layered, with `src/types.ts` as the shared contract hub (`RuntimeAdapter`, `ScriptEngine`, `WorkflowRun`, `PwrErrorResult`, entry/custom-message constants). Not strictly layered — `runtime/` imports `src/plan.ts` and `src/ui/types.ts`; `engine/interpreter.ts` re-exports `runner/errors.ts` `RunnerError`.

1. **`engine/`** — standalone DSL: `vendor/acorn.mjs` → `parser.ts` → `validator.ts` (whitelist, `validateScript`/`validateScriptStrict`, `extractPlan`) → `interpreter.ts` (AST tree-walker, globals `meta/args/agent/pipeline/parallel/sleep/JSON`, AgentRunner contract, `plain.ts` sanitized snapshot boundaries, `concurrency.ts` semaphore). Public API re-exported by `engine/index.ts`.
2. **`runner/`** — `PiAgentRunner` (`runner/index.ts`): `discover.ts` (.md agent discovery, precedence user > project > builtin), `pi.ts` (child `pi --mode json -p --no-session`, line-JSON events, SIGTERM → SIGKILL after `KILL_GRACE_MS=5000`). Run contract `{ runId, agentId, prompt, label, tools, schema, signal }` → `{ result, summary, usage, events }`; results capped 50KB (`RESULT_TOO_LARGE`), summary 8KB.
3. **`runtime/`** — `WorkflowRuntime` implements `RuntimeAdapter`: `state.ts` transition table, `scheduler.ts` FIFO queue, `cache.ts` `RunCache` (sha256 of digest + normalized input), `persist.ts` metadata-only entries. Module-level singleton `export default runtime`.
4. **`src/`** — orchestration: `flow.ts` pure flows + `RunRegistry`, `approval.ts` `ApprovalStore`, `notify.ts` `RunNotifier`, `save.ts` save/load/invoke, `args/plan/intent/constraints/digest/errors.ts`.
5. **`src/ui/`** — host-free TUI layer: `MemoryRunStore` (synchronous snapshots), `views.ts` pure text formatting, `commands.ts`, `save-flow.ts`, `approval-card.ts`, `renderer.ts` (only file importing `pi-tui` `Box/Text`). `ui/index.ts` `createWorkflowsUi` registers `/workflows`, shortcuts `ctrl+alt+p/x/r`, entry renderer, widget/status.

**Run data flow:** `/workflow <task>` or `workflow:` prefix → `pwr-generation-request` custom message (before_agent_start) → main agent script calls `workflow_validate` (awaiting_approval) → approval card (once/remember/reject) → `workflow_start` → `WorkflowRuntime.start` → scheduler → interpreter → dispatch (cache replay | budget | `PiAgentRunner.run` child `pi`) → `RunCache` + `RunEvent` feed → `MemoryRunStore` → widget/entry renderer. Completion: `RunNotifier` (gated by `onRunSettled`) → `pi.sendMessage(pwr-workflow-result)`.

**Lifecycle:** no init/onLoad hook. Entry `index.ts` registers commands/hooks at load; `session_start` dynamically imports `runtime/` + `runner/` and hydrates persisted entries (`pwr-approval-v1`, `pi-workflow-run-v1`) from `ctx.sessionManager`. Missing runner ⇒ `AGENT_RUNNER_UNAVAILABLE` — never an implicit fallback. Persistence is metadata-only; script source/args are never written.

## Key Directories

- `pwr/engine/` — DSL parser/validator/interpreter; `spec.ts` is the DSL source of truth (whitelists, caps 128/1000/100k/256KB, `SCRIPT_VERSION`).
- `pwr/runtime/` — run state machine, FIFO scheduler, run cache, persistence.
- `pwr/runner/` — child-`pi` process adapter, agent discovery.
- `pwr/src/` + `pwr/src/ui/` — orchestration contracts and TUI layer.
- `pwr/test/`, `pwr/tests/`, `pwr/runtime/test/`, `pwr/runner/test/` — node:test suites (see Testing).
- `pwr/vendor/` — vendored acorn 8.18.0 (`acorn.mjs` + hand-rolled `acorn.d.mts` + license); generated file, don't modify. Imported only by `engine/parser.ts` so PWR has zero runtime npm deps.
- Satellite dirs each hold their own `index.ts` entry; `chatanywhere-provider/` and `safe-git-autocommit/` also have `package.json` (`pi.extensions: ['./index.ts']` manifest).

## Development Commands

```bash
cd pwr && npm install          # all deps are devDependencies (pi-ai/pi-coding-agent/pi-tui, typebox, typescript)
npm test                       # node --test over test/, tests/, runtime/test/, runner/test/ — 346 tests
npm run typecheck              # tsc -p tsconfig.json --noEmit
# subsets:
node --test tests/ui-*.test.ts
node --test runtime/test/scheduler.test.ts
```

Satellites (not covered by pwr's script):

```bash
cd stream-token-speed && node --experimental-strip-types --test test/*.test.ts   # 43 tests
cd safe-git-autocommit && npx tsx sga-selftest.ts                                 # real-git selftest
node --experimental-strip-types --test run-timer/run-timer.test.ts               # no package.json here
```

No build step, no linter, no formatter configured.

## Code Conventions & Common Patterns

tsconfig (`pwr/tsconfig.json`) enforces the load-bearing rules — violations fail `npm run typecheck`:

- **ESM NodeNext, explicit `.ts` extensions** in every relative import: `import { ApprovalStore } from "./src/approval.ts";`
- **`import type` required** for type-only imports (`verbatimModuleSyntax`): `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`
- **No enums/namespaces/parameter properties** (`erasableSyntaxOnly`): error codes are `as const` objects — `export const ErrorCodes = { … } as const;` + `type ScriptErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];` (see `engine/errors.ts`).
- `strict: true`, `noEmit`, `allowImportingTsExtensions`.

Other patterns:

- **Result unions over exceptions:** `{ ok: true, value } | { ok: false, code, message }` everywhere; discriminated-union narrowing in callers (`if (r.ok) … else assert.equal(r.code, …)`). Each layer has its own code set: `src/errors.ts` (`PwrError`, 20 codes), `engine/errors.ts` (7), `runtime/errors.ts` (7), `runner/errors.ts` (5). Script failures carry source positions (`ScriptError`).
- **Dependency injection via deps objects and injected ports:** `FlowDeps`, `ToolDeps`, `SaveAdapter`, `UiRuntimeAdapter`, `SaveFlowActions`; no mocking libraries, no globals.
- **Injected clocks for determinism:** `now: () => string` / `nowMs` params instead of `Date.now()`; tests use a fixed `2026-08-05T12:00:00Z`.
- **State management:** runtime uses an explicit transition table (`runtime/state.ts` `TRANSITIONS` + `ALLOWED_OPERATIONS`, `assertTransition`); UI uses `MemoryRunStore` synchronous snapshots fed by `RunEvent`s.
- **File header comments** cite JHL ticket IDs + PRD sections (`* PWR - Pi Workflow Runtime extension entry (JHL-16 trigger/generation/approval + JHL-17 save/load & parameter commands)`). Keep them updated.
- **Security invariants** (PWR): no `vm`/`eval`; whitelist validation before execution; fail-closed defaults; script source/args never persisted; `pwr-tmp://` in-process only; no API keys stored.
- **Typebox** for tool parameter schemas (`src/tools.ts` `registerPwrTools`, `safe-git-autocommit`).
- **TUI conventions (satellites):** guard writes with `ctx.hasUI`, style via `theme.fg("dim", …)`, exception-isolate every `setStatus`/`setWidget` call, one status key per extension (`stream-token-speed`, `run-timer`).
- Indentation: tabs in `pwr/`, 2 spaces in `run-timer/` and `stream-token-speed/`.

## Important Files

- `pwr/index.ts` — extension entry; `export default pwrExtension(pi: ExtensionAPI)`; the place to understand registration and wiring.
- `pwr/src/types.ts` — shared contract hub (cross-layer interfaces + message/entry constants).
- `pwr/engine/spec.ts` — DSL source of truth (whitelist, limits, clamps, script version).
- `pwr/DELIVERY.md` — authoritative architecture/security doc + version history (v2.0.0 → v2.2.0, JHL ticket mapping).
- `pwr/README.md`, root `README.md` — Chinese feature/install docs.
- `pwr/test/helpers.ts`, `pwr/runner/test/helpers.ts` — fake AgentRunner and fake pi-child process builders; reuse these in new tests.
- `pwr/package.json`, `pwr/tsconfig.json` — scripts and enforced conventions.

## Runtime/Tooling Preferences

- **Node >= 22.18** (native type-stripping — `.ts` runs directly; Node 22.23.1 verified). No Bun, no build step, no bundler.
- **npm** (package-lock v3). Package manager is not Bun/pnpm.
- TypeScript ^5.8 (5.9.3 resolved); `@earendil-works/pi-*` ^0.83.0 as devDependencies only — the host Pi environment resolves them at runtime.
- Pi extension API surface used: `pi.on` (`session_start`, `session_shutdown`, `agent_start`, `agent_settled`, `turn_start/end`, `model_select`, `message_start/update/end`, `input`, `before_agent_start`, `tool_call`), `pi.registerCommand`, `pi.registerTool`, `pi.registerProvider`, `ctx.ui.setStatus/setWidget/notify`, `ctx.sessionManager.getEntries`, `pi.appendEntry`, `pi.sendMessage`, `pi.registerEntryRenderer`.
- Config via env vars (`CHATANYWHERE_API_KEY`, `CHATANYWHERE_BASE_URL`) or `~/.pi/agent/auth.json` (provider-quota).

## Testing & QA

- **Framework: `node:test` + `node:assert/strict`** — no vitest/jest; no mock libraries. Flat `test("name", fn)` naming (`describe/it` only in `run-timer.test.ts`); helpers/fixtures colocated as plain `.ts`; `*.test.ts` suffix everywhere (exception: `sga-selftest.ts`).
- **Mocking = hand-written fakes at process boundaries:** fake `AgentRunner` (`pwr/test/helpers.ts`), fake pi child (`FakeChild` + `makeFakeSpawn`, `pwr/runner/test/helpers.ts`), `RecordingStatusPort` (`stream-token-speed/test/fixtures.ts`). The real pi-tui is never instantiated in tests (cast types via `as never`).
- **Integration pattern:** wire real modules (`PiAgentRunner` + `WorkflowRuntime` + `MemoryPersister`) with a mocked spawn, scripted child events, and polling `waitSettled` (10ms × 100) — see `pwr/runner/test/integration.test.ts`.
- **Perf gate:** `pwr/test/perf.test.ts` — `validateScript` on ~1500-agent / ~64KB scripts must finish < 300ms (wall clock).
- **Coverage:** engine/runtime/runner/UI all covered (326 tests in `pwr/`); `run-timer` and `stream-token-speed` (43 tests) have suites; **`chatanywhere-provider` and `provider-quota` have zero tests.** No TODO/skip/only markers anywhere.
- Quality bar per `pwr/DELIVERY.md`: full suite green + `npm run typecheck` zero errors before delivery.
