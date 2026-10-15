/**
 * shell-job-host — 远端 job 托管端口单测（timeout-bg-todo#4）
 *
 * 边界与动机：这条链路的全部风险都在「跨扩展边界」与「文本单源」——载荷来自别的扩展、
 * 超时结果文本必须与本地逐字同源。事件总线用**宿主真实的 createEventBus**
 * （`emit` 同步派发、owner 在返回前把盒子填好是契约成立的前提），端口用真注册表 + 真文本
 * 模板（只把 pid/日志根注入成固定值），不替身被测逻辑。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { createJobRegistry, type JobRecord } from "../jobs.ts";
import { resolveJobLogPath } from "../logs.ts";
import {
  REMOTE_TAIL_MAX_CHARS,
  SHELL_JOB_HOST_CHANNEL,
  type RemoteJobPort,
  createRemoteJobPort,
  offerRemoteJobPort,
} from "../shell-job-host.ts";
import { backgroundResultText, formatJobList, timeoutResultText } from "../text.ts";

function makePort() {
  let seq = 0;
  const exits: JobRecord[] = [];
  const registry = createJobRegistry({ now: () => 5_000, killTree: () => {}, onExit: (job) => exits.push(job) });
  const port = createRemoteJobPort({
    newJobId: () => `bg-${++seq}`,
    logPathFor: (id) => resolveJobLogPath("/logs", id),
    registry,
    timeoutText: timeoutResultText,
    backgroundText: backgroundResultText,
  });
  return { port, registry, exits };
}

/** 模拟提供方（remote-tools）的索取：真事件总线 + 空盒子，owner 在 emit 返回前填好。 */
function claim(bus: EventBus): RemoteJobPort | undefined {
  const box: { host?: unknown } = {};
  bus.emit(SHELL_JOB_HOST_CHANNEL, box);
  return box.host as RemoteJobPort | undefined;
}

test("allocate：同序列发号 + 日志路径算法与本地 job 同布局", () => {
  const { port } = makePort();
  const first = port.allocate();
  const second = port.allocate();
  assert.deepEqual([first.id, second.id], ["bg-1", "bg-2"], "号段与本地 job 共用，不另开支线");
  assert.equal(first.logPath, resolveJobLogPath("/logs", "bg-1"));
  assert.equal(first.logPath.endsWith(".log"), true);
  assert.match(first.logPath, new RegExp(`[/\\\\]${process.pid}[/\\\\]bg-1\\.log$`), "布局：<logRoot>/<pi pid>/<id>.log");
});

test("register：登记 running job 并返回本地同格式的超时结果文本（远端位置 + 尾部输出）", () => {
  const { port, registry } = makePort();
  const ticket = port.allocate();
  const text = port.register({
    id: ticket.id,
    logPath: ticket.logPath,
    command: "sleep 15; echo MARK",
    target: "deploy@10.0.0.7",
    timeoutSeconds: 3,
    tail: "partial-output\n",
    terminate: () => {},
  });

  const job = registry.get(ticket.id);
  assert.ok(job !== undefined);
  assert.equal(job.status, "running");
  assert.equal(job.target, "deploy@10.0.0.7", "远端 job 用目标主机展示（没有本地 pid）");
  assert.equal(job.pid, null);
  assert.equal(job.logPath, ticket.logPath);

  assert.match(text, /命令超时（3 秒）/, "文本模板与本地同源（不是提供方自己拼的）");
  assert.match(text, new RegExp(`job: ${ticket.id}`));
  assert.match(text, /remote deploy@10\.0\.0\.7/, "本地显示 pid、远端显示目标主机");
  assert.ok(text.includes(ticket.logPath));
  assert.match(text, /partial-output/);

  const list = formatJobList(registry.list(), 5_100);
  assert.match(list, new RegExp(ticket.id));
  assert.match(list, /remote deploy@10\.0\.0\.7/);
  assert.doesNotMatch(list, /pid \?/, "远端 job 不该显示未知 pid");
});

test("registerBackground：主动后台登记（来源标记 + 结果文本与本地同源），不带超时秒数", () => {
  const { port, registry, exits } = makePort();
  const ticket = port.allocate();
  const text = port.registerBackground({
    id: ticket.id,
    logPath: ticket.logPath,
    command: "npm run build\nsecond line",
    target: "deploy@10.0.0.7",
    tail: "",
    terminate: () => {},
  });

  const job = registry.get(ticket.id);
  assert.ok(job !== undefined);
  assert.equal(job.origin, "background", "来源标记：主动后台（/bg 列表据此显示 [后台]）");
  assert.equal(job.status, "running");
  assert.equal(job.target, "deploy@10.0.0.7");
  assert.equal(job.command, "npm run build", "命令只留首行");
  assert.match(text, /已直接转入后台运行/, "文本由本扩展单源持有（提供方不自己拼）");
  assert.doesNotMatch(text, /超时/);
  assert.match(text, new RegExp(`job: ${ticket.id}`));
  assert.match(text, /remote deploy@10\.0\.0\.7/);
  assert.ok(text.includes(ticket.logPath));

  assert.match(formatJobList(registry.list(), 5_100), /\[后台\]/, "/bg 列表标出来源");

  // 结束路径与超时 job 完全一致（settle → 完成通知）。
  port.settle(ticket.id, 0);
  assert.equal(registry.get(ticket.id)!.status, "exited");
  assert.deepEqual(exits.map((j) => j.id), [ticket.id]);
});

test("registerBackground：终止钩子非函数时按「没有钩子」处理（跨扩展载荷 fail-soft）", () => {
  const { port, registry } = makePort();
  const ticket = port.allocate();
  port.registerBackground({
    id: ticket.id,
    logPath: ticket.logPath,
    command: "ls",
    target: "deploy@host",
    tail: "",
    terminate: "not-a-function" as never,
  });
  const job = registry.get(ticket.id)!;
  assert.equal(job.terminate, undefined);
  assert.equal(registry.kill(ticket.id), true, "没有钩子时走 killTree（不抛错）");
});

test("register：命令与目标也按本地口径清洗（首行 400 字符、剔控制字符）", () => {
  const { port, registry } = makePort();
  const ticket = port.allocate();
  port.register({
    id: ticket.id,
    logPath: ticket.logPath,
    command: `\u001b[31mecho hi\u0007\nsecond line ${"x".repeat(500)}`,
    target: "deploy@host\u0007",
    timeoutSeconds: 1,
    tail: "",
    terminate: () => {},
  });
  const job = registry.get(ticket.id)!;
  assert.doesNotMatch(job.command, /\u001b|\u0007/, "/bg 列表是对着终端渲染的，控制字符不得漏进去");
  assert.ok(job.command.length <= 400, "命令只取首行且限长（与本地 job 同口径）");
  assert.doesNotMatch(job.command, /second line/);
  assert.equal(job.target, "deploy@host");
});

test("register：尾部输出过控制字符 + 限长（载荷跨扩展而来，渲染前一律清洗）", () => {
  const { port } = makePort();
  const ticket = port.allocate();
  const noisy = `\u001b[31mboom\u0007${"x".repeat(REMOTE_TAIL_MAX_CHARS * 2)}tail`;
  const text = port.register({
    id: ticket.id,
    logPath: ticket.logPath,
    command: "boom",
    target: "host",
    timeoutSeconds: 1,
    tail: noisy,
    terminate: () => {},
  });
  const tail = text.split("[最近输出]\n")[1] ?? "";
  assert.doesNotMatch(tail, /\u001b|\u0007/, "终端控制序列不得进模型上下文");
  assert.ok(tail.length <= REMOTE_TAIL_MAX_CHARS);
  assert.match(tail, /tail$/, "保留的是最近的输出");
});

test("settle：自然结束 → exited + 完成通知；已 /bg:kill 的忽略", () => {
  const { port, registry, exits } = makePort();
  const ticket = port.allocate();
  port.register({
    id: ticket.id,
    logPath: ticket.logPath,
    command: "x",
    target: "host",
    timeoutSeconds: 1,
    tail: "",
    terminate: () => {},
  });
  port.settle(ticket.id, 0);
  assert.equal(registry.get(ticket.id)!.status, "exited");
  assert.equal(registry.get(ticket.id)!.exitCode, 0);
  assert.equal(exits.length, 1);

  const killed = port.allocate();
  port.register({
    id: killed.id,
    logPath: killed.logPath,
    command: "y",
    target: "host",
    timeoutSeconds: 1,
    tail: "",
    terminate: () => {},
  });
  registry.kill(killed.id);
  port.settle(killed.id, 137);
  assert.equal(registry.get(killed.id)!.status, "killed", "被 kill 的任务不再被 settle 改写");
  assert.equal(exits.length, 1, "kill 不触发完成通知");
});

test("register：terminate 非函数/缺省时按「没有终止钩子」处理，不抛错（畸形载荷 fail-soft）", () => {
  const { port, registry } = makePort();
  const ticket = port.allocate();
  assert.doesNotThrow(() =>
    port.register({
      id: ticket.id,
      logPath: ticket.logPath,
      command: "x",
      target: "host",
      timeoutSeconds: 1,
      tail: "",
      terminate: 42 as unknown as () => void,
    }),
  );
  assert.equal(registry.get(ticket.id)!.terminate, undefined);
  assert.equal(registry.kill(ticket.id), true, "没有钩子的远端 job 仍可被杀（走 pid 兜底，pid 为 null 时无害）");
});

test("offerRemoteJobPort：索取能拿到端口；槽位先到先得；畸形盒子/无总线都不抛", () => {
  const { port } = makePort();
  const bus = createEventBus();
  offerRemoteJobPort(bus, port);
  assert.equal(claim(bus), port, "订阅方同步拿到端口");

  const occupied = { host: "another-owner" as unknown };
  bus.emit(SHELL_JOB_HOST_CHANNEL, occupied);
  assert.equal(occupied.host, "another-owner", "槽位已有主不得覆盖");

  for (const box of [null, "box", 42, undefined]) {
    assert.doesNotThrow(() => bus.emit(SHELL_JOB_HOST_CHANNEL, box));
  }
  assert.doesNotThrow(() => offerRemoteJobPort(undefined, port), "没有事件总线（旧宿主）也不得抛");
});

test("offerRemoteJobPort：退订后不再应答（/reload 后旧实例不能占着先到先得的槽位）", () => {
  const { port } = makePort();
  const bus = createEventBus();
  const detach = offerRemoteJobPort(bus, port);
  assert.equal(claim(bus), port);
  detach();
  assert.equal(claim(bus), undefined, "退订后提供方拿不到端口（按无托管回退旧路径）");
  assert.doesNotThrow(() => detach(), "退订幂等");
});

test("offerRemoteJobPort：总线订阅本身抛错时静默降级（托管不可用，不破坏加载）", () => {
  const { port } = makePort();
  const throwingBus = {
    on: () => {
      throw new Error("bus down");
    },
  } as unknown as EventBus;
  assert.doesNotThrow(() => offerRemoteJobPort(throwingBus, port));
});
