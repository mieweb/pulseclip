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

import { buildExportPlan } from './export.js';

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

/**
 * How close to a declared length target counts as hitting it. Length is the one
 * thing a single-shot model reliably misjudges — it estimates from a word count
 * instead of measuring — so when it states a target we check the real number and
 * hand it back. ±8% is about a five-second window on a minute.
 */
const TARGET_TOLERANCE = 0.08;

/**
 * Total model calls one request may make, including the first. Each extra round
 * is a full call: ~4s and free on Groq, ~25s and real money on Anthropic, which
 * is why the default is one revision rather than a convergence loop.
 */
const maxRounds = (): number => {
  const raw = Number(process.env.AGENT_MAX_ROUNDS);
  return Number.isInteger(raw) && raw >= 1 && raw <= 5 ? raw : 2;
};

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

/** Thrown when a caller-supplied provider is malformed or points somewhere unsafe */
export class AgentConfigRejectedError extends Error {}

/**
 * Hostnames a caller must not be able to aim this server at.
 *
 * A caller-supplied base URL means WE make the outbound request, with our
 * network position — the classic SSRF shape. Blocking loopback, link-local and
 * the private ranges keeps a bring-your-own-key field from becoming a probe for
 * whatever else is reachable from the box.
 *
 * A hostname that RESOLVES into one of these ranges still gets through; closing
 * that needs resolution at connect time, which the platform fetch does not
 * expose. Requiring https narrows it — the response is never returned to the
 * caller verbatim, only parsed as an LLM reply — but it is not nothing, and is
 * the reason this list is a floor rather than the whole defence.
 */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '0.0.0.0' || h === '::') return true;
  // Unique-local and link-local IPv6
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

/** The shape a client may send to use its own LLM account. */
export interface ByoAgentConfig {
  provider?: unknown;
  base?: unknown;
  apiKey?: unknown;
  model?: unknown;
}

/**
 * Validate a caller-supplied provider.
 *
 * Returns null when the caller sent nothing — that is the ordinary case and
 * means "use the server's own configuration". Throws only when they sent
 * something that cannot be honoured, so a typo produces a clear message rather
 * than a silent fallback onto the shared key they were trying not to spend.
 */
export function parseByoConfig(raw: unknown): AgentConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const { provider, base, apiKey, model } = raw as ByoAgentConfig;
  if (!provider && !base && !apiKey && !model) return null;

  const p = String(provider || '').toLowerCase();
  if (p !== 'anthropic' && p !== 'openai') {
    throw new AgentConfigRejectedError(
      "provider must be 'anthropic' or 'openai' (OpenAI-compatible covers Groq, OpenRouter, vLLM, …)."
    );
  }
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) {
    throw new AgentConfigRejectedError('An API key is required to use your own provider.');
  }
  const name = typeof model === 'string' ? model.trim() : '';
  if (!name) {
    throw new AgentConfigRejectedError('A model name is required.');
  }

  const rawBase =
    typeof base === 'string' && base.trim()
      ? base.trim()
      : p === 'anthropic'
        ? 'https://api.anthropic.com'
        : '';
  if (!rawBase) {
    throw new AgentConfigRejectedError('A base URL is required for an OpenAI-compatible provider.');
  }
  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    throw new AgentConfigRejectedError(`Could not read "${rawBase}" as a URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new AgentConfigRejectedError(
      'The base URL must be https — the key travels on it.'
    );
  }
  if (isBlockedHost(url.hostname)) {
    throw new AgentConfigRejectedError(
      `Refusing to call ${url.hostname}: this server will not proxy to private or loopback addresses.`
    );
  }
  return {
    provider: p,
    base: rawBase.replace(/\/+$/, ''),
    apiKey: key,
    model: name,
  };
}

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
const ANTHROPIC_MAX_TOKENS = (() => {
  const raw = Number(process.env.AGENT_MAX_OUTPUT_TOKENS);
  return Number.isInteger(raw) && raw >= 512 ? raw : 32000;
})();
/**
 * Output ceiling for OpenAI-compatible providers. Lower than Anthropic's on
 * purpose: free tiers meter the RESERVATION, not the usage — Groq's 8k
 * tokens-per-minute cap counts prompt + max_tokens, so an 8k ceiling makes
 * every request too large before the model runs at all. 4k leaves room for a
 * ~2k transcript prompt and still covers a reasoning model's thinking.
 * AGENT_MAX_OUTPUT_TOKENS raises it on a paid tier.
 */
const OPENAI_MAX_TOKENS = (() => {
  const raw = Number(process.env.AGENT_MAX_OUTPUT_TOKENS);
  return Number.isInteger(raw) && raw >= 512 ? raw : 4096;
})();

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
  '- Use as few operations as will do the job.\n' +
  '- If the instruction names a length ("under a minute", "about 30 seconds"), put that many ' +
  'seconds in targetSeconds. The result will be measured against it and handed back to you if ' +
  'you miss. Leave it null when no length was asked for.\n\n' +
  'Respond with ONLY a JSON object, no prose, no code fences.';

interface NumberedWord {
  /** Sequential index shown to the LLM */
  num: number;
  /** Position of this word in the baseline EditableWord[] */
  arrayIndex: number;
  text: string;
}

/** The previous turn, replayed so a follow-up instruction has something to build on */
export interface PriorTurn {
  instruction: string;
  ops: AgentOp[];
  durationMs?: number;
}

/** A rejected attempt from this same request, fed back with its measured length */
interface Attempt {
  ops: AgentOp[];
  durationMs: number;
  targetSeconds: number;
}

function buildUserPrompt(opts: {
  content: NumberedWord[];
  cap: number;
  spokenMs: number;
  instructions: string;
  prior?: PriorTurn;
  attempt?: Attempt;
}): string {
  const { content, cap, spokenMs, instructions, prior, attempt } = opts;
  const lines: string[] = [];

  // Memory. Every run re-plans from the original transcript, so a follow-up is a
  // revision of the previous plan rather than a patch on top of its result —
  // which is why showing the old ops is enough for "now make it shorter" to mean
  // something.
  if (prior) {
    lines.push(
      'This is a follow-up. Earlier you were asked:',
      `  "${prior.instruction}"`,
      'and you produced:',
      ...prior.ops.map((o) => `  ${JSON.stringify(o)}`)
    );
    if (prior.durationMs) {
      lines.push(`That edit ran ${(prior.durationMs / 1000).toFixed(0)} seconds.`);
    }
    lines.push(
      'The new instruction below replaces it. Write a complete plan against the original ' +
        'transcript again — do not assume the earlier operations are still applied.',
      ''
    );
  }

  lines.push(
    `Editor's instruction: ${instructions}`,
    '',
    `The recording runs about ${Math.round(spokenMs / 1000)} seconds across ${content.length} ` +
      'spoken words. Roughly 150 spoken words play in a minute, so use that to judge length ' +
      'targets.',
    ''
  );

  // Closed loop. The model estimates length from a word count; this is the
  // measured number from the same planner the renderer uses.
  if (attempt) {
    lines.push(
      'Your previous attempt on THIS instruction was:',
      ...attempt.ops.map((o) => `  ${JSON.stringify(o)}`),
      `It came to ${(attempt.durationMs / 1000).toFixed(0)} seconds, but you were aiming for ` +
        `${attempt.targetSeconds}. ` +
        (attempt.durationMs / 1000 > attempt.targetSeconds
          ? 'Cut more, or speed up more of it.'
          : 'You cut too much — keep more of the recording.'),
      'Return a corrected plan.',
      ''
    );
  }

  lines.push(
    'Transcript words (index: word):',
    content.map((w) => `${w.num}: ${w.text}`).join('\n'),
    '',
    'Return JSON of exactly this shape:',
    '{"ops": [<operations, applied in order>], "summary": "<one short sentence describing the ' +
      'edit>", "targetSeconds": <number, or null if no length was asked for>}',
    `Delete at most ${cap} of the ${content.length} words, and use at most ${MAX_OPS} operations. ` +
      'If the instruction asks for nothing that can be done by deleting, reordering, or re-timing ' +
      'words, return an empty "ops" array and say why in the summary.'
  );

  return lines.join('\n');
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
        // Reasoning models spend output tokens thinking before they answer, so
        // this has to cover both. Without it the provider default applies and a
        // long transcript comes back with an empty answer.
        max_tokens: OPENAI_MAX_TOKENS,
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
    const choice = data?.choices?.[0];
    // Reasoning models (gpt-oss and friends) split their reply: the JSON can
    // land in `reasoning` with `content` empty. Take whichever has text —
    // extractJson pulls the object out of either.
    const text = choice?.message?.content || choice?.message?.reasoning || '';
    if (!text) {
      throw new Error(
        choice?.finish_reason === 'length'
          ? `${config.model} hit its ${OPENAI_MAX_TOKENS}-token limit before answering. ` +
            'Try a shorter transcript or a simpler instruction.'
          : `${config.model} returned no content (finish_reason: ${choice?.finish_reason ?? 'unknown'}).`
      );
    }
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

/** Result of applying an op list — everything that needs no model to produce */
export interface AppliedEdit {
  /** The proposed edit list, in playback order */
  editedWords: EditableWord[];
  /** Speed markers derived from any `speed` ops, keyed to the new ordering */
  speedMarkers: { wordIndex: number; speed: number }[];
  /** The validated ops that produced this proposal — surfaced for review */
  ops: AgentOp[];
  /** Spoken words removed */
  deletedCount: number;
  /** Total spoken (non-silence) words considered */
  contentCount: number;
  /** Silence gaps removed procedurally */
  silenceCount: number;
}

export interface AgentEditResult extends AppliedEdit {
  summary: string;
  /** Rendered length of this proposal, from the same planner export.ts uses */
  durationMs: number;
  /** Length the model was aiming for, when the instruction asked for one */
  targetSeconds: number | null;
  /** Model calls this request made — >1 means it measured a miss and revised */
  rounds: number;
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
): AppliedEdit {
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
  /** The previous run on this artipod, so a follow-up instruction has context */
  prior?: PriorTurn;
  /**
   * A caller's own LLM account, already validated. When present it is used
   * instead of the server's configuration, so the request spends their quota
   * rather than the shared one.
   */
  config?: AgentConfig;
}): Promise<AgentEditResult> {
  const { words, prior } = opts;
  const instructions = (opts.instructions || '').trim();
  const defaultSpeed = opts.defaultSpeed ?? 1;

  if (!instructions) {
    throw new Error('Tell the agent what to do — an instruction is required.');
  }

  const config = opts.config ?? resolveAgentConfig();
  const { content } = prepare(words);
  const cap = Math.floor(content.length * MAX_DELETE_FRACTION);
  const spokenMs = Math.max(0, words[words.length - 1].endMs - words[0].startMs);
  const rounds = maxRounds();

  let attempt: Attempt | undefined;
  let best: (AppliedEdit & { summary: string; durationMs: number }) | null = null;
  let target: number | null = null;
  let used = 0;

  for (let round = 1; round <= rounds; round++) {
    used = round;
    const raw = await callLLM(
      config,
      SYSTEM_PROMPT,
      buildUserPrompt({ content, cap, spokenMs, instructions, prior, attempt })
    );

    let parsed: any;
    try {
      parsed = extractJson(raw);
    } catch (err) {
      throw new Error(`Could not parse the agent's response as JSON: ${(err as Error).message}`);
    }

    // Same validation and application path a scripted edit takes. A validation
    // failure is fatal rather than retried — a malformed plan means the model
    // misunderstood the task, and asking again usually just spends another call.
    const applied = applyAgentOps(words, parsed?.ops, defaultSpeed);
    const { durationMs } = buildExportPlan(
      applied.editedWords,
      applied.speedMarkers,
      defaultSpeed
    );
    const summary =
      typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : `Applied ${applied.ops.length} operation${applied.ops.length === 1 ? '' : 's'}.`;

    best = { ...applied, summary, durationMs };

    const declared = Number(parsed?.targetSeconds);
    target = Number.isFinite(declared) && declared > 0 ? declared : null;

    // No length asked for, nothing measurable to check — one call is the whole job.
    if (target === null) break;

    const drift = Math.abs(durationMs / 1000 - target) / target;
    if (drift <= TARGET_TOLERANCE) {
      if (round > 1) {
        console.log(
          `Agent hit ${(durationMs / 1000).toFixed(0)}s against a ${target}s target on round ${round}`
        );
      }
      break;
    }

    if (round < rounds) {
      console.log(
        `Agent came to ${(durationMs / 1000).toFixed(0)}s against a ${target}s target; revising`
      );
      attempt = { ops: applied.ops, durationMs, targetSeconds: target };
    }
  }

  // The last attempt stands even if it never converged. It is a proposal the
  // person reviews, and a near-miss they can trim by hand beats an error.
  return {
    ...best!,
    targetSeconds: target,
    rounds: used,
    provider: config.provider,
    model: config.model,
  };
}
