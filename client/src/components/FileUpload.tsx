import type { FC, ChangeEvent, DragEvent } from 'react';
import { useState, useCallback, useRef } from 'react';
import { Card } from '@mieweb/ui/components/Card';
import { Button } from '@mieweb/ui/components/Button';
import { Alert } from '@mieweb/ui/components/Alert';
import { SpinnerWithLabel } from '@mieweb/ui/components/Spinner';
import { CloudUpload } from 'lucide-react';
import { inspectMediaFile, type ContractReport } from '../lib/videoContract';
import type { TranscodeProgress } from '../lib/transcodeToContract';
import { UploadContractWarning } from './UploadContractWarning';

interface FileUploadProps {
  onFileUploaded: (fileUrl: string, artipodId: string, filename: string) => void;
  /**
   * Fired once the picked file has been inspected against the upload
   * contract. Lets the parent keep the warning on screen after this
   * component unmounts on navigation.
   */
  onInspected?: (report: ContractReport, file: File) => void;
  disabled?: boolean;
  apiKey?: string;
  onAuthError?: () => void;
}

export const FileUpload: FC<FileUploadProps> = ({ onFileUploaded, onInspected, disabled, apiKey, onAuthError }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contractReport, setContractReport] = useState<ContractReport | null>(null);
  const [converting, setConverting] = useState<TranscodeProgress | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (!disabled) {
      setIsDragging(true);
    }
  }, [disabled]);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  /**
   * Bring the picked file into the upload contract, or explain why we couldn't.
   *
   * Returns the file to actually upload. Inspection now runs BEFORE the transfer rather
   * than alongside it (as it did when this only produced a warning) — we cannot convert a
   * file we have already started sending. It costs a few ranged reads, not a full pass.
   *
   * Conversion failing is not an upload failure: we fall back to the original bytes and
   * leave the warning on screen, which is exactly the v1 behaviour.
   */
  const conditionFile = async (file: File): Promise<File> => {
    const report = await inspectMediaFile(file).catch(() => null);
    if (!report) return file;
    onInspected?.(report, file);
    if (report.ok) {
      setContractReport(null);
      return file;
    }
    setContractReport(report);
    try {
      // Loaded on demand: the demuxer and muxer are ~400KB, and a visitor who never drops a
      // non-compliant file should never pay for them.
      const { transcodeToContract } = await import('../lib/transcodeToContract');
      const converted = await transcodeToContract(file, {
        onProgress: (progress) => setConverting(progress),
      });
      // It now meets the contract, so there is nothing left to warn about.
      setContractReport(null);
      onInspected?.({ ...report, violations: [], ok: true, headline: null }, converted);
      return converted;
    } catch {
      // Unsupported browser, an undecodable source, or a file too large to convert here.
      // The warning stays up and the original is uploaded unchanged.
      return file;
    } finally {
      setConverting(null);
    }
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    setError(null);
    setContractReport(null);

    try {
      const toUpload = await conditionFile(file);
      const formData = new FormData();
      formData.append('file', toUpload);

      const headers: HeadersInit = {};
      if (apiKey) {
        headers['X-API-Key'] = apiKey;
      }

      const response = await fetch('/api/upload', {
        method: 'POST',
        headers,
        body: formData,
      });

      if (response.status === 401) {
        onAuthError?.();
        throw new Error('API key required');
      }

      if (!response.ok) {
        throw new Error('Upload failed');
      }

      const data = await response.json();
      onFileUploaded(data.url, data.artipodId, data.filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    if (disabled) return;

    const file = e.dataTransfer.files[0];
    if (file) {
      uploadFile(file);
    }
  }, [disabled]);

  const handleFileSelect = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      uploadFile(file);
    }
  }, []);

  return (
    <div className="flex h-full flex-col gap-3">
      <Card
        padding="lg"
        className={`h-full border-2 border-dashed transition-colors ${
          isDragging ? 'border-primary-600 bg-primary-50 dark:bg-primary-950' : 'border-border'
        } ${disabled ? 'opacity-60' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {uploading ? (
          <div className="flex min-h-52 items-center justify-center">
            <SpinnerWithLabel
              size="lg"
              label={
                converting
                  ? `Converting for phone playback… ${Math.round(converting.ratio * 100)}%`
                  : 'Uploading...'
              }
            />
          </div>
        ) : (
          <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-100 dark:bg-primary-900">
              <CloudUpload className="h-6 w-6 text-primary-800 dark:text-primary-300" aria-hidden="true" />
            </span>
            <p className="m-0 font-medium text-foreground">Drag &amp; drop a pulse here</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={disabled || uploading}
            >
              Browse Pulses
            </Button>
            <p className="m-0 text-xs text-muted-foreground">
              Audio or video &mdash; MP3, WAV, MP4, MOV, and more
            </p>
            <input
              ref={inputRef}
              type="file"
              accept="audio/*,video/*"
              onChange={handleFileSelect}
              disabled={disabled || uploading}
              className="sr-only"
              aria-label="Choose an audio or video file"
            />
          </div>
        )}
      </Card>
      {contractReport && (
        <UploadContractWarning
          className="mt-4 text-left"
          report={contractReport}
          onDismiss={() => setContractReport(null)}
        />
      )}
      {error && <Alert variant="danger">{error}</Alert>}
    </div>
  );
};
