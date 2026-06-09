# Bleep Word Feature

## Overview
This feature allows users to mark words as "bleeped" (expletives) in transcripts. Bleeped words are highlighted with a distinct visual style and can optionally be removed when using the "Remove Filler Words" feature.

## Features Implemented

### 1. Mark Words as Bleeped
- **Keyboard Shortcut**: Press `B` to toggle the bleeped state of the currently selected word or selection
- **UI Button**: Click the "Bleep" button in the edit bar to mark words as bleeped
- Bleeped words are displayed with:
  - Orange background color (`rgba(255, 152, 0, 0.15)`)
  - Orange border (`1px solid rgba(255, 152, 0, 0.3)`)
  - Bold font weight
  - A mute icon (🔇) indicator

### 2. Visual Styling
Bleeped words have a distinct visual appearance:
- Orange color theme to differentiate from deleted (red) and inserted (green) words
- Mute emoji icon displayed as a badge
- Hover effect for better interactivity

### 3. Remove Expletives in Filler Words Modal
When using the "Remove Filler Words" feature:
- A new checkbox option: "Remove expletives (bleeped words)"
- When checked, all bleeped words will be marked as deleted
- Shows count of bleeped words that will be removed
- Calculates time saved from removing bleeped words

## Usage

### Marking Words as Bleeped
1. Select a word by clicking on it in the transcript
2. Press `B` on your keyboard OR click the "Bleep" button in the edit bar
3. The word will be highlighted in orange with a mute icon
4. To un-bleep, select the word and press `B` again

### Removing Bleeped Words
1. Click the "Remove Filler Words" button (funnel icon) 
2. Check the "Remove expletives (bleeped words)" checkbox
3. The modal will show how many bleeped words will be removed and time saved
4. Click "Mark as Deleted" to remove all selected filler words and bleeped words

## Technical Implementation

### Type Changes
Added `bleeped?: boolean` property to the `EditableWord` interface in `types.ts`

### Keyboard Handling
Added keyboard handler for 'B' key in `TranscriptViewer.tsx` that:
- Toggles the bleeped state on the current word or selection
- Pushes to undo stack for history management
- Works with multi-word selections

### CSS Styling
Added `.transcript-viewer__word--bleeped` class with:
- Orange color scheme
- Border and background styling
- Mute icon badge using ::after pseudo-element

### Modal Integration
Updated `FillerWordsModal` component to:
- Accept `bleepedCount` and `bleepedDurationMs` props
- Add checkbox for removing bleeped words
- Calculate total time saved including bleeped words
- Update `handleRemoveFillers` to process bleeped words

## Example Use Cases

1. **Podcast Editing**: Mark profanity or explicit content that needs to be bleeped in the final edit
2. **Interview Transcripts**: Flag inappropriate language for review
3. **Content Moderation**: Identify and remove offensive language from transcripts
4. **Clean Versions**: Create family-friendly versions by marking and removing expletives

## Future Enhancements

Potential improvements for this feature:
- Automatic profanity detection using a word list
- Audio bleeping effect (replace audio with beep sound)
- Export bleeped word list for review
- Different bleep styles (silent, beep, tone, etc.)
- Import custom expletive word lists
