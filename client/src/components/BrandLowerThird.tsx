import { AudioLines } from 'lucide-react';
import { Card } from '@mieweb/ui/components/Card';

/**
 * Branded lower-third title bar for the exported video (MIE placeholder).
 *
 * This is the swappable brand surface: every color comes from the active
 * @mieweb/ui brand tokens (primary-*, white), so switching brands via
 * BrandSelector — or dropping in real MIE assets later — restyles it without
 * touching the export/render code. Rendered at a fixed pixel size so it
 * rasterizes crisply (see lib/rasterize), then composited over the video by
 * the server. Kept intentionally simple; intro/outro cards reuse the same
 * token approach.
 */

/** Fixed design width the lower-third rasterizes at; the server scales it to the video width */
export const LOWER_THIRD_WIDTH = 1280;
export const LOWER_THIRD_HEIGHT = 220;

export interface BrandLowerThirdProps {
  title: string;
  /** Small label under the title — the brand/byline. Defaults to "MIE". */
  subtitle?: string;
}

export function BrandLowerThird({ title, subtitle = 'MIE' }: BrandLowerThirdProps) {
  return (
    <div
      style={{ width: LOWER_THIRD_WIDTH, height: LOWER_THIRD_HEIGHT }}
      className="flex items-end bg-transparent pb-6 pl-12"
    >
      <Card
        variant="elevated"
        padding="none"
        className="inline-flex items-center gap-5 rounded-2xl bg-primary-800 px-7 py-5 text-white"
      >
        <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-white/15">
          <AudioLines className="h-9 w-9 text-white" aria-hidden="true" />
        </span>
        <span className="flex flex-col">
          <span className="text-3xl font-semibold leading-tight">{title}</span>
          <span className="mt-1 text-base font-medium uppercase tracking-widest text-white/75">
            {subtitle}
          </span>
        </span>
      </Card>
    </div>
  );
}
