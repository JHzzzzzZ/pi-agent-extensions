/** Minimal structural tool result shape (mirrors pi's AgentToolResult). */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
  isError?: boolean;
}
