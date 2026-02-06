import type { FC, ChangeEvent, DragEvent } from 'react';
import { useState, useCallback } from 'react';
import './FileUpload.scss';

interface FileUploadProps {
  onFileUploaded: (fileUrl: string, filename: string) => void;
  disabled?: boolean;
  apiKey?: string;
  onAuthError?: () => void;
}

export const FileUpload: FC<FileUploadProps> = ({ onFileUploaded, disabled, apiKey, onAuthError }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (!disabled) {
      setIsDragging(true);
    }
  }, [disabled]);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const uploadFile = async (file: File) => {
    setUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

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
      onFileUploaded(data.url, data.filename);
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
      {error && (
        <div className="file-upload__error">
          {error}
        </div>
      )}
    </div>
  );
};
