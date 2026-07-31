/**
 * Editorial agent — turns a plain-English instruction into an edit.
 *
 * The renderer already does more than the agent used to be able to ask for:
 * export.ts walks the edit list in array order and bakes per-segment speed, so
 * deleting, reordering, and re-timing are all renderable today. This module
 * gives the model that same vocabulary. It rebuilds the silence-inserted
 * baseline the editor starts from (initEditableWords in @mieweb/ui), removes
 * dead air procedurally — no judgment needed, so it costs no model call — and
 * asks for a list of OPERATIONS against the numbered spoken words:
 *
 *   delete from..to          drop a span
 *   speed  from..to at rate  re-time a span (0.5–2, the renderer's range)
 *   move   from..to before K reorder a span
 *
 * Every index refers to the ORIGINAL numbering, and the server resolves them
 * all against one snapshot — models are unreliable at renumbering after their
 * own edits, so they are never asked to. Validation rejects rather than
 * repairs: a half-understood edit applied silently is worse than a clear
 * failure. What comes back is a PROPOSAL written to edits.json and reviewed in
 * the editor; nothing is ever auto-exported.
 *
 * Filler removal is deliberately NOT here. The ✂️ modal already does it
 * deterministically, and whether fillers exist at all depends on the ASR —
 * whisper base.en strips them before this code ever sees the transcript.
 *
 * Provider-pluggable via env so the same endpoint runs against Anthropic or any
 * OpenAI-compatible base. Uses global fetch (Node 18+); no SDK dependency, so
 * the runtime tar and `npm ci --omit=dev` stay untouched.
 */

/** Minimal transcript word shape sent by the client */
export interface TranscriptWordLike {
  text: string;
  startMs: number;
  endMs: number;
  speakerId?: string;
  confidence?: number;
  wordType?: string;
}

/** Edited word, matching @mieweb/ui's EditableWord and what edits.json holds */
export interface EditableWord {
  originalIndex: number;
  deleted?: boolean;
  inserted?: boolean;
  word: {
    text: string;
    startMs: number;
    endMs: number;
    speakerId?: string;
    confidence?: number;
    wordType?: string;
  };
}

// Mirror the editor's silence-detection defaults (DEFAULT_MIN_SILENCE_MS /
// DEFAULT_NL_SILENCE_MS in useTranscriptEdits) so the proposal renders exactly
// like a fresh editor load with silences removed.
const MIN_SILENCE_MS = 400;
const NL_SILENCE_MS = 1500;

/**
 * Ceiling on how much of the spoken track a single request may delete. A real
 * instruction ("cut this to 30 seconds") legitimately removes most of it, so the
 * rail is loose — it exists to catch a model that returns the whole transcript,
 * not to second-guess the edit.
 */
const MAX_DELETE_FRACTION = 0.9;

/** Most ops one response may contain; past this it is flailing, not editing. */
const MAX_OPS = 50;

/** atempo's range, which is also the editor's — see clampSpeed in export.ts */
const MIN_RATE = 0.5;
const MAX_RATE = 2;

const isSilence = (wordType?: string): boolean =>
  wordType === 'silence' || wordType === 'silence-newline';

/**
 * Port of insertSilences (@mieweb/ui): inserts silence pseudo-words for gaps
 * >= MIN_SILENCE_MS (silence-newline for >= NL_SILENCE_MS), including a leading
 * gap before the first word. Kept byte-compatible with the editor so the chips
 * line up.
 */
function insertSilences(words: TranscriptWordLike[]): EditableWord['word'][] {
  if (words.length === 0) return [];
  const result: EditableWord['word'][] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];

    if (i === 0 && word.startMs > MIN_SILENCE_MS) {
      const isNewline = word.startMs >= NL_SILENCE_MS;
      result.push({
        text: `[${(word.startMs / 1000).toFixed(1)}s]`,
        startMs: 0,
        endMs: word.startMs,
        wordType: isNewline ? 'silence-newline' : 'silence',
      });
    }

    result.push({ ...word, wordType: word.wordType ?? 'word' });

    if (i < words.length - 1) {
      const next = words[i + 1];
      const gapMs = next.startMs - word.endMs;
      if (gapMs >= MIN_SILENCE_MS) {
        const isNewline = gapMs >= NL_SILENCE_MS;
        result.push({
          text: `[${(gapMs / 1000).toFixed(1)}s]`,
          startMs: word.endMs,
          endMs: next.startMs,
          wordType: isNewline ? 'silence-newline' : 'silence',
        });
      }
    }
  }

  return result;
}

/** Build the editor's baseline edit list from raw transcript words */
export function buildBaseline(words: TranscriptWordLike[]): EditableWord[] {
  return insertSilences(words).map((word, index) => ({
    originalIndex: index,
    word,
    deleted: false,
  }));
}

// --- Provider configuration ---

export interface AgentConfig {
  provider: 'anthropic' | 'openai';
  base: string;
  apiKey: string;
  model: string;
}

/** Thrown when no LLM is configured (e.g. on the box before a key is seeded) */
export class AgentNotConfiguredError extends Error {}

/**
 * Resolves the LLM provider from env. Explicit AGENT_PROVIDER wins; otherwise an
 * AGENT_API_KEY implies Anthropic and an AGENT_API_BASE implies an
 * OpenAI-compatible endpoint. With nothing set (the dev box before a key
 * lands), throws AgentNotConfiguredError so the endpoint fails with a clear
 * message instead of a network error.
 */
export function resolveAgentConfig(): AgentConfig {
  const explicit = (process.env.AGENT_PROVIDER || '').toLowerCase();
  const apiKey = process.env.AGENT_API_KEY || '';
  const provider =
    explicit ||
    (apiKey ? 'anthropic' : process.env.AGENT_API_BASE ? 'openai' : '');

  if (!provider) {
    throw new AgentNotConfiguredError(
      'The editorial agent is not configured on this server. Set AGENT_PROVIDER + AGENT_API_KEY (Anthropic), or AGENT_API_BASE for an OpenAI-compatible endpoint (e.g. a local Ollama).'
    );
  }

  if (provider === 'anthropic') {
    if (!apiKey) {
      throw new AgentNotConfiguredError(
        'AGENT_PROVIDER=anthropic but AGENT_API_KEY is not set on this server.'
      );
    }
    return {
      provider: 'anthropic',
      base: (process.env.AGENT_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, ''),
      apiKey,
      model: process.env.AGENT_MODEL || 'claude-opus-5',
    };
  }

  if (provider === 'openai') {
    return {
      provider: 'openai',
      // Default to the local Ollama OpenAI-compatible endpoint
      base: (process.env.AGENT_API_BASE || 'http://localhost:11434/v1').replace(/\/+$/, ''),
      apiKey, // Ollama needs none; a real OpenAI base does
      model: process.env.AGENT_MODEL || 'qwen2.5:7b-instruct',
    };
  }

  throw new AgentNotConfiguredError(
    `Unknown AGENT_PROVIDER '${provider}'. Use 'anthropic' or 'openai'.`
  );
}

// LLM calls should never hang the job store; a proposal is not worth more than
// a couple of minutes.
const LLM_TIMEOUT_MS = 120 * 1000;

/**
 * Output ceiling for Anthropic models. It has to cover thinking as well as the
 * answer — models from Sonnet 5 onward think by default and bill it as output —
 * so it is sized well above the JSON an op list actually needs.
 */
const ANTHROPIC_MAX_TOKENS = 8192;

/**
 * The agent edits by issuing the same operations a person performs in the
 * editor. Ranges are inclusive and every index refers to the ORIGINAL numbering
 * shown in the prompt — ops never renumber for each other, so the model does not
 * have to track its own edits mid-list (which it gets wrong). The server
 * resolves all of them against one snapshot.
 */
export type AgentOp =
  | { op: 'delete'; from: number; to: number }
  | { op: 'speed'; from: number; to: number; rate: number }
  | { op: 'move'; from: number; to: number; before: number };

const SYSTEM_PROMPT =
  'You are a video editor working on a short product-demo recording. You receive its transcript ' +
  'as a numbered list of spoken words, and you edit by issuing operations against those numbers.\n\n' +
  'Available operations:\n' +
  '  {"op":"delete","from":N,"to":M}            — remove words N through M (inclusive)\n' +
  '  {"op":"speed","from":N,"to":M,"rate":1.5}  — play words N through M at rate (0.5–2)\n' +
  '  {"op":"move","from":N,"to":M,"before":K}   — move words N through M so they play before word K\n\n' +
  'Rules:\n' +
  '- Every index refers to the ORIGINAL numbering in the list below. Do NOT renumber after an ' +
  'operation; write every op as if the transcript were untouched.\n' +
  '- You are cutting a real recording, so you can only remove, reorder, and re-time existing ' +
  'words. You cannot add words or change what was said.\n' +
  '- Cut whole phrases, never half of one. What remains must read as coherent speech.\n' +
  '- Ranges of the same operation must not overlap, and you cannot move a range you also delete.\n' +
  "- The editor's instruction is the goal. Follow it even when it means cutting substantive " +
  'content. If it is ambiguous, choose the most useful reading and proceed.\n' +
  '- Use as few operations as will do the job.\n\n' +
  'Respond with ONLY a JSON object, no prose, no code fences.';

interface NumberedWord {
  /** Sequential index shown to the LLM */
  num: number;
  /** Position of this word in the baseline EditableWord[] */
  arrayIndex: number;
  text: string;
}

function buildUserPrompt(
  content: NumberedWord[],
  cap: number,
  spokenMs: number,
  instructions: string
): string {
  return [
    `Editor's instruction: ${instructions}`,
    '',
    `The recording runs about ${Math.round(spokenMs / 1000)} seconds across ${content.length} ` +
      'spoken words. Roughly 150 spoken words play in a minute, so use that to judge length ' +
      'targets.',
    '',
    'Transcript words (index: word):',
    content.map((w) => `${w.num}: ${w.text}`).join('\n'),
    '',
    'Return JSON of exactly this shape:',
    '{"ops": [<operations, applied in order>], "summary": "<one short sentence describing the edit>"}',
    `Delete at most ${cap} of the ${content.length} words, and use at most ${MAX_OPS} operations. ` +
      'If the instruction asks for nothing that can be done by deleting, reordering, or re-timing ' +
      'words, return an empty "ops" array and say why in the summary.',
  ].join('\n');
}

/** Extract the first balanced JSON object from a possibly-noisy model reply */
function extractJson(raw: string): any {
  const fenced = raw.replace(/```(?:json)?/gi, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('LLM response contained no JSON object');
  }
  return JSON.parse(fenced.slice(start, end + 1));
}

async function callLLM(config: AgentConfig, systemPrompt: string, userPrompt: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  try {
    if (config.provider === 'anthropic') {
      const res = await fetch(`${config.base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          // Current Claude models think by default, and thinking is billed and
          // budgeted as output. A ceiling sized for the JSON alone gets spent
          // reasoning, and the response comes back with no text block at all.
          max_tokens: ANTHROPIC_MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        signal: controller.signal,
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`Anthropic API ${res.status}: ${data?.error?.message || res.statusText}`);
      }
      const text = Array.isArray(data.content)
        ? data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
        : '';
      if (!text) {
        throw new Error(
          data?.stop_reason === 'max_tokens'
            ? `${config.model} used its entire ${ANTHROPIC_MAX_TOKENS}-token budget before answering. ` +
              'Try a shorter transcript or a simpler instruction.'
            : `${config.model} returned no text (stop_reason: ${data?.stop_reason ?? 'unknown'}).`
        );
      }
      return text;
    }

    // OpenAI-compatible (OpenAI, local Ollama, etc.)
    const res = await fetch(`${config.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`LLM API ${res.status}: ${data?.error?.message || res.statusText}`);
    }
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('LLM API returned no message content');
    return text;
  } catch (err) {
    if ((err as any)?.name === 'AbortError') {
      throw new Error(`LLM request timed out after ${LLM_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export interface AgentEditResult {
  /** The proposed edit list, in playback order */
  editedWords: EditableWord[];
  /** Speed markers derived from any `speed` ops, keyed to the new ordering */
  speedMarkers: { wordIndex: number; speed: number }[];
  summary: string;
  /** The validated ops that produced this proposal — surfaced for review */
  ops: AgentOp[];
  /** Spoken words removed */
  deletedCount: number;
  /** Total spoken (non-silence) words considered */
  contentCount: number;
  /** Silence gaps removed procedurally */
  silenceCount: number;
  provider: string;
  model: string;
}

/** A validation failure the person can act on, as opposed to a transport error */
class AgentProposalError extends Error {}

const isRange = (v: any): boolean =>
  Number.isInteger(v?.from) && Number.isInteger(v?.to) && v.from >= 0 && v.from <= v.to;

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }): boolean =>
  a.from <= b.to && b.from <= a.to;

/**
 * Turns the model's raw reply into ops we are willing to apply. Everything here
 * rejects rather than repairs: a half-understood edit silently applied is worse
 * than a clear failure the person can retry.
 */
function validateOps(raw: unknown, wordCount: number, cap: number): AgentOp[] {
  if (!Array.isArray(raw)) {
    throw new AgentProposalError('The agent did not return an "ops" array.');
  }
  if (raw.length > MAX_OPS) {
    throw new AgentProposalError(
      `The agent returned ${raw.length} operations (limit ${MAX_OPS}). Refusing the proposal.`
    );
  }

  const ops: AgentOp[] = [];
  for (const item of raw as any[]) {
    const kind = item?.op;
    if (kind !== 'delete' && kind !== 'speed' && kind !== 'move') {
      throw new AgentProposalError(`Unknown operation "${kind}".`);
    }
    if (!isRange(item) || item.to >= wordCount) {
      throw new AgentProposalError(
        `Operation "${kind}" has an out-of-range span (${item?.from}–${item?.to}); ` +
          `the transcript has ${wordCount} words.`
      );
    }
    if (kind === 'speed') {
      const rate = Number(item.rate);
      if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
        throw new AgentProposalError(
          `Speed rate ${item.rate} is outside the ${MIN_RATE}–${MAX_RATE} range the renderer supports.`
        );
      }
      ops.push({ op: 'speed', from: item.from, to: item.to, rate });
      continue;
    }
    if (kind === 'move') {
      const before = Number(item.before);
      // `before === wordCount` means "move to the very end".
      if (!Number.isInteger(before) || before < 0 || before > wordCount) {
        throw new AgentProposalError(`Move target ${item.before} is out of range.`);
      }
      if (before > item.from && before <= item.to) {
        throw new AgentProposalError('A move cannot target a position inside the range it moves.');
      }
      ops.push({ op: 'move', from: item.from, to: item.to, before });
      continue;
    }
    ops.push({ op: 'delete', from: item.from, to: item.to });
  }

  // Same-kind overlaps are ambiguous (which rate wins? which move runs first?),
  // and moving something you also delete is incoherent. Both mean the model lost
  // track of its own plan, so neither is worth guessing at.
  for (const kind of ['delete', 'speed', 'move'] as const) {
    const same = ops.filter((o) => o.op === kind);
    for (let i = 0; i < same.length; i++) {
      for (let j = i + 1; j < same.length; j++) {
        if (overlaps(same[i], same[j])) {
          throw new AgentProposalError(
            `Two "${kind}" operations overlap (${same[i].from}–${same[i].to} and ` +
              `${same[j].from}–${same[j].to}).`
          );
        }
      }
    }
  }
  for (const mv of ops.filter((o): o is Extract<AgentOp, { op: 'move' }> => o.op === 'move')) {
    for (const del of ops.filter((o): o is Extract<AgentOp, { op: 'delete' }> => o.op === 'delete')) {
      if (overlaps(mv, del)) {
        throw new AgentProposalError(
          `The agent tried to move words ${mv.from}–${mv.to} that it also deletes.`
        );
      }
    }
  }

  const deleted = ops
    .filter((o) => o.op === 'delete')
    .reduce((n, o) => n + (o.to - o.from + 1), 0);
  if (deleted > cap) {
    throw new AgentProposalError(
      `The agent asked to delete ${deleted} of ${wordCount} words, past the ${cap}-word limit. ` +
        'Refusing the proposal — try a narrower instruction, or a more capable model.'
    );
  }

  return ops;
}

/**
 * Applies validated ops to the baseline.
 *
 * Deletes and speeds are recorded against each word's ORIGINAL number first, so
 * they are immune to the reordering that `move` does. Only then are moves
 * applied to the array, and only then are speed markers derived — because
 * markers are keyed by position in the final array, they cannot be computed
 * until the order is settled.
 */
function applyOps(
  baseline: EditableWord[],
  content: NumberedWord[],
  ops: AgentOp[],
  defaultSpeed: number
): { editedWords: EditableWord[]; speedMarkers: { wordIndex: number; speed: number }[] } {
  const rateByNum = new Map<number, number>();

  for (const op of ops) {
    for (let n = op.from; n <= op.to; n++) {
      if (op.op === 'delete') baseline[content[n].arrayIndex].deleted = true;
      if (op.op === 'speed') rateByNum.set(n, op.rate);
    }
  }

  // Moves operate on entry identity, not index, so earlier moves shifting the
  // array cannot corrupt later ones.
  let order = [...baseline];
  for (const op of ops) {
    if (op.op !== 'move') continue;
    const first = baseline[content[op.from].arrayIndex];
    const last = baseline[content[op.to].arrayIndex];
    const start = order.indexOf(first);
    const end = order.indexOf(last);
    if (start === -1 || end === -1 || end < start) continue;

    const slice = order.slice(start, end + 1);
    const rest = [...order.slice(0, start), ...order.slice(end + 1)];
    // `before === content.length` appends; otherwise land immediately ahead of
    // the target word wherever it now sits.
    const anchor =
      op.before >= content.length ? null : baseline[content[op.before].arrayIndex];
    const at = anchor ? rest.indexOf(anchor) : rest.length;
    rest.splice(at === -1 ? rest.length : at, 0, ...slice);
    order = rest;
  }

  // Derive markers from the settled order. A marker sets the speed from its
  // position onward (see speedAtIndex in export.ts), so one is emitted only
  // where the rate actually changes.
  const numByArrayIndex = new Map(content.map((c) => [c.arrayIndex, c.num]));
  const speedMarkers: { wordIndex: number; speed: number }[] = [];
  let current = defaultSpeed;
  order.forEach((entry, index) => {
    if (entry.deleted) return;
    const num = numByArrayIndex.get(entry.originalIndex);
    if (num === undefined) return; // silence — inherits whatever is in effect
    const rate = rateByNum.get(num) ?? defaultSpeed;
    if (rate !== current) {
      speedMarkers.push({ wordIndex: index, speed: rate });
      current = rate;
    }
  });

  return { editedWords: order, speedMarkers };
}

/**
 * Baseline the model reasons about: silences inserted then procedurally
 * deleted (dead air is never wanted and needs no judgment, so it costs no model
 * call), and the remaining spoken words numbered for the prompt.
 */
function prepare(words: TranscriptWordLike[]) {
  if (!Array.isArray(words) || words.length === 0) {
    throw new Error('No transcript words provided');
  }

  const editedWords = buildBaseline(words);
  let silenceCount = 0;
  for (const ew of editedWords) {
    if (isSilence(ew.word.wordType)) {
      ew.deleted = true;
      silenceCount++;
    }
  }

  const content: NumberedWord[] = [];
  editedWords.forEach((ew, arrayIndex) => {
    if (!isSilence(ew.word.wordType)) {
      content.push({ num: content.length, arrayIndex, text: ew.word.text });
    }
  });

  if (content.length === 0) {
    throw new Error('This transcript has no spoken words to edit.');
  }

  return { editedWords, content, silenceCount };
}

/**
 * Validate and apply an operation list with no model involved. This is the
 * deterministic half of the agent — the same code path the LLM result goes
 * through — so a script can drive an edit directly, and so the applier can be
 * tested without spending a model call.
 */
export function applyAgentOps(
  words: TranscriptWordLike[],
  rawOps: unknown,
  defaultSpeed = 1
): Omit<AgentEditResult, 'summary' | 'provider' | 'model'> {
  const { editedWords, content, silenceCount } = prepare(words);
  const cap = Math.floor(content.length * MAX_DELETE_FRACTION);
  const ops = validateOps(rawOps, content.length, cap);
  const applied = applyOps(editedWords, content, ops, defaultSpeed);

  return {
    editedWords: applied.editedWords,
    speedMarkers: applied.speedMarkers,
    ops,
    deletedCount: editedWords.filter((ew) => ew.deleted && !isSilence(ew.word.wordType)).length,
    contentCount: content.length,
    silenceCount,
  };
}

/**
 * Runs one agent pass: build the editor's baseline, ask the model for an
 * operation list against it, validate, and apply. Throws AgentNotConfiguredError
 * when no LLM is available, or Error on an LLM or validation failure. Never
 * touches persisted state — the caller writes the result and checkpoints it.
 */
export async function generateAgentEdit(opts: {
  words: TranscriptWordLike[];
  instructions: string;
  defaultSpeed?: number;
}): Promise<AgentEditResult> {
  const { words } = opts;
  const instructions = (opts.instructions || '').trim();
  const defaultSpeed = opts.defaultSpeed ?? 1;

  if (!instructions) {
    throw new Error('Tell the agent what to do — an instruction is required.');
  }

  const config = resolveAgentConfig();
  const { content } = prepare(words);
  const cap = Math.floor(content.length * MAX_DELETE_FRACTION);
  const spokenMs = Math.max(0, words[words.length - 1].endMs - words[0].startMs);
  const raw = await callLLM(
    config,
    SYSTEM_PROMPT,
    buildUserPrompt(content, cap, spokenMs, instructions)
  );

  let parsed: any;
  try {
    parsed = extractJson(raw);
  } catch (err) {
    throw new Error(`Could not parse the agent's response as JSON: ${(err as Error).message}`);
  }

  // Same validation and application path a scripted edit takes.
  const applied = applyAgentOps(words, parsed?.ops, defaultSpeed);

  const summary =
    typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : `Applied ${applied.ops.length} operation${applied.ops.length === 1 ? '' : 's'}.`;

  return { ...applied, summary, provider: config.provider, model: config.model };
}
