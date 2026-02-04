import { TranscriptionProvider } from '../types/transcription.js';
import { AssemblyAIProvider } from './assemblyai.js';

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

  return registry;
}
