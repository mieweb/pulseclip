import type { FC, ChangeEvent, DragEvent } from 'react';
import { useState, useCallback, useRef } from 'react';
import { inspectMediaFile, type ContractReport } from '../lib/videoContract';
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
  /** Guards against a slow inspection of an earlier file landing last. */
  const inspectionSeq = useRef(0);

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
   * Inspect the file against the upload contract.
   *
   * Deliberately NOT awaited by the caller: it runs alongside the upload so
   * it never delays it, and a violation only ever produces a warning.
   */
  const inspect = (file: File) => {
    const seq = ++inspectionSeq.current;
    inspectMediaFile(file)
      .then((report) => {
        if (seq !== inspectionSeq.current) return;
        setContractReport(report.ok ? null : report);
        // Reported either way so the parent can clear a stale warning from
        // a previous upload.
        onInspected?.(report, file);
      })
      .catch(() => {
        // Inspection is advisory; a failure must never affect the upload.
      });
  };

  const uploadFile = async (file: File) => {
    setUploading(true);
    setError(null);
    setContractReport(null);
    inspect(file);

    try {
      const formData = new FormData();
      formData.append('file', file);

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
            <p>Uploading...</p>
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
