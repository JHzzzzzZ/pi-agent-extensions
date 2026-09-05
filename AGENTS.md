# Repository Guidelines

## Project Overview

Workspace of extensions for the Pi coding agent (docs/comments are Chinese; code is English). Extensions load by being copied into `~/.pi/agent/extensions/` (global) or `.pi/extensions/` (trusted project), then `/reload` in Pi.

- **`pwr/` — primary project.** PWR (Pi Workflow Runtime) v2.2.0: users write constrained ECMAScript workflow scripts; PWR validates them, shows an approval card, then runs them by spawning child `pi` processes as sub-agents (`PiAgentRunner`). Zero-build TypeScript ESM, executed directly by Node >= 22.18 native type-stripping.
- **Satellites** (independent, same extension shape): `agent-team/` (reusable multi-agent teams: independent leader child dispatches member children via `team_dispatch`), `stream-token-speed/` (TTFT + live token/s status), `chatanywhere-provider/` (OpenAI-compatible + Anthropic Messages provider adapters), `provider-quota/` (balance status + `/quota`), `safe-git-autocommit/` (two-layer git safety + `safe_git_commit` tool), `run-timer/` (session/task/turn timer widget).

## Architecture & Data Flow

PWR (`pwr/`) is layered, with `src/types.ts` as the shared contract hub (`RuntimeAdapter`, `ScriptEngine`, `WorkflowRun`, `PwrErrorResult`, entry/custom-message constants, caps). Not strictly layered — `runtime/` imports `src/plan.ts` and `src/ui/types.ts` (RunEvent); `engine/interpreter.ts` re-exports `runner/errors.ts` `RunnerError`.

1. **`engine/`** — standalone DSL: `vendor/acorn.mjs` (vendored acorn 8.18.0, parse-only) → `parser.ts` → `validator.ts` (`validateScript`/`validateScriptStrict`, `extractPlan`) → `interpreter.ts` (AST tree-walker, globals `meta/args/agent/pipeline/parallel/sleep/JSON`, semaphore ≤ 128, loop budget 100k, `plain.ts` sanitized snapshot boundaries) → `concurrency.ts`. Public API re-exported by `engine/index.ts`; `engine/spec.ts` is the DSL source of truth (whitelist, caps, `SCRIPT_VERSION = '1.1.2'`).
2. **`runner/`** — `PiAgentRunner` (`runner/index.ts`): `discover.ts` (.md agent discovery, precedence user > project > builtin, trust-gated `agentScope`), `pi.ts` (child `pi --mode json -p --no-session`, line-JSON events, SIGTERM → SIGKILL after `KILL_GRACE_MS=5000`). Run contract `{ runId, agentId, prompt, label, tools, schema, signal }` → `{ result, summary, usage, events }`; result capped 50KB (`RESULT_TOO_LARGE`), summary 8KB. Tool intersection: readonly = read/grep/find/ls/glob, write = +bash/write/edit.
3. **`runtime/`** — `WorkflowRuntime` implements `RuntimeAdapter`: `state.ts` transition table, `scheduler.ts` FIFO queue, `cache.ts` `RunCache` (sha256 of digest + normalized input; cache hit replays without spawn or budget), `persist.ts` metadata-only entries. Module-level singleton `export default runtime`.
4. **`src/`** — orchestration: `flow.ts` pure flows + `RunRegistry`, `approval.ts` `ApprovalStore` (keyed canonicalProjectPath|digest — script edit ⇒ mandatory re-approval, `APPROVAL_STALE`), `notify.ts` `RunNotifier`, `save.ts` save/load/invoke, `args/plan/intent/constraints/digest/errors.ts`, `model-config.ts` (`/pwr-model`), `engine.ts` adapter (fail-closed `ENGINE_UNAVAILABLE`).
5. **`src/ui/`** — host-free TUI layer: `MemoryRunStore` (synchronous snapshots), `views.ts` pure text formatting, `commands.ts`, `save-flow.ts`, `approval-card.ts`, `renderer.ts` (only file importing `pi-tui` `Box/Text`). `ui/index.ts` `createWorkflowsUi` registers `/workflows`, shortcuts `ctrl+alt+z/x/r` (keys defined only in `pwr/src/ui/keybindings.ts`, the shortcut registry), entry renderer, widget/status.

**Run data flow:** `/workflow <task>` or `workflow:` prefix → `pwr-generation-request` custom message (`before_agent_start`) → main agent script calls `workflow_validate` → approval card on `tool_result` (once/remember/view script/reject; dismiss = still pending) → `workflow_start` (approval-gated) → `WorkflowRuntime.start` → scheduler → interpreter → dispatch (cache replay | budget vs `AGENT_LIMIT=1000` | `PiAgentRunner.run` child `pi`) → `RunCache` + `RunEvent` feed → `MemoryRunStore` → widget/entry renderer. Completion: `RunNotifier` (runId-scoped; cancelled runs never wake it) → `pi.sendMessage(pwr-workflow-result)`. Saved path: `/workflow:<name>` → `invokeSavedWorkflow` (project shadows user; re-validate; JSON args validated against schema; digest-gated approval).

**Lifecycle:** no init/onLoad hook. Entry `index.ts` registers commands/hooks at load; `session_start` dynamically imports `runtime/` + `runner/` and hydrates persisted entries (`pwr-approval-v1`, `pi-workflow-run-v1`) from `ctx.sessionManager`. Missing runner ⇒ `AGENT_RUNNER_UNAVAILABLE` — never an implicit fallback. Persistence is metadata-only; script source/args are never written.

**Known quirks:** no `agent_settled` handler in pwr (settle is runId-scoped via `onFinalResult`); `runtime.shutdown()` is never wired (no `session_shutdown` hook); engine↔runner mutually import; caps duplicated in `src/types.ts` / `engine/spec.ts` / `runtime/types.ts`; `engine/validate-tool.ts` `runWorkflowValidate` is consumed only by tests.

## Key Directories

- `pwr/engine/` — DSL parser/validator/interpreter; `spec.ts` is the DSL source of truth (whitelist, caps 128/1000/100k/256KB, `SCRIPT_VERSION`).
- `pwr/runtime/` — run state machine, FIFO scheduler, run cache, metadata-only persistence.
- `pwr/runner/` — child-`pi` process adapter, agent discovery.
- `pwr/src/` + `pwr/src/ui/` — orchestration contracts and TUI layer.
- `pwr/test/`, `pwr/tests/`, `pwr/runtime/test/`, `pwr/runner/test/` — node:test suites (see Testing).
- `pwr/vendor/` — vendored acorn 8.18.0 (`acorn.mjs` + hand-rolled `acorn.d.mts` + license); generated file, don't modify. Imported only by `engine/parser.ts` so PWR has zero runtime npm deps.
- Satellites: `agent-team/` (flat modules: types/config/runner/worktree/leader-prompt/dispatch/manage/cockpit/session/index + test/ + examples/), `stream-token-speed/` (multi-file: index/adapter/controller/metrics/status-port + test/), `chatanywhere-provider/` (index.ts + package.json with `pi.extensions` manifest), `provider-quota/` (index.ts, no package.json), `safe-git-autocommit/` (index.ts + sga-selftest.ts + package.json without `pi` field), `run-timer/` (index.ts + test, no package.json). Every extension directory uses `index.ts` as its entry point, so pi auto-discovery (`extensions/*/index.ts`) loads it after a plain directory copy.
- `agent-team/` specifics: team = persistent Markdown file (frontmatter `leader` + `members[]` with per-member `provider/model`, `tools`, `worktree`, block-scalar `prompt`) in `~/.pi/agent/teams/` or trusted-project `.pi/teams/` (project wins on name conflicts); discovery re-scans on every use (no cache). One codebase, two modes keyed on env `PI_AGENT_TEAM_FILE`: leader mode registers only the `team_dispatch` tool; cockpit mode registers `team_create`/`team_list`/`team_run` tools, `/team*` commands, widget, entry renderer (`agent-team-run-v1`). Member/leader children follow the same child-`pi` JSON-mode pattern as pwr's runner (`team-tmp://` prompt materialization, SIGTERM→SIGKILL), self-contained (no pwr imports). Result unions use `TeamErrorCodes`; caps: 8 tasks/dispatch, 4 concurrent members, 50KB result, 8KB summary.

## Development Commands

```bash
cd pwr && npm install          # all deps are devDependencies (pi-ai/pi-coding-agent/pi-tui, typebox, typescript)
npm test                       # node --test over test/, tests/, runtime/test/, runner/test/
npm run typecheck              # tsc -p tsconfig.json --noEmit
# subsets:
node --test tests/ui-*.test.ts
node --test runtime/test/scheduler.test.ts
```

Satellites (not covered by pwr's script):

```bash
cd stream-token-speed && node --experimental-strip-types --test test/*.test.ts   # 43 tests
cd agent-team && npm install && npm test                                        # 45 tests (node --test test/*.test.ts)
cd safe-git-autocommit && npm test                                              # npx tsx sga-selftest.ts (real-git selftest, writes sga-selftest.log)
node --experimental-strip-types --test run-timer/run-timer.test.ts               # no package.json here
```

No build step, no linter, no formatter configured.

## Code Conventions & Common Patterns

tsconfig (`pwr/tsconfig.json`) enforces the load-bearing rules — violations fail `npm run typecheck`:

- **ESM NodeNext, explicit `.ts` extensions** in every relative import: `import { ApprovalStore } from "./src/approval.ts";`
- **`import type` required** for type-only imports (`verbatimModuleSyntax`): `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`
- **No enums/namespaces/parameter properties** (`erasableSyntaxOnly`): error codes are `as const` objects — `export const ErrorCodes = { … } as const;` + `type ScriptErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];` (see `engine/errors.ts`).
- `strict: true`, `noEmit`, `allowImportingTsExtensions`, `isolatedModules`, `noImplicitOverride`.

Other patterns:

- **Result unions over exceptions:** `{ ok: true, value } | { ok: false, code, message }` everywhere; discriminated-union narrowing in callers (`if (r.ok) … else assert.equal(r.code, …)`). Each layer has its own code set: `src/errors.ts` (20 codes), `engine/errors.ts` (7), `runtime/errors.ts` (7), `runner/errors.ts` (5). Script failures carry source positions (`ScriptError`).
- **Dependency injection via deps objects and injected ports:** `FlowDeps`, `ToolDeps`, `SaveAdapter`, `UiRuntimeAdapter`, `SaveFlowActions`, `RunPersister`; no mocking libraries, no globals.
- **Injected clocks for determinism:** `now: () => string` / `nowMs` params instead of `Date.now()`; tests use a fixed `2026-08-05T12:00:00Z`.
- **State management:** runtime uses an explicit transition table (`runtime/state.ts` `TRANSITIONS` + `ALLOWED_OPERATIONS`, `assertTransition` → `ILLEGAL_STATE_TRANSITION`); UI uses `MemoryRunStore` synchronous snapshots fed by `RunEvent`s.
- **Exception isolation:** every UI/observer/persist call is try/caught — "persistence failures never break the session".
- **File header comments** cite JHL ticket IDs + PRD sections (`* PWR - Pi Workflow Runtime extension entry (JHL-16 trigger/generation/approval + JHL-17 save/load & parameter commands)`). Keep them updated.
- **Security invariants** (PWR): no `vm`/`eval`; whitelist validation before execution; fail-closed defaults (missing engine/runner ⇒ typed error, no implicit fallback); script source/args never persisted; `pwr-tmp://` in-process only; no API keys stored; error messages are static templates.
- **Typebox** for tool parameter schemas (`src/tools.ts` `registerPwrTools`, `safe-git-autocommit`).
- **TUI conventions (satellites):** guard writes with `ctx.hasUI`, style via `theme.fg("dim", …)`, exception-isolate every `setStatus`/`setWidget` call, one status key per extension (`stream-token-speed`, `provider-quota`, `run-timer`).
- Indentation: tabs in `pwr/`, 2 spaces in `agent-team/`, `run-timer/` and `stream-token-speed/`.

## Important Files

- `pwr/index.ts` — extension entry; `export default pwrExtension(pi: ExtensionAPI)`; commands (`/workflow`, `/pwr-model`, `/workflow-delete`, dynamic `/workflow:<name>`), hooks (`input`, `before_agent_start`, `session_start`, `model_select`, `tool_call`, `tool_result`), tools via `registerPwrTools` (`workflow_validate`, `workflow_start`, `workflow_control`, `workflow_save`), approval cards, entry renderer, runner injection.
- `pwr/src/types.ts` — shared contract hub: cross-layer interfaces + message/entry constants (`pi-workflow-run-v1`, `pwr-approval-v1`, `pwr-generation-request`, `pwr-workflow-result`), caps (`AGENT_LIMIT=1000`, `CONCURRENCY_MAX=128`, `CONCURRENCY_DEFAULT=4`, `MAX_SCRIPT_SIZE=256*1024`, `MAX_FINAL_SUMMARY_SIZE=8*1024`).
- `pwr/engine/spec.ts` — DSL source of truth (whitelist, limits, clamps, script version 1.1.2).
- `pwr/DELIVERY.md` — authoritative architecture/security doc + version history (v2.0.0 → v2.2.0, JHL ticket mapping JHL-10..17). Note: contains corruption artifacts (dropped leading characters, a duplicated heading).
- `pwr/README.md`, root `README.md` — Chinese feature/install docs.
- `pwr/test/helpers.ts`, `pwr/runner/test/helpers.ts` — fake AgentRunner and fake pi-child process builders; reuse these in new tests.
- `pwr/package.json`, `pwr/tsconfig.json` — scripts and enforced conventions.

## Runtime/Tooling Preferences

- **Node >= 22.18** (native type-stripping — `.ts` runs directly; verified on Node 22.23.1 / Windows). No Bun, no build step, no bundler.
- **npm** (package-lock v3). Package manager is not Bun/pnpm.
- TypeScript ^5.8 (5.9.3 resolved); `@earendil-works/pi-*` ^0.83.0 as devDependencies only — the host Pi environment resolves them at runtime.
- Pi extension API surface used across the workspace: `pi.on` (`session_start`, `agent_start`, `agent_settled`, `turn_start/end`, `model_select`, `message_start/update/end`, `input`, `before_agent_start`, `tool_call`, `tool_result`), `pi.registerCommand`, `pi.registerTool`, `pi.registerProvider`, `pi.registerShortcut`, `pi.registerEntryRenderer`, `pi.appendEntry`, `pi.sendMessage`, `ctx.ui.setStatus/setWidget/notify`, `ctx.sessionManager.getEntries`.
- Config via env vars (`CHATANYWHERE_API_KEY`, `CHATANYWHERE_BASE_URL`) or `~/.pi/agent/auth.json` keyed by provider id (provider-quota — explicitly not env vars).
- Install shape: all extensions are directories with an `index.ts` entry point (chatanywhere-provider additionally declares `pi.extensions: ["./index.ts"]` in its package.json); copy the directory into `extensions/` and pi loads it automatically.

## Testing & QA

- **Framework: `node:test` + `node:assert/strict`** — no vitest/jest; no mock libraries. Flat `test("name", fn)` naming in pwr and stream-token-speed (prose assertions, some Chinese names); `describe`/`it` only in `run-timer.test.ts` (47 `it`s, with a `setInterval` mock via before/after hooks). `*.test.ts` suffix everywhere (exception: `sga-selftest.ts`, a custom tsx-run harness with `check()` groups — 91 checks, exit 1 on failure).
- **Mocking = hand-written fakes at process boundaries:** fake `AgentRunner` (`makeFakeRunner`, `pwr/test/helpers.ts`), fake pi child (`FakeChild` + `makeFakeSpawn` + `waitForChild`, `pwr/runner/test/helpers.ts`), `RecordingStatusPort` (`stream-token-speed/test/fixtures.ts`). The real pi-tui is never instantiated in tests (structural fakes cast `as never`).
- **Integration pattern:** wire real modules (`PiAgentRunner` + `WorkflowRuntime` + `MemoryPersister`) with a mocked spawn, scripted child events, and polling `waitSettled` (10ms × 100) — see `pwr/runner/test/integration.test.ts` (happy path + `restart_agent` semantics; `handle.records.length` proves cache replay doesn't spawn).
- **Perf gate:** `pwr/test/perf.test.ts` — `validateScript` on ~1500-agent / ~64KB scripts must finish < 300ms (wall clock).
- **Counts (measured via grep):** pwr ≈ 335 tests across 30 `*.test.ts` files (test/ 98, tests/ 153, runtime/test/ 47, runner/test/ 37) — READMEs claim 346, DELIVERY.md 322; trust the measured count. stream-token-speed 43; run-timer 47; sga-selftest 91 checks.
- **Coverage gaps:** `chatanywhere-provider` and `provider-quota` have zero tests. No TODO/skip/only markers anywhere.
- **Determinism & hermeticity:** injected fixed clocks (`2026-08-05T12:00:00Z`), temp dirs via `os.tmpdir()` with cleanup, no network.
- Quality bar per `pwr/DELIVERY.md`: full suite green + `npm run typecheck` zero errors before delivery.
