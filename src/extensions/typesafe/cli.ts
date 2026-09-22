/**
 * typesafe CLI（typesafe-todo#1）——与 `typesafe_ask` 工具**共用** client.ts 的调用 core，
 * 供 bash、子 agent、团队 run 等没有工具的场景使用。
 *
 * 用法：
 *   node src/extensions/typesafe/cli.ts --state "<文本>" --questions '<JSON>'
 *   node src/extensions/typesafe/cli.ts --state-file <路径> --questions-file <路径> [--model <id>]
 *
 * 输出契约：**stdout 只有 answers 的 JSON**（可直接被下游解析），错误走 stderr、
 * 形如 `CODE: <静态消息>`，退出码 0/1/2。key 从 `TYPESAFE_API_KEY` 或 `auth.json`
 * 的 `typesafe` 条目解析（credential.ts），**不经过任何参数，也不出现在输出里**。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { askTypesafe, ErrorCodes, resolveBaseUrl, type AskDeps } from "./client.ts";
import { resolveKeyFromDisk } from "./credential.ts";

export const CLI_USAGE = `用法：
  node cli.ts --state "<文本>" --questions '<JSON>' [--model <id>]
  node cli.ts --state-file <路径> --questions-file <路径> [--model <id>]

选项：
  --state / --state-file          要做判断的材料（二选一）
  --questions / --questions-file  问题表 JSON（二选一）
  --model                          TypeSafe 模型 id，默认 jev-latest
  -h, --help                       显示本帮助

环境变量：TYPESAFE_API_KEY（可选，优先于 auth.json）、TYPESAFE_BASE_URL（可选，默认 https://api.typesafe.ai）
`;

export interface CliDeps {
	argv?: string[];
	env?: NodeJS.ProcessEnv;
	readFile?: (path: string) => string;
	write?: (text: string) => void;
	writeError?: (text: string) => void;
	fetchFn?: AskDeps["fetchFn"];
}

interface CliOptions {
	state?: string;
	"state-file"?: string;
	questions?: string;
	"questions-file"?: string;
	model?: string;
	help?: boolean;
}

function readTextSource(
	inline: string | undefined,
	file: string | undefined,
	readFile: (path: string) => string,
): { ok: true; value: string } | { ok: false; message: string } {
	if ((inline === undefined) === (file === undefined)) return { ok: false, message: "必须且只能给一个来源（--state 或 --state-file）" };
	if (inline !== undefined) return { ok: true, value: inline };
	try {
		return { ok: true, value: readFile(file as string) };
	} catch {
		return { ok: false, message: "读不到指定文件" };
	}
}

/** 跑一次 CLI；返回值即进程退出码（0 成功 / 1 调用失败 / 2 用法错误）。 */
export async function runCli(deps: CliDeps = {}): Promise<number> {
	const argv = deps.argv ?? process.argv.slice(2);
	const env = deps.env ?? process.env;
	const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const write = deps.write ?? ((text: string) => process.stdout.write(text));
	const writeError = deps.writeError ?? ((text: string) => process.stderr.write(text));

	let options: CliOptions;
	try {
		options = parseArgs({
			args: argv,
			options: {
				state: { type: "string" },
				"state-file": { type: "string" },
				questions: { type: "string" },
				"questions-file": { type: "string" },
				model: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
			allowPositionals: false,
			strict: true,
		}).values as CliOptions;
	} catch {
		writeError(`${ErrorCodes.BAD_ARGS}: 参数无法解析\n${CLI_USAGE}`);
		return 2;
	}

	if (options.help === true) {
		write(CLI_USAGE);
		return 0;
	}

	const state = readTextSource(options.state, options["state-file"], readFile);
	if (!state.ok) {
		writeError(`${ErrorCodes.BAD_ARGS}: state —— ${state.message}\n${CLI_USAGE}`);
		return 2;
	}
	const questionsRaw = readTextSource(options.questions, options["questions-file"], readFile);
	if (!questionsRaw.ok) {
		writeError(`${ErrorCodes.BAD_ARGS}: questions —— ${questionsRaw.message}\n${CLI_USAGE}`);
		return 2;
	}

	let questions: unknown;
	try {
		questions = JSON.parse(questionsRaw.value) as unknown;
	} catch {
		writeError(`${ErrorCodes.BAD_ARGS}: questions 不是合法 JSON\n`);
		return 2;
	}

	const result = await askTypesafe({
		state: state.value,
		questions,
		model: options.model,
		baseUrl: resolveBaseUrl(env),
		resolveKey: () => resolveKeyFromDisk(env),
		fetchFn: deps.fetchFn,
	});

	if (!result.ok) {
		writeError(`${result.code}: ${result.message}\n`);
		return 1;
	}
	write(`${JSON.stringify(result.value, null, 2)}\n`);
	return 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	process.exitCode = await runCli();
}
