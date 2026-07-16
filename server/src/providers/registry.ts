import { existsSync } from 'fs';
import { isAbsolute, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TranscriptionProvider } from '../types/transcription.js';
import { AssemblyAIProvider } from './assemblyai.js';
import { WhisperProvider } from './whisper.js';

export class ProviderRegistry {
  private providers = new Map<string, TranscriptionProvider>();

  register(provider: TranscriptionProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): TranscriptionProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): Array<{ id: string; displayName: string }> {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.id,
      displayName: p.displayName,
    }));
  }
}

// Initialize providers
export function initializeProviders(): ProviderRegistry {
  const registry = new ProviderRegistry();

  // Register AssemblyAI if API key is available
  const assemblyAIKey = process.env.ASSEMBLYAI_API_KEY;
  if (assemblyAIKey) {
    registry.register(new AssemblyAIProvider(assemblyAIKey));
  } else {
    console.warn('ASSEMBLYAI_API_KEY not found in environment');
  }

  // Register local Whisper if a model path is configured
  // (requires whisper-cpp and ffmpeg installed - see README)
  const whisperModelEnv = process.env.WHISPER_MODEL_PATH;
  if (whisperModelEnv) {
    // Resolve relative paths against the server package root (parent of src/ or dist/)
    const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const modelPath = isAbsolute(whisperModelEnv)
      ? whisperModelEnv
      : join(serverRoot, whisperModelEnv);

    if (existsSync(modelPath)) {
      registry.register(
        new WhisperProvider({
          modelPath,
          binPath: process.env.WHISPER_BIN,
          language: process.env.WHISPER_LANGUAGE,
        })
      );
    } else {
      console.warn(`WHISPER_MODEL_PATH set but model not found: ${modelPath}`);
    }
  }

  return registry;
}
