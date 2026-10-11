/**
 * test/helpers/pair-probe.mjs — L2 配对探针（每个配对跑一个独立子进程）
 *
 * 为什么用子进程：扩展持有模块级单例与全局双加载守卫（agent-team 的
 * `__piAgentTeamExtensionLoaded` 就是先例），同进程里反复加载会互相污染——而真实世界里
 * 一个 pi 会话就是一个进程。探针 = 一次真实会话：A、B 依次加载 → session_start →
 * session_shutdown → session_start（可重入）→ 把观测到的注册面打成 JSON。
 *
 * 用法：node test/helpers/pair-probe.mjs <扩展A> <扩展B>
 * 环境：COMPOSITION_PROBE_INJECT=<工具名>  额外注册一个同名工具（变异自证用）
 *
 * 边界：宿主替身只记录注册面，不模拟宿主内部 first-wins 覆盖与渲染——那部分由 L3（真 pi）
 * 与既有宿主路径测试覆盖。探针只忠实记录"谁注册了什么、顺序如何"。
 */

import { fireHook, loadExtension, makeHost } from "./composition-host.mjs";

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("用法：node test/helpers/pair-probe.mjs <扩展A> <扩展B>");
  process.exit(2);
}

const report = { order: [a, b], phases: {}, error: null };
const host = makeHost({ label: a });

try {
  host.setActor(a);
  const factoryA = await loadExtension(a);
  await factoryA(host.pi);
  host.setActor(b);
  const factoryB = await loadExtension(b);
  await factoryB(host.pi);
  report.phases.load = "ok";

  await fireHook(host, "session_start");
  report.phases.firstStart = "ok";
  await fireHook(host, "session_shutdown");
  report.phases.shutdown = "ok";
  await fireHook(host, "session_start");
  report.phases.secondStart = "ok";

  const injected = process.env.COMPOSITION_PROBE_INJECT;
  if (injected) {
    host.setActor("probe-injected");
    host.pi.registerTool({ name: injected, description: "probe-injected", parameters: {} });
  }

  report.tools = host.record.tools;
  report.commands = host.record.commands;
  report.providers = host.record.providers;
  report.virtualModels = host.record.virtualModels;
  report.shortcuts = host.record.shortcuts;
  report.hooks = host.record.hooks.map((h) => ({ event: h.event, source: h.source }));
  report.statusKeys = [...new Set(host.record.statusWrites.map((w) => w.key))].sort();
  report.widgetKeys = [...new Set(host.record.widgetWrites.map((w) => w.key))].sort();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify(report));
  process.exit(1);
}

console.log(JSON.stringify(report));
process.exit(0);
