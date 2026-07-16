# ui-staging

Components staged for [mieweb/ui](https://github.com/mieweb/ui) — developed and tested inside pulseclip, then lifted verbatim into `ui/src/components/` (see [../../../mieui-plan.md](../../../mieui-plan.md)).

Rules for code in this folder:

- Tailwind + `cva` + semantic tokens only — no SCSS, no hardcoded colors
- No imports from pulseclip app code; only `@mieweb/ui` and relative imports within this folder
- Controlled + persistence-agnostic: no fetches, state in/out via props
- Timestamps in **ms**; imperative refs instead of raw DOM media elements
- ARIA labels; user-facing strings externalized

Layout mirrors `ui/src/`:

```
ui-staging/
├── types/            → ui/src/types
├── hooks/            → ui/src/hooks
├── MediaPlayer/      → ui/src/components/MediaPlayer
├── TranscriptView/   → ui/src/components/TranscriptView
└── MediaEditor/      → ui/src/components/MediaEditor
```
