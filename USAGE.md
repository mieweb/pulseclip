# Usage Guide

## Quick Start

### 1. Installation

```bash
git clone <repository-url>
cd voicepoc-
npm install
```

### 2. Configuration

Create environment file:

```bash
cd server
cp .env.example .env
```

Edit `server/.env` and add your AssemblyAI API key:

```bash
ASSEMBLYAI_API_KEY=your_actual_api_key_here
PORT=3001
```

**Get AssemblyAI API Key:**
1. Visit [assemblyai.com](https://www.assemblyai.com/)
2. Sign up for a free account
3. Navigate to your dashboard
4. Copy your API key

### 3. Start Development Servers

From the root directory:

```bash
npm run dev
```

This starts both server (port 3001) and client (port 3000).

### 4. Access the Application

Open your browser to: http://localhost:3000

## Using the Application

### Upload a File

**Method 1: Drag and Drop**
1. Drag an audio or video file onto the upload area
2. Drop to upload

**Method 2: Browse**
1. Click "Browse Files"
2. Select your audio/video file
3. Click "Open"

**Supported Formats:**
- Audio: MP3, WAV, M4A, FLAC, OGG
- Video: MP4, MOV, AVI, WEBM, MKV

### Transcribe

1. Wait for upload to complete
2. Select provider from dropdown (currently only AssemblyAI)
3. Click "Transcribe"
4. Wait for processing (may take 1-3 minutes depending on file length)

### Navigate Transcript

Once transcription is complete:

**Click Any Word:**
- Media player seeks to that word's timestamp
- Playback starts automatically

**Active Word Highlighting:**
- Currently playing word is highlighted in blue
- Hover over words to see timestamp and confidence

**View Raw Data:**
- Click "Raw JSON" toggle
- Inspect original provider response
- Useful for debugging or custom processing

## Tips

### File Size
- Keep files under 1 hour for POC testing
- Longer files take proportionally longer to process

### Audio Quality
- Clear audio produces better transcripts
- Background noise reduces accuracy
- Professional recordings work best

### Speaker Labels
Currently disabled in POC. To enable:
1. Modify transcription request in App.tsx
2. Set `speakerLabels: true`
3. View speaker segments in transcript

## Troubleshooting

### "Failed to load providers"
- Check server is running on port 3001
- Verify ASSEMBLYAI_API_KEY is set in server/.env

### "Transcription failed"
- Verify API key is valid
- Check file format is supported
- Review server logs for details

### Upload hangs
- Check file size (must be < 500MB)
- Verify server is running
- Check network connectivity

### Port already in use
Change ports in:
- `server/.env` (PORT=3001)
- `client/vite.config.ts` (server.port)

## Production Deployment

### Build for Production

```bash
npm run build
```

### Environment Variables

Set in production:
```bash
ASSEMBLYAI_API_KEY=<your_key>
PORT=3001
NODE_ENV=production
```

### Serve

```bash
# Start server
cd server
npm start

# Serve client (use nginx, apache, or hosting service)
cd client/dist
# Serve static files
```

### Recommended Hosting

**Server:**
- Heroku
- Railway
- Google Cloud Run
- AWS Elastic Beanstalk

**Client:**
- Vercel
- Netlify
- AWS S3 + CloudFront
- GitHub Pages (with proxy configuration)

## API Usage

### Direct API Calls

**Upload File:**
```bash
curl -X POST \
  -F "file=@/path/to/audio.mp3" \
  http://localhost:3001/api/upload
```

**Transcribe:**
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "mediaUrl": "http://localhost:3001/uploads/file.mp3",
    "providerId": "assemblyai",
    "options": {
      "speakerLabels": false
    }
  }' \
  http://localhost:3001/api/transcribe
```

**List Providers:**
```bash
curl http://localhost:3001/api/providers
```

## Extending the POC

### Add Custom Provider

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed instructions.

### Customize UI

Edit files in `client/src/components/`:
- `FileUpload.tsx` - Upload interface
- `MediaPlayer.tsx` - Audio/video player
- `TranscriptViewer.tsx` - Transcript display
- `App.tsx` - Main application logic

### Add Features

Common extensions:
- Speaker diarization display
- Word confidence filtering
- Export to SRT/VTT subtitles
- Search within transcript
- Edit transcript words
- Multiple file uploads
- Batch processing

## Security Notes

⚠️ **This is a POC - not production ready**

Before production use:
- Add authentication
- Implement rate limiting
- Add input validation
- Sanitize file uploads
- Use HTTPS
- Implement proper error handling
- Add request logging
- Set up monitoring

## Support

For issues or questions:
1. Check this guide
2. Review [README.md](README.md)
3. Check server logs
4. Open a GitHub issue
