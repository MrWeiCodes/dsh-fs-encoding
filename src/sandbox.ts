/**
 * The sandbox fence and the `fs/*` event gate for this plugin's own writers.
 *
 * The plugin publishes bytes itself instead of calling `ctx.fs.writeText`, so
 * it must reproduce what that call would have done on the caller's behalf:
 * resolve the per-call policy, refuse a target outside the writable roots, take
 * the version guard, and record the observation afterwards.
 *
 * Every ingredient here is a PUBLIC seam — `ctx.fs.contains` / `resolve` /
 * `stat`, the `sandboxPolicy` service, `writableRoots`, `approveEscalation`,
 * and the `fs/write-intent` + `fs/edit-intent` + `fs/observed` events. Nothing
 * reaches into a backend's internals, so a backend upgrade cannot silently
 * change what this module means.
 *
 * @module dsh-fs-encoding/sandbox
 */

import type { Context } from "@deepseek-ai/cordis";
import { FsError, type FsTarget, type FsVersion } from "@deepseek-ai/dsh-fs";
import {
  approveEscalation,
  ESCALATION_TARGETS,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
  writableRoots,
} from "@deepseek-ai/dsh-sandbox";
import type { SandboxExecutionPolicy, SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";

/** The two escalation arguments a mutating tool may carry. */
export interface FsEscalationArgs {
  sandbox_permissions?: string;
  justification?: string;
}

/** The policy resolver shape published by `@deepseek-ai/dsh-sandbox-policy`. */
interface SandboxPolicyLike {
  resolve(request?: { session?: unknown }): SandboxExecutionPolicy;
}

/** The approval service shape `approveEscalation` consumes. */
interface ApprovalLike {
  request(req: {
    agent: unknown;
    toolName: string;
    callId: string;
    reason: string;
    signal?: AbortSignal;
  }): Promise<"allowed-once" | "rejected" | "cancelled" | "unavailable">;
}

/** The write guard the observation policy answers with. */
export interface WriteIntent {
  kind: string;
  version?: FsVersion;
}

/**
 * Owns the escalation vocabulary and the per-call fence for this plugin.
 *
 * Mirrors `@deepseek-ai/dsh-tool-fs`'s controller so these tools escalate
 * exactly like the built-ins they shadow: the escalation fields appear in the
 * schema only under a confining backend, a denied operation is retried once at
 * a strictly wider mode through the approval service, and the denial reaches
 * the model as the shared `[sandbox: …]` marker.
 */
export class EncodingSandbox {
  /** Modes this composition advertises; empty when no backend confines. */
  readonly escalationModes: readonly SandboxMode[];
  private readonly policy: SandboxPolicyLike | undefined;

  constructor(private readonly ctx: Context) {
    const defaultMode = ctx.fs.sandboxMode;
    this.escalationModes = defaultMode === undefined ? [] : ESCALATION_TARGETS;
    this.policy =
      defaultMode === undefined ? undefined : (ctx.get("sandboxPolicy") as SandboxPolicyLike);
    if (defaultMode !== undefined && this.policy === undefined) {
      throw new Error(
        "dsh-fs-encoding: the mounted filesystem confines but ctx.sandboxPolicy is missing",
      );
    }
  }

  /**
   * The escalation fields for a mutating tool's `parameters`.
   *
   * Call only when {@link escalationModes} is non-empty; the enum pins the
   * closed vocabulary, and the strict-wider check happens per call.
   */
  schemaFields(): Record<string, unknown> {
    return {
      sandbox_permissions: {
        type: "string",
        enum: [...this.escalationModes],
        description:
          "The wider sandbox mode this file operation needs. Only valid as a one-shot retry " +
          "of an operation the sandbox just denied; requires justification and user approval.",
      },
      justification: {
        type: "string",
        description:
          "Required with sandbox_permissions: one sentence for the user explaining " +
          "why this exact file operation needs the wider access.",
      },
    };
  }

  /**
   * Resolve the policy to stamp onto this mutation: an approved one-shot
   * escalation when the call carries the fields, else the session's standing
   * mode with the calling session's cwd as the workspace root.
   *
   * @param toolName - the mutating tool's name, for the approval audit trail.
   * @param args - the call's escalation arguments.
   * @param exec - the tool execution (agent, callId, signal).
   * @returns the policy to enforce, or `undefined` on an unsandboxed backend.
   */
  async resolvePolicy(
    toolName: string,
    args: FsEscalationArgs,
    exec: ToolExecution,
  ): Promise<SandboxExecutionPolicy | undefined> {
    validateEscalationArgs(args.sandbox_permissions, args.justification);
    const standing = this.policy?.resolve(
      exec.agent === undefined ? {} : { session: exec.agent.session },
    );

    if (args.sandbox_permissions === undefined || args.justification === undefined) {
      return standing;
    }
    if (this.escalationModes.length === 0) {
      throw new Error(
        "sandbox_permissions is not available in this composition (no sandboxing filesystem to escalate)",
      );
    }

    const current = standing as SandboxExecutionPolicy;
    const granted = await approveEscalation(
      {
        requestedMode: args.sandbox_permissions,
        justification: args.justification,
        effectiveMode: current.mode,
        subject: "operation",
      },
      {
        approver: this.ctx.get("approval") as ApprovalLike | undefined,
        agent: exec.agent,
        callId: String(exec.callId),
        toolName,
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      },
    );
    return { ...current, mode: granted };
  }

  /**
   * Enforce the policy against a target and return the exact target the write
   * must use.
   *
   * The containment check re-resolves immediately before returning, so the
   * identity that was checked is the identity that gets written — a symlink
   * swapped between check and write cannot redirect it.
   *
   * @param target - the resolved target about to be written.
   * @param policy - the per-call policy, or `undefined` on an unsandboxed backend.
   * @returns the target to write.
   * @throws {FsError} `FS_SANDBOX_DENIED` when the policy refuses.
   */
  async checkedTarget(
    target: FsTarget,
    policy: SandboxExecutionPolicy | undefined,
  ): Promise<FsTarget> {
    if (policy === undefined) return target;
    const { mode } = policy;
    if (mode === "danger-full-access") return target;
    if (mode === "read-only") {
      throw new FsError(
        `cannot write "${target.displayPath}": file access denied under read-only mode`,
        "FS_SANDBOX_DENIED",
      );
    }

    const fresh = await this.ctx.fs.resolve(target.displayPath);
    for (const root of writableRoots(policy)) {
      const rootTarget = await this.ctx.fs.resolve(root);
      if (this.ctx.fs.contains(rootTarget, fresh)) return fresh;
    }
    throw new FsError(
      `cannot write "${target.displayPath}": file access denied under workspace-write mode`,
      "FS_SANDBOX_DENIED",
    );
  }

  /**
   * Take the write guard for a target.
   *
   * The observation policy answers `createIfAbsent` / `replaceIfVersion` from
   * the version this session last observed; with no policy mounted the bare
   * `undefined` means no guard is taken, exactly as for the built-ins.
   *
   * "No guard" is NOT the same as "no checks", and this method must not be read
   * that way. `writeFile` adds its own refusal — a file that EXISTS while the
   * session holds no encoding record for it is rejected rather than re-encoded as
   * UTF-8 — and that refusal is independent of the policy. So in a composition
   * with no policy mounted, overwriting an existing file still requires reading
   * it first; the plugin will not write a file whose encoding it does not know,
   * because doing so silently replaces every non-ASCII byte of a legacy file.
   * Only a genuinely new file is written unconditionally.
   *
   * @param target - the target about to be written.
   * @param exec - the calling execution, which the policy keys its state by.
   * @returns the guard, or `undefined` when no policy supplies one.
   */
  async takeWriteIntent(target: FsTarget, exec: ToolExecution): Promise<WriteIntent | undefined> {
    return (await this.ctx.waterfall("fs/write-intent", target, exec, () => undefined)) as
      | WriteIntent
      | undefined;
  }

  /**
   * Take the edit guard, which additionally refuses a file never read.
   *
   * @param target - the target about to be edited.
   * @param exec - the calling execution.
   * @returns the version the edit must match, or `undefined` when no policy listens.
   * @throws {FsError} `FS_NOT_OBSERVED` when the file was never read this session.
   */
  async takeEditIntent(
    target: FsTarget,
    exec: ToolExecution,
  ): Promise<{ version: FsVersion } | undefined> {
    return (await this.ctx.waterfall("fs/edit-intent", target, exec, () => undefined)) as
      | { version: FsVersion }
      | undefined;
  }

  /**
   * Record a successful mutation so the next built-in tool sees the file as
   * observed at the new version.
   *
   * Without this the policy's state stays stale and the very next built-in
   * `write` fails `FS_NOT_OBSERVED` or `FS_STALE_VERSION`. Failures are logged
   * and swallowed: the write already succeeded.
   *
   * @param target - the target that was written.
   * @param version - the version the write produced, when the backend reports one.
   * @param exec - the calling execution.
   */
  emitObserved(target: FsTarget, version: FsVersion | undefined, exec: ToolExecution): void {
    if (version === undefined) return;
    try {
      this.ctx.emit("fs/observed", target, { kind: "present", version }, exec);
    } catch (error) {
      this.ctx.logger.warn(
        `dsh-fs-encoding: fs/observed emission failed for ${target.displayPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Translate a thrown provider error for the model.
   *
   * A `FS_SANDBOX_DENIED` becomes the shared `[sandbox: …]` denial marker plus
   * the same-turn escalation hint, keeping the structured code. Anything else
   * passes through untouched.
   *
   * @param error - the thrown error.
   * @param policy - the policy the call ran under, for the mode in the marker.
   * @returns the error to rethrow.
   */
  mapError(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown {
    if (!(error instanceof FsError) || error.code !== "FS_SANDBOX_DENIED") return error;
    const mode = policy?.mode ?? "workspace-write";
    return new FsError(
      `${sandboxDenialMarker(mode)}\n${escalationHintMarker("operation")}`,
      "FS_SANDBOX_DENIED",
      { cause: error },
    );
  }
}
