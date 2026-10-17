/**
 * Execution-context helpers for the tool layer.
 *
 * The session workspace is the directory the calling session is in RIGHT NOW —
 * never `process.cwd()`, which is the harness's launch directory and would
 * resolve a model's relative path against the wrong root. Agent-less callers
 * (tests, previews) have no session, so they fall back to the process cwd.
 *
 * @module dsh-fs-encoding/workspace-context
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";

/**
 * The `workingDirectory` service, as much of it as this plugin uses.
 *
 * Structural rather than imported: the service arrived in DSH 0.2.1, so a type
 * import of `@deepseek-ai/dsh-working-directory` would fail to compile against
 * every earlier line the peer range still supports. {@link resolveWorkspace}
 * proves the shape at runtime before calling it.
 */
interface WorkingDirectoryLike {
  /**
   * Validate the session's current directory and restore the original project
   * when it disappeared.
   *
   * @param agent - the agent owning the session.
   * @param signal - cancellation for the filesystem inspection.
   * @returns the existing directory.
   */
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>;
}

/**
 * The directory a tool call resolves relative paths against.
 *
 * `session.header.cwd` is NOT that directory on a deployment that lets the model
 * change it: the header is frozen at session creation, while a `cd` appends a
 * `working-directory/change` event that only the `workingDirectory` service
 * folds. Reading the header alone therefore pins every relative path to where
 * the session STARTED — measured on DSH 0.2.1, after `cd` into a subdirectory,
 * `read` on a file there failed `FS_NOT_FOUND` while the built-in `read` opened
 * it, because the built-ins ask this same service.
 *
 * The service is read opportunistically rather than declared in `inject`.
 * Cordis deactivates the WHOLE plugin when an injected service is missing, so
 * declaring it would trade `read` / `write` / `edit` working at all — on every
 * DSH line before 0.2.1, which has no such service — for this one path rule.
 * The same reason `subprocessOf` reads its seam this way.
 *
 * Call this ONCE per tool call and thread the answer down. `ensure` performs a
 * filesystem round-trip and may append a recovery notice, so a helper that
 * resolves the path for each of N files would pay that N times for one answer.
 *
 * @param ctx - the plugin context, for the opportunistic service lookup.
 * @param exec - the calling tool execution.
 * @returns the session's current directory, or the process cwd for an
 *   agent-less caller.
 */
export async function resolveWorkspace(ctx: Context, exec: ToolExecution): Promise<string> {
  const agent = exec.agent;
  if (agent === undefined) return process.cwd();
  const owner = ctx.get("workingDirectory") as Partial<WorkingDirectoryLike> | undefined;
  if (typeof owner === "object" && owner !== null && typeof owner.ensure === "function") {
    return owner.ensure(agent, exec.signal);
  }
  return agent.session.header.cwd ?? process.cwd();
}
