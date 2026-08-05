/**
 * Edit history — one timeline for both AI runs and hand edits.
 *
 * Every checkpoint holds the COMPLETE edit state (words + speed markers +
 * default speed), so restoring one can never produce a mixed state that never
 * existed. That invariant is why the agent's checkpoints were introduced; this
 * module extends the same treatment to edits made by hand and adds the diff
 * that turns a list of states into a readable list of changes.
 *
 * Two things here are worth knowing before changing anything:
 *
 * 1. `editedWords` is a SOFT-delete list. Deleting a word sets `deleted: true`;
 *    the entry stays in the array. So a diff is mostly a comparison of flags,
 *    not of presence — and the untouched original can be reconstructed from any
 *    later state by clearing the flags.
 *
 * 2. Speed markers are POSITIONAL (`wordIndex` into `editedWords`), so the same
 *    marker list means different things either side of a reorder. Comparing
 *    markers directly would report phantom changes. Instead both sides are
 *    resolved to a per-word rate and compared by word identity.
 */

/** A word in the edit list. Structural subset of @mieweb/ui's EditableWord. */
export interface HistoryWord {
  /** Index into the silence-inserted baseline timeline. -1 for split/inserted entries. */
  originalIndex: number;
  word: {
    text: string;
    startMs?: number;
    endMs?: number;
    wordType?: string;
  };
  deleted?: boolean;
  inserted?: boolean;
}

export interface HistorySpeedMarker {
  /** Index into the editedWords array — positional, not identity. */
  wordIndex: number;
  speed: number;
}

export type CheckpointKind = 'original' | 'ai' | 'manual';

export interface Checkpoint {
  at: string;
  label: string;
  kind?: CheckpointKind;
  summary?: string;
  /** The agent's operation list. Typed as AgentOp[] by its producer; history
   *  only ever counts and forwards them, so it does not depend on the shape. */
  ops?: any[];
  durationMs?: number;
  editedWords: HistoryWord[];
  speedMarkers?: HistorySpeedMarker[];
  defaultSpeed?: number;
  /** When the burst that produced this checkpoint began (manual checkpoints). */
  startedAt?: string;
  /** Set once a user renames it, so regenerated labels stop overwriting theirs. */
  renamed?: boolean;
}

/**
 * A hand-edit burst stays open while edits keep arriving. Two bounds close it:
 * a quiet gap (you stopped and thought about something), and a hard ceiling so
 * a long uninterrupted session still breaks into reviewable pieces rather than
 * collapsing into one enormous "you edited the video" entry.
 */
export const BURST_GAP_MS = 30_000;
export const BURST_MAX_MS = 120_000;

export type WordChangeKind = 'added' | 'dropped' | 'removed' | 'restored' | 'unchanged';

export interface WordChange {
  originalIndex: number;
  text: string;
  wordType?: string;
  change: WordChangeKind;
  /** Reordered relative to the other words around it. Independent of `change`. */
  moved: boolean;
  /** Cut from the timeline in the AFTER state (whether or not it changed here). */
  deleted: boolean;
  /** Playback rate before/after, only when they differ. */
  speedFrom?: number;
  speedTo?: number;
}

export interface DiffCounts {
  removed: number;
  restored: number;
  added: number;
  dropped: number;
  moved: number;
  /** Contiguous REGIONS re-timed, not words. One marker can re-time 200 words;
   *  "sped up 1 region" is what a person did, "sped up 200 words" is arithmetic. */
  spedUp: number;
  slowed: number;
}

export interface CheckpointDiff {
  /** Every word in the AFTER ordering, plus dropped entries in their BEFORE slot. */
  words: WordChange[];
  counts: DiffCounts;
  defaultSpeedFrom: number;
  defaultSpeedTo: number;
}

/**
 * Stable identity for a word across checkpoints.
 *
 * `originalIndex` is the natural key, but it is not guaranteed unique: pasted
 * words keep the index they were copied from, and split/inserted entries all
 * carry -1. An occurrence ordinal disambiguates without needing the editor to
 * mint IDs it does not currently have.
 */
function keyFor(word: HistoryWord, seen: Map<number, number>): string {
  const oi = word.originalIndex;
  const n = seen.get(oi) ?? 0;
  seen.set(oi, n + 1);
  return `${oi}#${n}`;
}

function keyList(words: HistoryWord[]): string[] {
  const seen = new Map<number, number>();
  return words.map((w) => keyFor(w, seen));
}

/**
 * Resolve the playback rate for every word.
 *
 * Markers are positional and sorted by `wordIndex`; each one sets the rate from
 * that word onward until the next marker. Doing this on both sides and then
 * comparing by identity is what makes speed comparable across a reorder.
 */
export function resolveSpeeds(
  words: HistoryWord[],
  markers: HistorySpeedMarker[] | undefined,
  defaultSpeed: number
): number[] {
  const sorted = [...(markers ?? [])].sort((a, b) => a.wordIndex - b.wordIndex);
  const rates = new Array<number>(words.length);
  let current = defaultSpeed;
  let next = 0;
  for (let i = 0; i < words.length; i++) {
    while (next < sorted.length && sorted[next].wordIndex === i) {
      current = sorted[next].speed;
      next++;
    }
    rates[i] = current;
  }
  return rates;
}

/**
 * Indices of the longest increasing subsequence — the largest set of items that
 * kept their relative order. Everything outside it is what actually moved, which
 * is the minimal honest answer: reordering one sentence should mark that
 * sentence, not everything it displaced.
 */
function longestIncreasingSubsequence(values: number[]): Set<number> {
  if (values.length === 0) return new Set();
  // tails[k] = index into `values` of the smallest tail of an increasing
  // subsequence of length k+1; prev[] threads the chain back together.
  const tails: number[] = [];
  const prev = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let k = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (k !== -1) {
    keep.add(k);
    k = prev[k];
  }
  return keep;
}

/** Compare two checkpoint states. `before` may be null for the first entry. */
export function diffCheckpoints(
  before: Checkpoint | null,
  after: Checkpoint
): CheckpointDiff {
  const afterWords = after.editedWords ?? [];
  const afterKeys = keyList(afterWords);
  const afterDefault = typeof after.defaultSpeed === 'number' ? after.defaultSpeed : 1;
  const afterRates = resolveSpeeds(afterWords, after.speedMarkers, afterDefault);

  if (!before) {
    return {
      words: afterWords.map((w, i) => ({
        originalIndex: w.originalIndex,
        text: w.word?.text ?? '',
        wordType: w.word?.wordType,
        change: 'unchanged' as WordChangeKind,
        moved: false,
        deleted: !!w.deleted,
        ...(afterRates[i] !== afterDefault
          ? { speedFrom: afterDefault, speedTo: afterRates[i] }
          : {}),
      })),
      counts: emptyCounts(),
      defaultSpeedFrom: afterDefault,
      defaultSpeedTo: afterDefault,
    };
  }

  const beforeWords = before.editedWords ?? [];
  const beforeKeys = keyList(beforeWords);
  const beforeDefault = typeof before.defaultSpeed === 'number' ? before.defaultSpeed : 1;
  const beforeRates = resolveSpeeds(beforeWords, before.speedMarkers, beforeDefault);

  const beforePos = new Map<string, number>();
  beforeKeys.forEach((k, i) => beforePos.set(k, i));
  const afterPos = new Map<string, number>();
  afterKeys.forEach((k, i) => afterPos.set(k, i));

  // Words present on both sides, in AFTER order, described by their BEFORE
  // position. A run that stays increasing never moved.
  const commonAfterIdx: number[] = [];
  const commonBeforePositions: number[] = [];
  afterKeys.forEach((k, i) => {
    const b = beforePos.get(k);
    if (b !== undefined) {
      commonAfterIdx.push(i);
      commonBeforePositions.push(b);
    }
  });
  const stable = longestIncreasingSubsequence(commonBeforePositions);
  const movedAfterIdx = new Set<number>();
  commonAfterIdx.forEach((afterIdx, n) => {
    if (!stable.has(n)) movedAfterIdx.add(afterIdx);
  });

  const counts = emptyCounts();
  const words: WordChange[] = [];

  afterWords.forEach((w, i) => {
    const key = afterKeys[i];
    const bIdx = beforePos.get(key);
    let change: WordChangeKind;
    if (bIdx === undefined) {
      change = 'added';
      counts.added++;
    } else {
      const wasDeleted = !!beforeWords[bIdx].deleted;
      const isDeleted = !!w.deleted;
      if (!wasDeleted && isDeleted) {
        change = 'removed';
        counts.removed++;
      } else if (wasDeleted && !isDeleted) {
        change = 'restored';
        counts.restored++;
      } else {
        change = 'unchanged';
      }
    }

    const moved = movedAfterIdx.has(i);
    if (moved) counts.moved++;

    const rateTo = afterRates[i];
    const rateFrom = bIdx === undefined ? beforeDefault : beforeRates[bIdx];
    const speedChanged = rateFrom !== rateTo;

    words.push({
      originalIndex: w.originalIndex,
      text: w.word?.text ?? '',
      wordType: w.word?.wordType,
      change,
      moved,
      deleted: !!w.deleted,
      ...(speedChanged ? { speedFrom: rateFrom, speedTo: rateTo } : {}),
    });
  });

  // Re-timing is counted in contiguous regions. Walking the AFTER order and
  // counting run starts is the whole trick: a run continues while the direction
  // of change holds, so one marker over a long passage counts once.
  let prevDirection = 0;
  words.forEach((wc) => {
    if (wc.deleted) return;
    const direction =
      wc.speedFrom === undefined || wc.speedTo === undefined
        ? 0
        : Math.sign(wc.speedTo - wc.speedFrom);
    if (direction !== 0 && direction !== prevDirection) {
      if (direction > 0) counts.spedUp++;
      else counts.slowed++;
    }
    prevDirection = direction;
  });

  // Entries that vanished from the array entirely (rather than being flagged
  // deleted). Rare, but silently dropping them from the diff would misreport.
  beforeKeys.forEach((k, i) => {
    if (afterPos.has(k)) return;
    counts.dropped++;
    const w = beforeWords[i];
    words.push({
      originalIndex: w.originalIndex,
      text: w.word?.text ?? '',
      wordType: w.word?.wordType,
      change: 'dropped',
      moved: false,
      deleted: !!w.deleted,
    });
  });

  return {
    words,
    counts,
    defaultSpeedFrom: beforeDefault,
    defaultSpeedTo: afterDefault,
  };
}

function emptyCounts(): DiffCounts {
  return { removed: 0, restored: 0, added: 0, dropped: 0, moved: 0, spedUp: 0, slowed: 0 };
}

export function hasChanges(diff: CheckpointDiff): boolean {
  const c = diff.counts;
  return (
    c.removed > 0 ||
    c.restored > 0 ||
    c.added > 0 ||
    c.dropped > 0 ||
    c.moved > 0 ||
    c.spedUp > 0 ||
    c.slowed > 0 ||
    diff.defaultSpeedFrom !== diff.defaultSpeedTo
  );
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function rate(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '')}×`;
}

/**
 * A deterministic label for a hand-edit burst.
 *
 * Hand edits have no instruction to name them with, and asking people to name
 * every version means the versions never get named. Describing what changed is
 * both automatic and more useful than a timestamp — and it stays honest,
 * because it is derived from the states rather than from intent.
 */
export function describeChanges(diff: CheckpointDiff): string {
  const c = diff.counts;
  const parts: string[] = [];
  if (c.removed) parts.push(`Removed ${plural(c.removed, 'word')}`);
  if (c.restored) parts.push(`Restored ${plural(c.restored, 'word')}`);
  if (c.added) parts.push(`Added ${plural(c.added, 'word')}`);
  if (c.dropped) parts.push(`Dropped ${plural(c.dropped, 'word')}`);
  if (c.moved) parts.push(`Reordered ${plural(c.moved, 'word')}`);
  if (diff.defaultSpeedFrom !== diff.defaultSpeedTo) {
    parts.push(`Speed ${rate(diff.defaultSpeedFrom)} → ${rate(diff.defaultSpeedTo)}`);
  }
  if (c.spedUp) parts.push(`Sped up ${plural(c.spedUp, 'region')}`);
  if (c.slowed) parts.push(`Slowed ${plural(c.slowed, 'region')}`);
  if (parts.length === 0) return 'No changes';
  return parts.join(' · ');
}

/** Kind of an existing checkpoint, inferred for entries written before `kind` existed. */
export function checkpointKind(cp: Checkpoint, index: number): CheckpointKind {
  if (cp.kind) return cp.kind;
  if (index === 0) return 'original';
  return Array.isArray(cp.ops) ? 'ai' : 'manual';
}

/**
 * Reconstruct the untouched transcript from any edit state.
 *
 * Possible only because deletion is a flag: every baseline word is still in the
 * array. Inserted entries have no baseline slot, so they are dropped. Used to
 * seed checkpoint 0 for an artipod that has been hand-edited but never had an
 * agent run to establish a starting point.
 */
export function reconstructOriginal(words: HistoryWord[]): HistoryWord[] {
  return words
    .filter((w) => !w.inserted && w.originalIndex >= 0)
    .slice()
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((w) => ({ ...w, deleted: false }));
}

/** The persisted shape of edits.json, as far as history cares. */
export interface EditsFile {
  editedWords?: HistoryWord[];
  speedMarkers?: HistorySpeedMarker[];
  defaultSpeed?: number;
  checkpoints?: Checkpoint[];
  /** Which checkpoint the current state corresponds to — the undo/redo cursor. */
  historyIndex?: number;
  savedAt?: string;
}

/**
 * Where the cursor sits, tolerating files written before it existed. A missing
 * cursor means "at the tip", which is true of every history written so far.
 */
export function clampIndex(index: unknown, checkpoints: Checkpoint[]): number {
  const last = checkpoints.length - 1;
  if (last < 0) return -1;
  if (!Number.isInteger(index)) return last;
  return Math.min(Math.max(index as number, 0), last);
}

/**
 * Record a hand edit on the timeline, coalescing a burst of them into one entry.
 *
 * Returns null when the incoming state matches the checkpoint it would be
 * compared against — the editor saves on a debounce and re-saves on load, so
 * most calls are no-ops and must not manufacture empty versions.
 */
export function recordManualEdit(params: {
  existing: EditsFile;
  editedWords: HistoryWord[];
  speedMarkers: HistorySpeedMarker[];
  defaultSpeed: number;
  now: Date;
  maxCheckpoints: number;
}): { checkpoints: Checkpoint[]; historyIndex: number } | null {
  const { existing, editedWords, speedMarkers, defaultSpeed, now, maxCheckpoints } = params;
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  let checkpoints: Checkpoint[] = [...(existing.checkpoints ?? [])];
  let index = clampIndex(existing.historyIndex, checkpoints);

  // An artipod that has only ever been hand-edited has no starting point to
  // compare against. Deletion being a flag means the untouched transcript is
  // recoverable from the current state, so one can always be established.
  if (checkpoints.length === 0) {
    const source = existing.editedWords?.length ? existing.editedWords : editedWords;
    checkpoints.push({
      at: existing.savedAt ?? nowIso,
      label: 'Original transcript',
      kind: 'original',
      editedWords: reconstructOriginal(source),
      speedMarkers: [],
      defaultSpeed: 1,
    });
    index = 0;
  }

  // Editing while rewound abandons the versions ahead of the cursor. That is
  // what redo means everywhere else, and keeping them would turn a list into an
  // unlabelled tree.
  if (index < checkpoints.length - 1) {
    checkpoints = checkpoints.slice(0, index + 1);
  }

  const tail = checkpoints[checkpoints.length - 1];
  const tailIndex = checkpoints.length - 1;
  const tailStarted = Date.parse(tail.startedAt ?? tail.at);
  const tailTouched = Date.parse(tail.at);
  const amend =
    checkpointKind(tail, tailIndex) === 'manual' &&
    !tail.renamed &&
    Number.isFinite(tailTouched) &&
    nowMs - tailTouched < BURST_GAP_MS &&
    (!Number.isFinite(tailStarted) || nowMs - tailStarted < BURST_MAX_MS);

  const candidate: Checkpoint = {
    at: nowIso,
    label: '',
    kind: 'manual',
    editedWords,
    speedMarkers,
    defaultSpeed,
    startedAt: amend ? tail.startedAt ?? tail.at : nowIso,
  };

  // An amendment is measured against what came BEFORE the burst, so the entry
  // always describes the whole burst rather than the last keystroke in it.
  const base = amend ? checkpoints[tailIndex - 1] ?? null : tail;
  const diff = diffCheckpoints(base, candidate);

  if (!hasChanges(diff)) {
    if (!amend) return null;
    // The burst was undone back to where it started; the entry no longer
    // describes anything, so it should not survive.
    checkpoints.splice(tailIndex, 1);
    return { checkpoints, historyIndex: checkpoints.length - 1 };
  }

  candidate.label = describeChanges(diff);
  if (amend) checkpoints[tailIndex] = candidate;
  else checkpoints.push(candidate);

  index = checkpoints.length - 1;
  // Cap the history, but never drop the original — it is the one people reach
  // for when an iteration goes wrong. Evicting shifts everything down one.
  while (checkpoints.length > maxCheckpoints) {
    checkpoints.splice(1, 1);
    index--;
  }
  return { checkpoints, historyIndex: index };
}

/** The complete edit state a checkpoint restores. */
export function snapshotOf(cp: Checkpoint) {
  return {
    editedWords: cp.editedWords ?? [],
    speedMarkers: Array.isArray(cp.speedMarkers) ? cp.speedMarkers : [],
    defaultSpeed: typeof cp.defaultSpeed === 'number' ? cp.defaultSpeed : 1,
  };
}
