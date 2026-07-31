/**
 * Editorial agent — proposes content deletions for a transcript.
 *
 * The renderer (export.ts) and editor already turn a deleted-word list into a
 * cut. This module produces that list from an LLM: it rebuilds the same
 * silence-inserted baseline the editor starts from (initEditableWords in
 * @mieweb/ui), procedurally deletes the silences, then asks an LLM which
 * spoken words to drop (fillers, false starts, repeats). The result is written
 * to edits.json as a PROPOSAL — a human reviews it in the editor and can undo
 * it in one step; nothing is ever auto-exported.
 *
 * Provider-pluggable via env so the same endpoint runs against Anthropic (real
 * editorial judgment) or any OpenAI-compatible base — local Ollama is the
 * zero-key dev fallback. Uses global fetch (Node 18+); no SDK dependency, so
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
 * Bound on how much the agent may cut. The default pass is conservative — it is
 * only removing disfluencies, so needing more than half the words means
 * something went wrong. A directed edit ("cut this to 60 seconds") legitimately
 * removes far more, so it gets a looser rail that still catches a model that
 * returns every index.
 */
const MAX_DELETE_FRACTION = 0.5;
const DIRECTED_MAX_DELETE_FRACTION = 0.9;

/**
 * Longest unbroken run of deleted words tolerated on a cleanup pass. Fillers and
 * false starts come out in ones and twos; even a rambling self-correction is a
 * handful. Fifteen consecutive words is a sentence or two of real speech, which
 * a pass told to remove only disfluencies should never produce. A DIRECTED pass
 * is exempt — "drop the part about pricing" is *supposed* to cut one long block.
 */
const DEGENERATE_RUN_WORDS = 15;

/** Share of deletions in a single run that marks an over-cap response as a runaway */
const SINGLE_BLOCK_FRACTION = 0.9;

/** Length of the longest consecutive run in a sorted, deduped index list */
function longestRunLength(sorted: number[]): number {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    run = i > 0 && sorted[i] === sorted[i - 1] + 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  return longest;
}

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

const BASE_PROMPT =
  'You are a meticulous video editor tightening the spoken track of a short product-demo video. ' +
  'You receive the transcript as a numbered list of words. Decide which words to DELETE. ' +
  'The result is a cut of the original recording, so you can only remove words — you cannot ' +
  'add or reorder them. Never leave a dangling or ungrammatical fragment: cut whole phrases ' +
  'rather than stranding half of one. ' +
  'Respond with ONLY a JSON object, no prose, no code fences.';

/** Default pass: no direction given, so only disfluencies come out. */
const CLEANUP_PROMPT =
  ' Delete ONLY: filler words (um, uh, er, like, you know, I mean, sort of), false starts and ' +
  'self-corrections, verbatim repeated words or phrases, and clearly redundant restatements. ' +
  'NEVER delete words that carry meaning. When unsure, KEEP the word — under-editing is far ' +
  'better than cutting real content. Deleting nothing is a valid answer.';

/**
 * Directed pass: the person asked for something specific. Their instruction
 * outranks the conservative default — "cut this to 60 seconds" or "drop the
 * part about pricing" REQUIRES removing meaningful content, so the cleanup
 * rule above would sabotage it.
 */
const DIRECTED_PROMPT =
  " The editor's instructions are the goal and take priority: follow them even when doing so " +
  'means cutting substantive content. Still remove obvious fillers and false starts along the ' +
  'way, and keep what remains coherent and worth watching on its own. If the instructions ask ' +
  'for a target length, estimate from the timestamps that roughly 150 spoken words run one ' +
  'minute. If they are ambiguous, choose the most useful reading and proceed.';

const buildSystemPrompt = (hasInstructions: boolean): string =>
  BASE_PROMPT + (hasInstructions ? DIRECTED_PROMPT : CLEANUP_PROMPT);

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
  instructions?: string
): string {
  const list = content.map((w) => `${w.num}: ${w.text}`).join('\n');
  const lines: string[] = [];
  if (instructions && instructions.trim()) {
    lines.push(`Editor's instructions: ${instructions.trim()}`, '');
  }
  if (spokenMs > 0) {
    lines.push(
      `The recording currently runs about ${Math.round(spokenMs / 1000)} seconds ` +
        `across ${content.length} spoken words.`,
      ''
    );
  }
  lines.push(
    'Transcript words (index: word):',
    list,
    '',
    'Return JSON of exactly this shape:',
    '{"delete": [<integers, the indices of words to delete>], "summary": "<one short sentence describing what you cut>"}',
    `Delete at most ${cap} words. If nothing should be cut, return an empty "delete" array.`
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
          max_tokens: 2048,
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
      if (!text) throw new Error('Anthropic API returned no text content');
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
  /** The proposed edit list (silences deleted + LLM content deletions) */
  editedWords: EditableWord[];
  summary: string;
  /** Number of spoken words the LLM chose to delete */
  deletedCount: number;
  /** Total spoken (non-silence) words considered */
  contentCount: number;
  /** Number of silence gaps removed procedurally */
  silenceCount: number;
  provider: string;
  model: string;
}

/**
 * Runs the full agent pass on raw transcript words:
 *   baseline (with silences) -> delete silences -> LLM picks content cuts ->
 *   validate (in-range, unique, <= 50% cap) -> apply.
 * Throws AgentNotConfiguredError when no LLM is available, or Error on an LLM /
 * validation failure. Never mutates persisted state — the caller writes the
 * result to edits.json with the prior state kept as an undo snapshot.
 */
export async function generateAgentEdit(opts: {
  words: TranscriptWordLike[];
  instructions?: string;
}): Promise<AgentEditResult> {
  const { words, instructions } = opts;
  if (!Array.isArray(words) || words.length === 0) {
    throw new Error('No transcript words provided');
  }

  const config = resolveAgentConfig();

  // Baseline with silences, then procedurally delete the silences
  const editedWords = buildBaseline(words);
  let silenceCount = 0;
  for (const ew of editedWords) {
    if (isSilence(ew.word.wordType)) {
      ew.deleted = true;
      silenceCount++;
    }
  }

  // Number the spoken words for the LLM, mapping each number back to its slot
  const content: NumberedWord[] = [];
  editedWords.forEach((ew, arrayIndex) => {
    if (!isSilence(ew.word.wordType)) {
      content.push({ num: content.length, arrayIndex, text: ew.word.text });
    }
  });

  if (content.length === 0) {
    return {
      editedWords,
      summary: 'No spoken words to edit.',
      deletedCount: 0,
      contentCount: 0,
      silenceCount,
      provider: config.provider,
      model: config.model,
    };
  }

  const directed = Boolean(instructions && instructions.trim());
  const cap = Math.floor(
    content.length * (directed ? DIRECTED_MAX_DELETE_FRACTION : MAX_DELETE_FRACTION)
  );
  const spokenMs = Math.max(0, words[words.length - 1].endMs - words[0].startMs);

  const raw = await callLLM(
    config,
    buildSystemPrompt(directed),
    buildUserPrompt(content, cap, spokenMs, instructions)
  );

  let parsed: any;
  try {
    parsed = extractJson(raw);
  } catch (err) {
    throw new Error(`Could not parse the agent's response as JSON: ${(err as Error).message}`);
  }

  // Validate: in-range unique integers, within the cap chosen above
  const seen = new Set<number>();
  const rawDelete: unknown[] = Array.isArray(parsed?.delete) ? parsed.delete : [];
  const chosen: number[] = [];
  for (const value of rawDelete) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(n) || n < 0 || n >= content.length || seen.has(n)) continue;
    seen.add(n);
    chosen.push(n);
  }
  chosen.sort((a, b) => a - b);

  // Shape check. A model that stops selecting and starts counting emits one
  // unbroken run of indices — the deletions stop describing an edit and just
  // describe a range. Truncating that to the cap doesn't rescue it, it just
  // makes an arbitrary cut somewhere in the middle of a sentence, so fail loudly
  // instead. See DEGENERATE_RUN_WORDS for why the two rules differ.
  const runs = longestRunLength(chosen);
  if (chosen.length > 0) {
    const singleBlock = runs >= chosen.length * SINGLE_BLOCK_FRACTION;
    if (!directed && runs >= DEGENERATE_RUN_WORDS) {
      throw new Error(
        `The agent returned ${runs} consecutive words to delete, which is a block of speech rather ` +
          `than filler. Refusing the proposal — try again, or use a more capable model.`
      );
    }
    if (chosen.length > cap && singleBlock) {
      throw new Error(
        `The agent asked to delete ${chosen.length} of ${content.length} words as one unbroken run, ` +
          `past the ${cap}-word limit. That is a runaway response, not an edit. Refusing the ` +
          `proposal — try again, or use a more capable model.`
      );
    }
  }

  if (chosen.length > cap) {
    console.warn(
      `Agent proposed ${chosen.length} deletions; capping to ${cap} of ${content.length} spoken words`
    );
    chosen.length = cap;
  }

  // Apply content deletions onto the baseline
  for (const num of chosen) {
    editedWords[content[num].arrayIndex].deleted = true;
  }

  const summary =
    typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : chosen.length > 0
      ? `Removed ${chosen.length} filler/redundant word${chosen.length === 1 ? '' : 's'} and ${silenceCount} silence${silenceCount === 1 ? '' : 's'}.`
      : `Removed ${silenceCount} silence${silenceCount === 1 ? '' : 's'}; no content changes.`;

  return {
    editedWords,
    summary,
    deletedCount: chosen.length,
    contentCount: content.length,
    silenceCount,
    provider: config.provider,
    model: config.model,
  };
}
