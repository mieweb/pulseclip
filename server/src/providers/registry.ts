import { existsSync } from 'fs';
import { isAbsolute, join, dirname, basename } from 'path';
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

  // Register local Whisper if model path(s) are configured - comma-separated
  // paths each register as their own provider, so the dropdown doubles as a
  // model picker. (Requires whisper-cpp and ffmpeg installed - see README.)
  const whisperModelEnv = process.env.WHISPER_MODEL_PATH;
  if (whisperModelEnv) {
    // Resolve relative paths against the server package root (parent of src/ or dist/)
    const serverRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const modelEntries = whisperModelEnv.split(',').map((s) => s.trim()).filter(Boolean);

    for (const entry of modelEntries) {
      const modelPath = isAbsolute(entry) ? entry : join(serverRoot, entry);

      if (!existsSync(modelPath)) {
        console.warn(`WHISPER_MODEL_PATH entry not found, skipping: ${modelPath}`);
        continue;
      }

      // "ggml-base.en.bin" -> "base.en"
      const modelName = basename(modelPath).replace(/^ggml-/, '').replace(/\.bin$/, '');
      registry.register(
        new WhisperProvider({
          modelPath,
          id: modelEntries.length > 1 ? `whisper-${modelName}` : 'whisper',
          displayName: `Whisper (${modelName})`,
          binPath: process.env.WHISPER_BIN,
          language: process.env.WHISPER_LANGUAGE,
        })
      );
    }
  }

  return registry;
}
