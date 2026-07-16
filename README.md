# Pulse Clip

<img width="600"  alt="Image" src="https://github.com/user-attachments/assets/95389ff7-c1e4-40bb-b195-7623fa02ac38" />

> 📖 **[Implementation Details](IMPLEMENTATION.md)** | 🎯 **[The MIE Way](mie-pulse.md)**

## Features

- 🎙️ **Audio & Video Upload** - Drag and drop support for common formats (MP3, WAV, MP4, MOV)
- 🔌 **Pluggable Providers** - Provider-agnostic architecture (AssemblyAI implemented)
- 📝 **Word-Level Timestamps** - Precise timestamp tracking for every word
- 🎯 **Interactive Transcript** - Click any word to seek media playback
- 🔍 **Raw Data Access** - View original provider responses for debugging
- 🎨 **Normalized Schema** - Provider-agnostic transcript format for UI consistency

## Architecture

```mermaid
graph TB
    Client[React Client]
    Server[Express Server]
    Registry[Provider Registry]
    AI[AssemblyAI Provider]
    
    Client -->|Upload File| Server
    Client -->|Request Transcription| Server
    Server -->|Route to Provider| Registry
    Registry -->|Delegate| AI
    AI -->|Normalize & Return| Server
    Server -->|Transcript + Raw| Client
    
    classDef frontend fill:#e1f5ff,stroke:#01579b
    classDef backend fill:#fff3e0,stroke:#e65100
    classDef provider fill:#f3e5f5,stroke:#4a148c
    
    class Client frontend
    class Server,Registry backend
    class AI provider
```

## Project Structure

```
pulseclip/
├── client/                 # React frontend
│   ├── src/
│   │   ├── components/    # UI components
│   │   │   ├── FileUpload.tsx
│   │   │   ├── MediaPlayer.tsx
│   │   │   └── TranscriptViewer.tsx
│   │   ├── App.tsx        # Main application
│   │   └── types.ts       # TypeScript types
│   └── package.json
├── server/                 # Express backend
│   ├── src/
│   │   ├── providers/     # Transcription providers
│   │   │   ├── assemblyai.ts
│   │   │   └── registry.ts
│   │   ├── types/         # TypeScript types
│   │   │   └── transcription.ts
│   │   ├── cache.ts       # Transcription cache
│   │   ├── featured.ts    # Featured pulses management
│   │   └── index.ts       # Server entry point
│   ├── artipods/          # Artipod storage (gitignored)
│   │   └── {uuid}/        # Each artipod folder contains:
│   │       ├── media.ext      # Original media file
│   │       ├── thumbnail.png  # Thumbnail image
│   │       └── (future: transcript.json, beats.json, short.mp4)
│   ├── data/              # Persistent data
│   │   └── featured.json  # Featured pulses list
│   └── package.json
└── package.json           # Workspace root
```

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- AssemblyAI API key (get one at [assemblyai.com](https://www.assemblyai.com/))

### Installation

1. Clone the repository:
```bash
git clone https://github.com/mieweb/pulseclip.git
cd pulseclip
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables (required — without a `.env` the server defaults to port 3000 and collides with the client dev server):
```bash
cp server/.env.example server/.env
# Edit server/.env and add your ASSEMBLYAI_API_KEY
```

4. Start the development servers:
```bash
# From the root directory
npm run dev
```

This will start:
- Server on http://localhost:3001
- Client on http://localhost:3000

### Usage

1. Open http://localhost:3000 in your browser
2. Drag and drop an audio or video file (or click to browse)
3. Transcription starts automatically after upload (or click "Transcribe" to re-run)
4. Click any word in the transcript to seek to that timestamp

> **Note:** the "Featured Pulses" on the home page reference artipods that live on the
> deployed server — on a fresh local install those links won't resolve until you upload
> your own media.

## API Endpoints

### GET /api/providers
Returns list of available transcription providers.

**Response:**
```json
{
  "providers": [
    {
      "id": "assemblyai",
      "displayName": "AssemblyAI"
    }
  ]
}
```

### POST /api/upload
Upload a media file. Creates a new artipod with a UUID.

**Request:** multipart/form-data with `file` field

**Response:**
```json
{
  "success": true,
  "artipodId": "61dd3471-dd98-4ff3-a5ae-27afee3fc8af",
  "filename": "audio.mp3",
  "url": "/artipods/61dd3471-dd98-4ff3-a5ae-27afee3fc8af/audio.mp3",
  "size": 1234567,
  "mimetype": "audio/mpeg"
}
```

### GET /api/artipod/:artipodId
Get artipod info by UUID.

**Response:**
```json
{
  "success": true,
  "artipodId": "61dd3471-dd98-4ff3-a5ae-27afee3fc8af",
  "filename": "audio.mp3",
  "url": "/artipods/61dd3471-dd98-4ff3-a5ae-27afee3fc8af/audio.mp3",
  "size": 1234567,
  "thumbnail": "/artipods/61dd3471-dd98-4ff3-a5ae-27afee3fc8af/thumbnail.png"
}
```

### POST /api/transcribe
Transcribe media file using selected provider.

**Request:**
```json
{
  "mediaUrl": "/artipods/61dd3471-dd98-4ff3-a5ae-27afee3fc8af/audio.mp3",
  "providerId": "assemblyai",
  "options": {
    "speakerLabels": false
  }
}
```

**Response:**
```json
{
  "success": true,
  "provider": {
    "id": "assemblyai",
    "displayName": "AssemblyAI"
  },
  "transcript": {
    "durationMs": 120000,
    "words": [
      {
        "text": "Hello",
        "startMs": 100,
        "endMs": 500,
        "confidence": 0.95
      }
    ]
  },
  "raw": { /* Original provider response */ }
}
```

For files larger than 100MB the server responds `202` with a `jobId` instead and
transcribes in the background:

```json
{
  "success": true,
  "status": "processing",
  "jobId": "0b0e...",
  "message": "This file is large and may take several minutes to transcribe. You can check back shortly."
}
```

### GET /api/transcribe/status/:jobId
Poll an async transcription job. Returns `{ "status": "processing" }` until done, then
the same payload as a synchronous transcription (or `{ "status": "error", ... }`).

## Normalized Transcript Schema

The system uses a provider-agnostic schema:

```typescript
interface Transcript {
  durationMs: number;
  speakers?: Speaker[];
  words: TranscriptWord[];
  segments?: TranscriptSegment[];
}

interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
  speakerId?: string;
  confidence?: number;
}
```

## Adding New Providers

To add a new transcription provider:

1. Create a new provider class in `server/src/providers/`:

```typescript
import { TranscriptionProvider, ProviderResult } from '../types/transcription';

export class MyProvider implements TranscriptionProvider {
  id = 'my-provider';
  displayName = 'My Provider';
  
  async transcribe(mediaUrl: string, options?: any): Promise<ProviderResult> {
    // Call provider API
    const response = await callProviderAPI(mediaUrl);
    
    // Normalize to common schema
    const normalized = this.normalize(response);
    
    return {
      normalized,
      raw: response
    };
  }
  
  private normalize(response: any): Transcript {
    // Convert provider response to normalized schema
  }
}
```

2. Register the provider in `server/src/providers/registry.ts`:

```typescript
export function initializeProviders(): ProviderRegistry {
  const registry = new ProviderRegistry();
  
  // Register new provider
  const myProviderKey = process.env.MY_PROVIDER_API_KEY;
  if (myProviderKey) {
    registry.register(new MyProvider(myProviderKey));
  }
  
  return registry;
}
```

## Future Extensions

- Google Medical STT provider integration
- Speaker diarization visualization
- Word-level editing capabilities
- Server-side timestamp alignment verification
- Export to EDL/subtitle formats
- HIPAA-grade deployment with BAA-covered providers

## License

ISC

