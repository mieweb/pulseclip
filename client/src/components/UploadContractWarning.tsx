/**
 * UploadContractWarning — shown when a picked file breaks the upload contract
 * AND we could not fix it here.
 *
 * Deliberately narrow: when the browser can re-encode the file (the common
 * case) nothing is shown at all, because nothing is wrong by the time it
 * uploads. This is the fallback path — an old browser, a codec this device
 * cannot decode, or a file too large to convert in a tab. So it explains the
 * situation in one line and keeps the manual ffmpeg recipe folded away, rather
 * than presenting a wall of instructions for something usually handled
 * automatically.
 *
 * Never a block: the upload proceeds regardless.
 */

import type { FC } from 'react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@mieweb/ui/components/Alert';
import { Button } from '@mieweb/ui/components/Button';
import { FFMPEG_FIX_COMMAND, type ContractReport } from '../lib/videoContract';

export interface UploadContractWarningProps {
  report: ContractReport;
  /** Called when the user dismisses the warning. */
  onDismiss?: () => void;
  className?: string;
}

export const UploadContractWarning: FC<UploadContractWarningProps> = ({
  report,
  onDismiss,
  className,
}) => {
  const [copied, setCopied] = useState(false);
  const [showFix, setShowFix] = useState(false);

  if (report.ok) return null;

  const copyFixCommand = async () => {
    try {
      await navigator.clipboard.writeText(FFMPEG_FIX_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is unavailable on insecure origins — the command is still on
      // screen and selectable, so this is not worth surfacing.
    }
  };

  return (
    // `overflow-hidden` + `max-w-full` keep a long violation string or the
    // ffmpeg recipe from widening the whole page on a narrow screen. Without
    // it the alert pushes the document wider than the viewport and every
    // other element ends up horizontally scrolled.
    <Alert
      variant="warning"
      dismissible={Boolean(onDismiss)}
      onDismiss={onDismiss}
      dismissLabel="Dismiss playback warning"
      className={`max-w-full overflow-hidden ${className ?? ''}`}
    >
      <AlertTitle>{report.headline}</AlertTitle>

      {/* AlertDescription renders a <p>, so only inline content may go inside
          it — the toggle row is a sibling. */}
      <AlertDescription className="mt-1">
        Uploaded as-is — this browser couldn&apos;t convert it. Record with PulseCam, or
        re-export at 1080p H.264.
      </AlertDescription>

      <div className="mt-2">
        <Button variant="ghost" size="sm" onClick={() => setShowFix((v) => !v)}>
          {showFix ? 'Hide fix' : 'Fix it yourself'}
        </Button>
      </div>

      {showFix && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* min-w-0 lets the flex child shrink below its content width, which
              is what makes overflow-x-auto scroll the command instead of
              stretching the alert. */}
          <code className="block min-w-0 max-w-full flex-1 overflow-x-auto rounded border border-current/20 bg-current/5 px-2 py-1 font-mono text-xs whitespace-pre">
            {FFMPEG_FIX_COMMAND}
          </code>
          <Button variant="ghost" size="sm" onClick={copyFixCommand}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
    </Alert>
  );
};

UploadContractWarning.displayName = 'UploadContractWarning';
