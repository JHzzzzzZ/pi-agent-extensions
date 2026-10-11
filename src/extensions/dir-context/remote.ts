/**
 * dir-context — 远端调用的判据与提示文案（只看入参字段，零耦合）。
 *
 * 为什么需要（工单 dir-context-todo#4）：`remote-tools` 一类插件给工具加了 `remote="[user@]host"`
 * 参数，带它就表示这次调用在**远端主机**执行、`path` 按**远端**规则解析。本扩展只看 `input.path`
 * 并按本地 cwd 解锚点，于是远端相对路径（`docs/x.md`）会被当成同名的**本机**路径 ⇒ 把本机约定
 * 喂给远端结果（错注入，比不注入更危险）。
 *
 * 判据因此只认**入参字段**：远端与本地路径在字符串层面不可区分，而跨机解析远端路径既不可能、
 * 也不该由本插件做。宁可不注入，也绝不误注入（fail-closed）。
 *
 * 为什么不 import remote-tools：两个插件各自独立安装/升级，本扩展不引用对方任何模块（
 * `resolveToolPath` / `createSessionCache` / `HOST_PATH_MARKER` 都是内部面）。缺省值字面量
 * 集合照抄同一口径，但是本模块自持的一份小副本——口径漂移的方向仍是「少注入」（不误注入）。
 */

/** 视作「没给」的字符串字面量（trim + 大小写无关）——与 remote-tools 同口径的自持副本。 */
const ABSENCE_LITERALS: ReadonlySet<string> = new Set(["null", "undefined", "nil", "none", "n/a", "na"]);

/**
 * 这次调用是否发生在远端：入参里有 `remote` 字段，且它是 trim 后非空、又不是缺省值字面量的字符串。
 *
 * 其余一律 `false`（= 按本地处理，行为与今天逐字一致）：字段缺失（含没装 remote-tools）、
 * 非字符串、空串、纯空白、缺省值字面量。判不准就往「本地」倒——本函数只在已经决定要触碰路径
 * 之后才被问，`false` 只是维持现状，不引入任何新行为。
 */
export function isRemoteCall(input: Record<string, unknown>): boolean {
  const value = input.remote;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && !ABSENCE_LITERALS.has(normalized);
}

/**
 * 会话内首次远端触碰时追加的一行提示。
 *
 * 静态文案：不插值模型输入（host 名也是模型输入），也不声称远端读过任何东西——本扩展一字节
 * 远端内容都不取，只是告诉模型「远端约定不会自动到，需要就自己读」。
 */
export const REMOTE_NOTICE =
  "[dir-context] 远端调用：远端目录的 AGENTS.md / CLAUDE.md 约定不会自动注入——需要时请自行 read（带 remote 参数）该远端目录下的同名文件。";
