/**
 * Shared team fixtures for tests.
 */

import type { TeamConfig } from "../types.ts";

export const VALID_TEAM_MD = `---
name: dev-team
description: 全栈开发小队
leader:
  model: anthropic/claude-opus-4-5
  prompt: |
    你是 dev-team 的技术负责人。
    收到任务后：拆解 -> 派发 -> 审查 -> 汇总。
members:
  - name: frontend
    description: 前端开发
    model: chatanywhere/gpt-5.6
    tools: [read, edit, bash]
    prompt: |
      你是资深前端工程师。
      使用 TypeScript。
  - name: backend
    description: 后端开发
    model: anthropic/claude-sonnet-4-5
    worktree: true
    prompt: |
      你是资深后端工程师。
---

团队级补充说明：所有代码变更需附带测试。
`;

export function fixtureTeam(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return {
    name: "dev-team",
    description: "全栈开发小队",
    leader: { model: "anthropic/claude-opus-4-5", prompt: "你是技术负责人，负责拆解与派发。" },
    members: [
      {
        name: "frontend",
        description: "前端",
        model: "chatanywhere/gpt-5.6",
        tools: ["read", "edit", "bash"],
        prompt: "你是前端工程师。",
      },
      { name: "backend", description: "后端", model: "anthropic/claude-sonnet-4-5", prompt: "你是后端工程师。" },
    ],
    notes: "团队备注",
    filePath: "/tmp/teams/dev-team.md",
    source: "global",
    ...overrides,
  };
}
