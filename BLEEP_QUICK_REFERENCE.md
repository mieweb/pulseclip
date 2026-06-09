# Bleep Word Feature - Quick Reference

## Feature at a Glance

### What It Does
Allows users to mark words as "bleeped" (expletives) and optionally remove them in bulk alongside filler words and silences.

### How to Use

#### Mark a Word as Bleeped
```
1. Click word → 2. Press 'B' → 3. Word turns orange with 🔇
```

#### Remove All Bleeped Words
```
1. Click 🗑️ → 2. Check "Remove expletives" → 3. Click "Mark as Deleted"
```

## Visual States

### Before Bleeping
```
Hello world damn it works fine
      ^^^^^    ^^^^^           ← Words to bleep
```

### After Marking as Bleeped
```
Hello world [damn]🔇 it [works]🔇 fine
            └─ Orange, bold, bordered ─┘
```

### After Removing Expletives
```
Hello world ̶d̶a̶m̶n̶ it ̶w̶o̶r̶k̶s̶ fine
            └─ Deleted (red) ─┘
```

## Button Layout

```
┌───────────────────────────────────────────────────────┐
│ Transcript Viewer - Edit Mode                         │
├───────────────────────────────────────────────────────┤
│  Edit ↵ | Del ⌫ | Bleep B | Cut ⌘X | Paste | Undo    │
│         └─────────┴─────────┘                         │
│           Toggle States                               │
└───────────────────────────────────────────────────────┘
```

## Modal: Remove Filler Words

```
┌─────────────────────────────────────────┐
│  Remove Filler Words              [×]   │
├─────────────────────────────────────────┤
│  [Search filler words...]               │
│                                         │
│  ☐ Remove silences > [0.4s ▼]          │
│  ☑ Remove expletives (5 bleeped) ← NEW │
│                                         │
│  Select All | Select None               │
│                                         │
│  ☑ um (3)    ☑ uh (5)    ☑ like (8)   │
│  ☐ you know  ☐ actually  ☐ basically   │
│                                         │
│  [+ Add custom...]              [Add]   │
├─────────────────────────────────────────┤
│  18 items • saves 15s → 1:25            │
│                    [Cancel] [Apply]     │
└─────────────────────────────────────────┘
```

## Keyboard Shortcuts

| Key | Action | Works With |
|-----|--------|------------|
| `B` | Toggle bleep state | Single word or selection |
| `Del` / `⌫` | Toggle delete state | Single word or selection |
| `⌘X` | Cut selection | Selection only |
| `⌘V` | Paste | At cursor |
| `⌘Z` | Undo | All actions |
| `Enter` | Edit word | Single word |

## Implementation Checklist

### Core Feature
- [x] Add `bleeped` property to type definition
- [x] Implement keyboard handler for 'B' key
- [x] Add "Bleep" button to UI
- [x] Create CSS styling with orange theme
- [x] Add mute icon (🔇) indicator

### Modal Integration
- [x] Add "Remove expletives" checkbox
- [x] Calculate bleeped word count
- [x] Calculate time saved from removal
- [x] Process bleeped words in removal handler

### Code Quality
- [x] Extract shared toggle function
- [x] Optimize with useMemo
- [x] Follow existing patterns
- [x] Pass code review
- [x] Pass security scan

## Code Patterns

### Setting Bleeped State
```typescript
// Single word
editedWord.bleeped = true;

// Multiple words via selection
for (let i = selection.start; i <= selection.end; i++) {
  editedWords[i].bleeped = true;
}
```

### Checking Bleeped State
```typescript
if (editedWord.bleeped && !editedWord.deleted) {
  // Word is bleeped but not deleted
}
```

### Rendering Bleeped Words
```typescript
const isBleeped = editedWord.bleeped;
className={`word ${isBleeped ? 'word--bleeped' : ''}`}
```

## CSS Classes

```css
.transcript-viewer__word--bleeped {
  /* Orange theme */
  color: #ff9800;
  background: rgba(255, 152, 0, 0.15);
  border: 1px solid rgba(255, 152, 0, 0.3);
  font-weight: 600;
}

.transcript-viewer__word--bleeped::after {
  /* Mute icon badge */
  content: '🔇';
}
```

## Word State Precedence

When rendering a word, states are applied in this order:

1. **Base**: Normal word styling
2. **Active**: Currently playing (blue highlight)
3. **Cursor**: Has keyboard focus (border)
4. **Selected**: In selection range (highlight)
5. **Bleeped**: Marked as expletive (orange) ← NEW
6. **Deleted**: Marked for removal (red, strikethrough)
7. **Inserted**: Pasted from clipboard (green)

Note: Deleted takes precedence over bleeped in visual display.

## API Reference

### Type Definition
```typescript
interface EditableWord {
  originalIndex: number;
  word: TranscriptWord;
  deleted: boolean;
  inserted?: boolean;
  bleeped?: boolean;  // ← NEW
}
```

### Function Signature
```typescript
toggleWordBleeped(
  index: number | null, 
  selection: { start: number; end: number } | null,
  source: string
): void
```

### Hook Usage
```typescript
const bleepedStats = useMemo(() => {
  // Calculate count and duration
  return { count, durationMs };
}, [editedWords]);
```

## Testing Scenarios

### Scenario 1: Mark Single Word
1. Click "damn" in transcript
2. Press 'B'
3. ✅ Word turns orange with 🔇
4. Press 'B' again
5. ✅ Word returns to normal

### Scenario 2: Mark Multiple Words
1. Click "damn"
2. Shift+Click "hell"
3. Press 'B'
4. ✅ Both words turn orange

### Scenario 3: Remove Bleeped Words
1. Mark several words as bleeped
2. Open filler words modal
3. Check "Remove expletives"
4. ✅ Shows count: "(5 bleeped words)"
5. Click "Mark as Deleted"
6. ✅ All bleeped words now deleted

### Scenario 4: Undo
1. Mark words as bleeped
2. Click "Undo" or press ⌘Z
3. ✅ Words return to previous state

## Metrics

**Lines of Code Changed:**
- Types: +2 lines
- Component Logic: ~50 lines
- Styling: ~30 lines
- Documentation: ~300 lines

**Bundle Size Impact:**
- Negligible (< 1KB gzipped)
- No new dependencies

**Performance:**
- Optimized with useMemo
- No noticeable impact on rendering

## Success Criteria

- ✅ Users can mark words as bleeped
- ✅ Bleeped words have distinct visual appearance
- ✅ Bleeped words can be bulk removed
- ✅ Feature integrates with existing workflows
- ✅ Code follows project conventions
- ✅ No security vulnerabilities
- ✅ Documentation is comprehensive
