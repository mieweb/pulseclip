/**
 * Bring-your-own LLM account.
 *
 * The shared lane on this server is rate-limited and paid for by whoever runs
 * it, so anyone doing real work should be able to spend their own instead. The
 * key lives in this browser only: it is sent with the request that uses it and
 * never written to the artipod, the edit history, or the server's logs.
 *
 * localStorage rather than sessionStorage because re-entering a key every tab
 * is the reason people give up and use the shared lane.
 */

const STORAGE_KEY = 'pulseclip_agent_provider';

export interface AgentProvider {
  /** 'openai' covers every OpenAI-compatible base — Groq, OpenRouter, vLLM, … */
  provider: 'openai' | 'anthropic';
  base: string;
  apiKey: string;
  model: string;
}

/** Presets for the endpoints people actually use, so nobody types a base URL. */
export const PROVIDER_PRESETS: {
  id: string;
  label: string;
  provider: 'openai' | 'anthropic';
  base: string;
  model: string;
  hint: string;
}[] = [
  {
    id: 'groq',
    label: 'Groq',
    provider: 'openai',
    base: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    hint: 'Free tier. Fast, and handles the edit format well.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    provider: 'anthropic',
    base: 'https://api.anthropic.com',
    model: 'claude-sonnet-5',
    hint: 'Best edits here, but slower — around a minute or two per run.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    base: 'https://api.openai.com/v1',
    model: 'gpt-5',
    hint: '',
  },
  {
    id: 'custom',
    label: 'Other',
    provider: 'openai',
    base: '',
    model: '',
    hint: 'Any OpenAI-compatible endpoint. Must be https.',
  },
];

export function loadAgentProvider(): AgentProvider | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.apiKey || !p?.model) return null;
    if (p.provider !== 'openai' && p.provider !== 'anthropic') return null;
    return p as AgentProvider;
  } catch {
    return null;
  }
}

export function saveAgentProvider(p: AgentProvider): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* private browsing, quota — the request still works, it just won't persist */
  }
}

export function clearAgentProvider(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

/** Show a key as its last four characters, so it can be recognised but not read. */
export function maskKey(key: string): string {
  if (key.length <= 4) return '••••';
  return `••••${key.slice(-4)}`;
}
