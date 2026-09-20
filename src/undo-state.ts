/**
 * The undo history: what one file looked like before its most recent edit.
 *
 * Deliberately a SEPARATE module from `encoding-state`, even though both are
 * per-session maps keyed by a target. The two answer different questions and
 * have different failure modes:
 *
 * - `encoding-state` remembers a few bytes of metadata per file (an encoding
 *   name, a BOM flag). Its bounds are about entry COUNT, because one entry is
 *   cheap.
 * - This module remembers the file's whole PREVIOUS CONTENT. An entry is
 *   therefore as large as the file, and a count bound alone would permit
 *   4096 files x 10 MiB. The bound here is a byte budget, and it is the
 *   load-bearing one.
 *
 * Keeping them apart is also what keeps the encoding memo's guarantees intact.
 * That memo decides how a save encodes; this one only decides what a save can
 * be reverted to. A bug in the undo bookkeeping must not be able to change how
 * a file is written.
 *
 * IN MEMORY ONLY. The plugin promises it writes nothing to disk and pollutes no
 * repository, so an undo point does not survive a DSH restart. That is a real
 * limitation, stated in the README rather than hidden: the tool reports "no undo
 * history" after a restart instead of pretending the edit was never made.
 *
 * @module dsh-fs-encoding/undo-state
 */

import type { FileEncodingState } from "./encoding-state.js";
import { sessionKeyOf } from "./encoding-state.js";

/** One file's pre-edit state, kept until the next write replaces it. */
export interface UndoRecord {
  /**
   * The file's text before the edit, LF-normalized and BOM-free.
   *
   * Stored in the same normalized form every writer already works in, so
   * restoring it goes back through the ordinary encode path — line endings and
   * BOM come from {@link previousState}, not from this string.
   */
  previousText: string;
  /**
   * The text the edit produced, LF-normalized.
   *
   * This is what makes the undo SAFE rather than merely convenient: before
   * reverting, the tool compares the file's current content against this, and
   * refuses when they differ. Without it, an undo would silently discard any
   * change made after the edit — including another tool's, or the user's own.
   */
  nextText: string;
  /**
   * The version this edit PRODUCED, when the backend reports one.
   *
   * The second half of the staleness check, and the half that catches what the
   * text cannot. {@link nextText} is compared as LF-normalized, BOM-stripped
   * text, so a file whose line endings were converted, whose BOM was added or
   * removed, or whose encoding changed without changing a character compares
   * EQUAL to the record — while being a genuine change by someone else that an
   * undo would silently destroy. The version is the only handle on those.
   *
   * `undefined` when the backend reports no version, in which case the text
   * comparison is the only guard available and is used on its own.
   */
  nextVersion: string | undefined;
  /**
   * The encoding the edit actually wrote, as `writeFile` reported it.
   *
   * Used as the hint for the undo's comparison read, which has to decode the
   * file to compare it against {@link nextText}. Without a hint that read can
   * fail outright: a legacy file whose session encoding record has since been
   * evicted cannot be admitted at all when guessing is off (the default), so the
   * undo would report `E_NOT_TEXT` for a file it is perfectly able to restore —
   * even though this record already knows the encoding.
   *
   * Deliberately NOT {@link previousState}'s encoding, which is the obvious
   * guess and is wrong: with `normalizeToUtf8` the edit MIGRATED the file, so
   * the bytes on disk are UTF-8 while `previousState` says `gbk`. Decoding UTF-8
   * bytes as GBK can still produce acceptable-looking text, which would then
   * fail the text comparison and turn a working undo into a false stale
   * refusal. The post-write encoding is the one that describes what is on disk.
   */
  nextEncoding: string;
  /**
   * How the file was encoded before the edit.
   *
   * Carried in full rather than re-read at undo time for two reasons:
   *
   * 1. **The encoding may have CHANGED.** With `normalizeToUtf8` on, a save
   *    rewrites a legacy file as UTF-8, so the session's record after the edit
   *    describes the bytes the undo is about to replace — not the ones it must
   *    restore. Reverting content without reverting the encoding would leave
   *    the file as UTF-8: half an undo.
   * 2. **The record may be GONE.** `encoding-state` is bounded and evicts, so
   *    reading it at undo time could find nothing and silently fall back to
   *    UTF-8 — which is exactly the silent re-encode this plugin exists to
   *    prevent.
   */
  previousState: FileEncodingState;
  /** Which guard the original write used, so the undo takes the same path. */
  mode: "write" | "edit";
}

/** One session's undo records, plus the order keys were last touched in. */
interface SessionUndo {
  records: Map<string, UndoRecord>;
  /** Running total of {@link UndoRecord.previousText} lengths, in UTF-16 units. */
  bytes: number;
}

/**
 * Upper bound on sessions tracked at once.
 *
 * Matches `encoding-state`'s bound so the two do not disagree about how many
 * sessions a process remembers. Undo records are far larger per entry, so this
 * bound is the coarser of the two in practice and eviction here is deliberate:
 * a session that has not been touched in 64 sessions' worth of activity is not
 * about to be undone.
 */
const MAX_SESSIONS = 64;

/**
 * Upper bound on one session's undo entries.
 *
 * A count bound on top of the byte budget, because many tiny files would
 * otherwise accumulate thousands of entries without ever approaching
 * {@link MAX_UNDO_BYTES}. Same value and same reasoning as
 * `encoding-state`'s `MAX_FILES_PER_SESSION`.
 */
const MAX_FILES_PER_SESSION = 4096;

/**
 * Upper bound on the total content held for one session, in UTF-16 units.
 *
 * The bound that actually matters: an undo record carries a whole file, so a
 * count-only bound would allow 4096 x `maxFileBytes` (10 MiB by default) of
 * retained text for a single session. 32 MiB holds a few large files or
 * thousands of small ones, which covers the real use — "revert the edit I just
 * made" — without letting a long session pin memory proportional to everything
 * it ever wrote.
 *
 * Counted in UTF-16 units rather than bytes: that is what a JavaScript string
 * actually occupies in memory, and the number is compared against strings we
 * already hold, so no encoding pass is needed to measure it.
 */
const MAX_UNDO_BYTES = 32 * 1024 * 1024;

/**
 * Upper bound on the content held across EVERY session, in UTF-16 units.
 *
 * {@link MAX_UNDO_BYTES} bounds one session and {@link MAX_SESSIONS} bounds how
 * many sessions exist, but their product is the real process ceiling — and it is
 * far too large: 64 x 32 MiB is 2 GiB of UTF-16 units, several gigabytes of
 * resident text, for a feature whose entire purpose is "revert the edit I just
 * made". A per-session bound alone therefore does not bound the process, and the
 * sessions that accumulate are not hypothetical: every subagent runs as its own
 * session.
 *
 * This is the bound that actually protects the process. It is deliberately much
 * smaller than the per-session budget, and eviction stays LRU across sessions —
 * the least recently written record goes first, whichever session owns it.
 */
const MAX_TOTAL_UNDO_BYTES = 64 * 1024 * 1024;

const sessions = new Map<string, SessionUndo>();

/** Running total of every session's {@link SessionUndo.bytes}. */
let totalBytes = 0;

/** Record one session's byte delta, keeping {@link totalBytes} exact. */
function addBytes(bucket: SessionUndo, delta: number): void {
  bucket.bytes += delta;
  totalBytes += delta;
}

function bucketFor(sessionKey: string): SessionUndo {
  let bucket = sessions.get(sessionKey);
  if (bucket === undefined) {
    bucket = { records: new Map(), bytes: 0 };
  } else {
    // Re-insert so this session counts as most recently used.
    sessions.delete(sessionKey);
  }
  sessions.set(sessionKey, bucket);
  evictSessions();
  return bucket;
}

/** Drop the least recently used sessions once the bound is exceeded. */
function evictSessions(): void {
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next();
    if (oldest.done === true) return;
    const dropped = sessions.get(oldest.value);
    if (dropped !== undefined) totalBytes -= dropped.bytes;
    sessions.delete(oldest.value);
  }
}

/**
 * Record what a file looked like before an edit, replacing any earlier record.
 *
 * One record per file, not a stack: the tool is `undo_last_edit`, so the
 * previous edit is the only one it can reach. A second edit on the same file
 * therefore OVERWRITES the record — undoing twice would need a stack, and the
 * name promises otherwise.
 *
 * The record is skipped entirely when it alone would exceed
 * {@link MAX_UNDO_BYTES}: keeping it would evict every other file's history to
 * hold one file's, and the honest outcome is "this edit cannot be undone"
 * rather than "your other files can no longer be undone".
 *
 * @param sessionKey - the bucket key from `sessionKeyOf`.
 * @param targetKey - the canonical target key.
 * @param record - the pre-edit state.
 */
export function recordUndo(sessionKey: string, targetKey: string, record: UndoRecord): void {
  const size = record.previousText.length + record.nextText.length;
  if (size > MAX_UNDO_BYTES) return;

  const bucket = bucketFor(sessionKey);

  const existing = bucket.records.get(targetKey);
  if (existing !== undefined) {
    addBytes(bucket, -(existing.previousText.length + existing.nextText.length));
    bucket.records.delete(targetKey);
  }

  bucket.records.set(targetKey, record);
  addBytes(bucket, size);

  // LRU eviction by the byte budget, then by count. `Map` preserves insertion
  // order and every touch re-inserts, so the first key is the least recent.
  while (bucket.bytes > MAX_UNDO_BYTES || bucket.records.size > MAX_FILES_PER_SESSION) {
    const oldest = bucket.records.keys().next();
    if (oldest.done === true) break;
    const dropped = bucket.records.get(oldest.value);
    if (dropped !== undefined) {
      addBytes(bucket, -(dropped.previousText.length + dropped.nextText.length));
    }
    bucket.records.delete(oldest.value);
  }

  // The process-wide budget, enforced last so it sees the per-session result.
  // Evicting across sessions is the point: a burst of sessions must not be able
  // to pin gigabytes between them, and the oldest record is the least likely to
  // be the one just made.
  evictToTotalBudget();
}

/**
 * Drop least-recently-written records until the process-wide budget holds.
 *
 * Walks sessions in their own LRU order and each session's records in insertion
 * order, so the very oldest record is dropped first. An emptied session is
 * removed rather than left as an empty bucket.
 */
function evictToTotalBudget(): void {
  while (totalBytes > MAX_TOTAL_UNDO_BYTES) {
    let droppedSomething = false;
    for (const [sessionKey, bucket] of sessions) {
      const oldest = bucket.records.keys().next();
      if (oldest.done === true) continue;
      const dropped = bucket.records.get(oldest.value);
      if (dropped !== undefined) {
        addBytes(bucket, -(dropped.previousText.length + dropped.nextText.length));
      }
      bucket.records.delete(oldest.value);
      if (bucket.records.size === 0) sessions.delete(sessionKey);
      droppedSomething = true;
      break;
    }
    // Nothing left to drop: the budget is unsatisfiable (a single record larger
    // than it is already refused above), so stop rather than spin.
    if (!droppedSomething) return;
  }
}

/**
 * Read one session's undo record for a file without removing it.
 *
 * @param sessionKey - the bucket key from `sessionKeyOf`.
 * @param targetKey - the canonical target key.
 * @returns the record, or `undefined` when there is nothing to undo.
 */
export function getUndo(sessionKey: string, targetKey: string): UndoRecord | undefined {
  return sessions.get(sessionKey)?.records.get(targetKey);
}

/**
 * Drop one session's undo record for a file.
 *
 * Called after a successful undo (the history is now spent) and whenever a
 * recorded edit is found to be stale, so a refusal is not repeated forever on a
 * record that can never apply.
 *
 * @param sessionKey - the bucket key from `sessionKeyOf`.
 * @param targetKey - the canonical target key.
 */
export function clearUndoFor(sessionKey: string, targetKey: string): void {
  const bucket = sessions.get(sessionKey);
  if (bucket === undefined) return;
  const dropped = bucket.records.get(targetKey);
  if (dropped === undefined) return;
  addBytes(bucket, -(dropped.previousText.length + dropped.nextText.length));
  bucket.records.delete(targetKey);
  if (bucket.records.size === 0) sessions.delete(sessionKey);
}

/**
 * Release every undo record a session owns.
 *
 * Called when a session ends, mirroring `encoding-state`'s release: without it
 * a long-lived process accumulates one bucket per session that ever ran, each
 * holding whole files.
 *
 * @param sessionId - the session that ended.
 */
export function clearSessionUndo(sessionId: string): void {
  const sessionKey = sessionKeyOf(sessionId);
  const bucket = sessions.get(sessionKey);
  if (bucket === undefined) return;
  totalBytes -= bucket.bytes;
  sessions.delete(sessionKey);
}

/** Total undo records across every session. Test seam. */
export function undoRecordCount(): number {
  let total = 0;
  for (const bucket of sessions.values()) total += bucket.records.size;
  return total;
}

/** Total retained content across every session, in UTF-16 units. Test seam. */
export function undoByteCount(): number {
  return totalBytes;
}

/** Drop every session's undo records. Test seam. */
export function resetUndoState(): void {
  sessions.clear();
  totalBytes = 0;
}
