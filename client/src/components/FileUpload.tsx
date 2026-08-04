import type { FC, ChangeEvent, DragEvent } from 'react';
import { useState, useCallback } from 'react';
import { inspectMediaFile, type ContractReport } from '../lib/videoContract';
import type { TranscodeProgress } from '../lib/transcodeToContract';
import { UploadContractWarning } from './UploadContractWarning';
import './FileUpload.scss';

interface FileUploadProps {
  onFileUploaded: (fileUrl: string, artipodId: string, filename: string) => void;
  /**
   * Fired once the picked file has been inspected against the upload
   * contract. Lets the parent keep the warning on screen after this
   * component unmounts on navigation.
   */
  onInspected?: (report: ContractReport, file: File) => void;
  disabled?: boolean;
}

export const FileUpload: FC<FileUploadProps> = ({ onFileUploaded, onInspected, disabled }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contractReport, setContractReport] = useState<ContractReport | null>(null);
  const [converting, setConverting] = useState<TranscodeProgress | null>(null);

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
   * Returns the file to actually upload. Inspection runs BEFORE the transfer rather than
   * alongside it (as it did when this only produced a warning) — we cannot convert a file we
   * have already started sending. It costs a few ranged reads, not a full pass.
   *
   * Conversion failing is not an upload failure: we fall back to the original bytes and show
   * the warning then — and only then, because a warning about how to fix a file by hand is
   * noise while we are busy fixing it automatically.
   */
  const conditionFile = async (file: File): Promise<File> => {
    const report = await inspectMediaFile(file).catch(() => null);
    if (!report) return file;
    onInspected?.(report, file);
    if (report.ok) {
      setContractReport(null);
      return file;
    }
    try {
      // Loaded on demand: the demuxer and muxer are ~220KB, and a visitor who never drops a
      // non-compliant file should never pay for them.
      const { transcodeToContract } = await import('../lib/transcodeToContract');
      const converted = await transcodeToContract(file, {
        onProgress: (progress) => setConverting(progress),
      });
      // It meets the contract now, so there is nothing to warn about. Note the warning was
      // never shown during conversion: telling someone how to fix a file by hand while we are
      // busy fixing it for them is just noise.
      onInspected?.({ ...report, violations: [], ok: true, headline: null }, converted);
      return converted;
    } catch {
      // Unsupported browser, an undecodable source, or a file too large to convert here.
      // Only NOW is the warning worth showing, because now it is actionable.
      setContractReport(report);
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

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

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
    <div className="file-upload">
      <div
        className={`file-upload__dropzone ${isDragging ? 'file-upload__dropzone--dragging' : ''} ${disabled ? 'file-upload__dropzone--disabled' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {uploading ? (
          <div className="file-upload__status">
            <div className="file-upload__spinner"></div>
            <p>
              {converting
                ? `Converting for phone playback… ${Math.round(converting.ratio * 100)}%`
                : 'Uploading...'}
            </p>
          </div>
        ) : (
          <>
            <div className="file-upload__icon">🎬</div>
            <p className="file-upload__text">
              Drag and drop audio or video pulse here
            </p>
            <p className="file-upload__hint">or</p>
            <label className="file-upload__button">
              <input
                type="file"
                accept="audio/*,video/*"
                onChange={handleFileSelect}
                disabled={disabled || uploading}
                className="file-upload__input"
              />
              Browse Pulses
            </label>
            <p className="file-upload__formats">
              Supports: MP3, WAV, MP4, MOV, and more
            </p>
          </>
        )}
      </div>
      {contractReport && (
        <UploadContractWarning
          className="file-upload__contract-warning"
          report={contractReport}
          onDismiss={() => setContractReport(null)}
        />
      )}
      {error && (
        <div className="file-upload__error">
          {error}
        </div>
      )}
    </div>
  );
};
