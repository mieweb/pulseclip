import { createRoot } from 'react-dom/client';
import { toPng } from 'html-to-image';
import {
  BrandLowerThird,
  LOWER_THIRD_WIDTH,
  LOWER_THIRD_HEIGHT,
} from '../components/BrandLowerThird';

/**
 * Rasterizes a React brand component to a transparent PNG data URL.
 *
 * The component is rendered off-screen (still in the live document, so it
 * inherits the loaded @mieweb/ui styles and brand tokens), captured with
 * html-to-image, then torn down. This is what lets the brand layer be real UI
 * components rather than hard-coded ffmpeg draws — the server just composites
 * the resulting PNG.
 */
async function rasterizeNode(
  render: (root: ReturnType<typeof createRoot>) => void,
  width: number,
  height: number
): Promise<string> {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;pointer-events:none;`;
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    render(root);
    // Let layout and any freshly-referenced fonts settle before capture
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    const target = host.firstElementChild as HTMLElement;
    return await toPng(target, {
      width,
      height,
      pixelRatio: 2, // crisp when the server scales it up to the video width
      backgroundColor: undefined, // keep the area above the band transparent
      skipFonts: true, // fonts are already loaded in the doc; avoids slow @font-face embedding
    });
  } finally {
    root.unmount();
    host.remove();
  }
}

/** Render the MIE lower-third title bar to a transparent PNG data URL */
export function rasterizeLowerThird(title: string, subtitle?: string): Promise<string> {
  return rasterizeNode(
    (root) => root.render(<BrandLowerThird title={title} subtitle={subtitle} />),
    LOWER_THIRD_WIDTH,
    LOWER_THIRD_HEIGHT
  );
}
