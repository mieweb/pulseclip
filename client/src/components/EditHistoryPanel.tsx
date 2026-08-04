/**
 * Edit history — one timeline for AI runs and hand edits alike.
 *
 * Deliberately ONE list rather than two. They are edits to the same document,
 * so two lists would mean two competing notions of "current", and restoring in
 * one would silently invalidate the other's position. The kind is a badge and a
 * filter instead.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@mieweb/ui/components/Button';
import { Badge } from '@mieweb/ui/components/Badge';
import { Card, CardContent } from '@mieweb/ui/components/Card';
import { Input } from '@mieweb/ui/components/Input';
import { ScrollArea } from '@mieweb/ui/components/ScrollArea';
import { Separator } from '@mieweb/ui/components/Separator';
import { Tabs, TabsList, TabsTrigger } from '@mieweb/ui/components/Tabs';
import { Spinner } from '@mieweb/ui/components/Spinner';
import { Tooltip } from '@mieweb/ui/components/Tooltip';
import {
  History,
  Sparkles,
  Hand,
  CircleDot,
  Pencil,
  RotateCcw,
  X,
  ArrowLeftRight,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';

export type CheckpointKind = 'original' | 'ai' | 'manual';

export interface CheckpointMeta {
  index: number;
  at: string;
  label: string;
  kind: CheckpointKind;
  summary?: string;
  renamed?: boolean;
  opCount?: number;
  durationMs?: number;
  wordCount?: number;
}

export interface WordChange {
  originalIndex: number;
  text: string;
  wordType?: string;
  change: 'added' | 'dropped' | 'removed' | 'restored' | 'unchanged';
  moved: boolean;
  deleted: boolean;
  speedFrom?: number;
  speedTo?: number;
}

export interface DiffCounts {
  removed: number;
  restored: number;
  added: number;
  dropped: number;
  moved: number;
  spedUp: number;
  slowed: number;
}

export interface CheckpointDiff {
  index: number;
  label: string;
  kind: CheckpointKind;
  words: WordChange[];
  counts: DiffCounts;
  defaultSpeedFrom: number;
  defaultSpeedTo: number;
}

interface EditHistoryPanelProps {
  checkpoints: CheckpointMeta[];
  /** Which checkpoint the current edit state corresponds to. */
  historyIndex: number;
  artipodId: string;
  apiKey: string;
  onRestore: (index: number) => void;
  restoringIndex: number | null;
  onRenamed: () => void;
  onClose: () => void;
}

type Filter = 'all' | 'ai' | 'manual';

const KIND: Record<CheckpointKind, { label: string; Icon: typeof Sparkles }> = {
  original: { label: 'Original', Icon: CircleDot },
  ai: { label: 'AI', Icon: Sparkles },
  manual: { label: 'By hand', Icon: Hand },
};

function timeOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function rate(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0+$/, '')}×`;
}

function hasAnyChange(counts: DiffCounts, speedFrom: number, speedTo: number): boolean {
  return (
    counts.removed > 0 ||
    counts.restored > 0 ||
    counts.added > 0 ||
    counts.dropped > 0 ||
    counts.moved > 0 ||
    counts.spedUp > 0 ||
    counts.slowed > 0 ||
    speedFrom !== speedTo
  );
}

/**
 * The diff, rendered as the transcript itself.
 *
 * Colour carries what happened to a word; a word can also have moved or been
 * re-timed at the same time, so those are separate marks rather than more
 * colours. The dotted underline for a re-timed word is the same convention the
 * editor already uses for a sped-up region.
 */
function DiffView({ diff }: { diff: CheckpointDiff }) {
  const [changesOnly, setChangesOnly] = useState(false);
  const c = diff.counts;

  const interesting = (w: WordChange) =>
    w.change !== 'unchanged' || w.moved || w.speedTo !== undefined;
  const shown = changesOnly ? diff.words.filter(interesting) : diff.words;
  const nothing = !hasAnyChange(c, diff.defaultSpeedFrom, diff.defaultSpeedTo);

  return (
    <div className="mt-3">
      <Separator className="mb-3" />
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {c.removed > 0 && <Badge variant="danger" size="sm">{c.removed} cut</Badge>}
        {c.restored + c.added > 0 && (
          <Badge variant="success" size="sm">{c.restored + c.added} back</Badge>
        )}
        {c.moved > 0 && (
          <Badge
            variant="outline"
            size="sm"
            className="border-purple-400 text-purple-700 dark:text-purple-300"
            icon={<ArrowLeftRight className="h-3 w-3" />}
          >
            {c.moved} moved
          </Badge>
        )}
        {c.spedUp > 0 && <Badge variant="warning" size="sm">{c.spedUp} sped up</Badge>}
        {c.slowed > 0 && <Badge variant="secondary" size="sm">{c.slowed} slowed</Badge>}
        {diff.defaultSpeedFrom !== diff.defaultSpeedTo && (
          <Badge variant="warning" size="sm">
            {rate(diff.defaultSpeedFrom)} → {rate(diff.defaultSpeedTo)}
          </Badge>
        )}
        {!nothing && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto shrink-0"
            onClick={() => setChangesOnly((v) => !v)}
          >
            {changesOnly ? 'All words' : 'Changes only'}
          </Button>
        )}
      </div>

      {nothing ? (
        <p className="m-0 text-xs text-muted-foreground">
          This version has the same edits as the one before it.
        </p>
      ) : (
        <ScrollArea className="max-h-64 rounded-lg bg-muted/40 p-2">
          <p className="m-0 text-sm leading-relaxed">
            {shown.map((w, i) => {
              const isSilence = w.wordType?.startsWith('silence');
              const marks: string[] = [];
              // Colour = what happened to the word itself.
              if (w.change === 'removed' || w.change === 'dropped') {
                marks.push('text-red-700 dark:text-red-400 line-through');
              } else if (w.change === 'restored' || w.change === 'added') {
                marks.push('text-green-700 dark:text-green-400 font-medium');
              } else if (w.deleted) {
                // Already cut before this version and still cut — context, not news.
                marks.push('text-muted-foreground/50 line-through');
              } else {
                marks.push('text-muted-foreground');
              }
              // Marks = things that can happen alongside a colour change, so
              // they cannot reuse red or green. Purple is not a brand token,
              // which is the point: a moved word is often ALSO restored, and
              // the two have to stay tellable apart.
              if (w.moved) {
                marks.push(
                  'rounded-sm bg-purple-100 ring-1 ring-purple-400 dark:bg-purple-950 dark:ring-purple-700'
                );
              }
              if (w.speedTo !== undefined) {
                marks.push('underline decoration-dotted decoration-yellow-500 underline-offset-4');
              }
              const title = [
                w.change !== 'unchanged' ? w.change : null,
                w.moved ? 'moved' : null,
                w.speedFrom !== undefined && w.speedTo !== undefined
                  ? `${rate(w.speedFrom)} → ${rate(w.speedTo)}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ');

              return (
                <span
                  key={`${w.originalIndex}-${i}`}
                  className={marks.join(' ')}
                  title={title || undefined}
                >
                  {isSilence ? <em className="not-italic opacity-70">{w.text}</em> : w.text}{' '}
                </span>
              );
            })}
          </p>
        </ScrollArea>
      )}
    </div>
  );
}

export function EditHistoryPanel({
  checkpoints,
  historyIndex,
  artipodId,
  apiKey,
  onRestore,
  restoringIndex,
  onRenamed,
  onClose,
}: EditHistoryPanelProps) {
  const [filter, setFilter] = useState<Filter>('all');
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [diff, setDiff] = useState<CheckpointDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [renamingIndex, setRenamingIndex] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Diffs are fetched on demand: each one is the size of the transcript, and
  // most versions are never expanded.
  useEffect(() => {
    if (openIndex === null) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    fetch(`/api/artipod/${artipodId}/edits/history/${openIndex}/diff`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!cancelled) setDiff(d); })
      .catch(() => { if (!cancelled) setDiff(null); })
      .finally(() => { if (!cancelled) setDiffLoading(false); });
    return () => { cancelled = true; };
  }, [openIndex, artipodId]);

  const submitRename = useCallback(async (index: number) => {
    const label = renameValue.trim();
    if (!label) { setRenamingIndex(null); return; }
    try {
      await fetch(`/api/artipod/${artipodId}/edits/history/${index}/label`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'X-API-Key': apiKey } : {}),
        },
        body: JSON.stringify({ label }),
      });
      onRenamed();
    } finally {
      setRenamingIndex(null);
    }
  }, [renameValue, artipodId, apiKey, onRenamed]);

  const visible = checkpoints.filter((cp) => filter === 'all' || cp.kind === filter);
  const aiCount = checkpoints.filter((cp) => cp.kind === 'ai').length;
  const manualCount = checkpoints.filter((cp) => cp.kind === 'manual').length;

  return (
    <aside className="app__history-pane" aria-label="Edit history">
      <div className="flex items-center justify-between gap-2 px-3 py-2.5">
        <h2 className="m-0 flex items-center gap-2 text-sm font-semibold">
          <History className="h-4 w-4 text-primary-700 dark:text-primary-400" aria-hidden="true" />
          Edit history
        </h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          aria-label="Close edit history"
          title="Close"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <Separator />

      <div className="px-3 py-2">
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)} variant="pills">
          <TabsList className="w-full [&>button]:flex-1 [&>button]:px-2 [&>button]:py-1 [&>button]:text-xs">
            <TabsTrigger value="all">All {checkpoints.length}</TabsTrigger>
            <TabsTrigger value="ai">
              <Sparkles className="mr-1 h-3 w-3" aria-hidden="true" />
              AI {aiCount}
            </TabsTrigger>
            <TabsTrigger value="manual">
              <Hand className="mr-1 h-3 w-3" aria-hidden="true" />
              Hand {manualCount}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <ScrollArea className="flex-1 px-3 pb-3">
        <p className="m-0 mb-2 text-xs text-muted-foreground">
          Every edit is saved here — yours and the AI's. Restoring one brings the whole
          timeline back to that point.
        </p>

        {visible.length === 0 && (
          <p className="m-0 text-xs text-muted-foreground">Nothing here yet.</p>
        )}

        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {visible.map((cp) => {
            const isCurrent = cp.index === historyIndex;
            const isOpen = openIndex === cp.index;
            const { label: kindLabel, Icon } = KIND[cp.kind];
            const Chevron = isOpen ? ChevronDown : ChevronRight;
            return (
              <li key={`${cp.at}-${cp.index}`}>
                <Card
                  padding="none"
                  variant={isCurrent ? 'default' : 'outlined'}
                  className={isCurrent ? 'ring-2 ring-primary-500' : undefined}
                >
                  <CardContent className="p-2.5">
                    <div className="mb-1 flex items-center gap-1.5">
                      <Badge
                        variant={
                          cp.kind === 'ai'
                            ? 'default'
                            : cp.kind === 'manual'
                              ? 'secondary'
                              : 'outline'
                        }
                        size="sm"
                        icon={<Icon className="h-3 w-3" aria-hidden="true" />}
                      >
                        {kindLabel}
                      </Badge>
                      {isCurrent && <Badge variant="success" size="sm">Current</Badge>}
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                        {timeOf(cp.at)}
                      </span>
                    </div>

                    {renamingIndex !== cp.index && (
                      <p className="m-0 break-words text-sm font-medium">{cp.label}</p>
                    )}
                    {cp.summary && (
                      <p className="m-0 mt-0.5 break-words text-xs text-muted-foreground">
                        {cp.summary}
                      </p>
                    )}

                    <div className="mt-2 flex items-center justify-between gap-2">
                      {/* Bare button: the app's stylesheet leaves native button
                          chrome in place, so the reset is explicit here. */}
                      <button
                        type="button"
                        className="flex min-w-0 appearance-none items-center gap-1 rounded border-0 bg-transparent p-0 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                        onClick={() => setOpenIndex(isOpen ? null : cp.index)}
                        aria-expanded={isOpen}
                      >
                        <Chevron className="h-3 w-3 shrink-0" aria-hidden="true" />
                        <span className="truncate">
                          {cp.wordCount !== undefined && `${cp.wordCount} words · `}
                          {isOpen ? 'hide changes' : 'show changes'}
                        </span>
                      </button>

                      <div className="flex shrink-0 items-center gap-1">
                        {!isCurrent && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => onRestore(cp.index)}
                            isLoading={restoringIndex === cp.index}
                            loadingText="…"
                            disabled={restoringIndex !== null}
                          >
                            <RotateCcw className="mr-1 h-3 w-3" aria-hidden="true" />
                            Restore
                          </Button>
                        )}
                        <Tooltip content="Rename this version">
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Rename version: ${cp.label}`}
                            onClick={() => {
                              setRenamingIndex(cp.index);
                              setRenameValue(cp.label);
                            }}
                          >
                            <Pencil className="h-3 w-3" aria-hidden="true" />
                          </Button>
                        </Tooltip>
                      </div>
                    </div>

                    {renamingIndex === cp.index && (
                      <Input
                        className="mt-2"
                        size="sm"
                        value={renameValue}
                        autoFocus
                        aria-label="Version name"
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); submitRename(cp.index); }
                          if (e.key === 'Escape') setRenamingIndex(null);
                        }}
                        onBlur={() => submitRename(cp.index)}
                      />
                    )}

                    {isOpen && diffLoading && (
                      <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                        <Spinner size="sm" />
                        Working out what changed…
                      </div>
                    )}
                    {isOpen && !diffLoading && diff && diff.index === cp.index && (
                      <DiffView diff={diff} />
                    )}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ol>
      </ScrollArea>
    </aside>
  );
}

export default EditHistoryPanel;
