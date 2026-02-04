# Contributing to Voice Transcription POC

Thank you for your interest in contributing!

## Development Setup

1. Fork and clone the repository
2. Install dependencies: `npm install`
3. Set up environment variables (see server/.env.example)
4. Start development: `npm run dev`

## Adding a New Transcription Provider

To add a new provider (e.g., Google Medical STT):

### 1. Create Provider Class

Create `server/src/providers/google-medical.ts`:

```typescript
import { TranscriptionProvider, ProviderResult, Transcript } from '../types/transcription';

export class GoogleMedicalProvider implements TranscriptionProvider {
  id = 'google-medical';
  displayName = 'Google Medical STT';
  
  constructor(private credentials: any) {}
  
  async transcribe(mediaUrl: string, options?: any): Promise<ProviderResult> {
    // 1. Call Google Medical STT API
    const response = await this.callGoogleAPI(mediaUrl, options);
    
    // 2. Normalize response
    const normalized = this.normalize(response);
    
    return { normalized, raw: response };
  }
  
  private normalize(response: any): Transcript {
    // Convert Google's response to our normalized schema
    const words = response.results
      .flatMap(result => result.alternatives[0].words)
      .map(word => ({
        text: word.word,
        startMs: parseFloat(word.startTime) * 1000,
        endMs: parseFloat(word.endTime) * 1000,
        confidence: word.confidence,
      }));
    
    return {
      durationMs: this.calculateDuration(words),
      words,
    };
  }
}
```

### 2. Register Provider

Update `server/src/providers/registry.ts`:

```typescript
import { GoogleMedicalProvider } from './google-medical.js';

export function initializeProviders(): ProviderRegistry {
  const registry = new ProviderRegistry();
  
  // Existing providers...
  
  // Add Google Medical
  const googleCreds = process.env.GOOGLE_CREDENTIALS_PATH;
  if (googleCreds) {
    registry.register(new GoogleMedicalProvider(googleCreds));
  }
  
  return registry;
}
```

### 3. Add Environment Variable

Update `server/.env.example`:

```bash
GOOGLE_CREDENTIALS_PATH=/path/to/credentials.json
```

### 4. Test

```bash
npm run dev
# Provider should appear in dropdown
```

## Code Style

- Use TypeScript strict mode
- Follow existing naming conventions
- Use meaningful variable names (not single letters)
- Add JSDoc comments for complex functions
- Keep functions small and focused

## Testing

Currently, this is a POC without automated tests. When adding tests:

- Test provider normalization thoroughly
- Test API endpoints
- Test UI component interactions
- Mock external API calls

## Pull Request Process

1. Create a feature branch
2. Make your changes
3. Update documentation
4. Submit PR with clear description
5. Address review feedback

## License

By contributing, you agree to license your contributions under the ISC license.
