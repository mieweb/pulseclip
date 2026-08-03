/**
 * UploadContractWarning — surfaces a picked file's upload-contract
 * violations.
 *
 * This is a WARNING, never a block: the upload proceeds regardless. It
 * exists because a laptop drag-and-drop is the one path no phone-side fix
 * reaches, and a 4K/25 Mbps file uploaded here is unplayable on phones for
 * the life of the pulse.
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

  if (report.ok) return null;

  const copyFixCommand = async () => {
    try {
      await navigator.clipboard.writeText(FFMPEG_FIX_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is unavailable on insecure origins — the command is
      // still on screen and selectable, so this is not worth surfacing.
    }
  };

  return (
    <Alert
      variant="warning"
      dismissible={Boolean(onDismiss)}
      onDismiss={onDismiss}
      dismissLabel="Dismiss playback warning"
      className={className}
    >
      <AlertTitle>{report.headline}</AlertTitle>

      {/* AlertDescription renders a <p>, so only inline content may go
          inside it — the list and the command row are siblings. */}
      <ul className="m-0 mt-1 flex list-disc flex-col gap-1 pl-4 text-sm">
        {report.violations.map((violation) => (
          <li key={violation.code}>
            {violation.message}{' '}
            <span className="opacity-70">Should be {violation.expected}.</span>
          </li>
        ))}
      </ul>

      <AlertDescription className="mt-3">
        Uploading anyway — this plays fine on a desktop. To make it play on
        phones, re-export at 1080p H.264 around 5 Mbps with faststart, or
        record with PulseCam, which already targets those settings.
      </AlertDescription>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded border border-current/20 bg-current/5 px-2 py-1 font-mono text-xs whitespace-pre">
          {FFMPEG_FIX_COMMAND}
        </code>
        <Button variant="ghost" size="sm" onClick={copyFixCommand}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </Alert>
  );
};

UploadContractWarning.displayName = 'UploadContractWarning';
