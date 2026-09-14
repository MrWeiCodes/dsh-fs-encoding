/**
 * Execution-context helpers for the tool layer.
 *
 * The session workspace is the calling execution's own cwd — never
 * `process.cwd()`, which is the harness's launch directory and would resolve a
 * model's relative path against the wrong root. Agent-less callers (tests,
 * previews) have no session, so they fall back to the process cwd.
 *
 * @module dsh-fs-encoding/workspace-context
 */

import type { ToolExecution } from "@deepseek-ai/dsh-tools";

/**
 * The session workspace root a tool call resolves relative paths against.
 *
 * @param exec - the calling tool execution.
 * @returns the session cwd, or the process cwd for an agent-less caller.
 */
export function execCwd(exec: ToolExecution): string {
  return exec.agent?.session.header.cwd ?? process.cwd();
}
