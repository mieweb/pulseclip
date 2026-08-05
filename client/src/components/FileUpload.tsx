import type { FC, ChangeEvent, DragEvent } from 'react';
import { useState, useCallback, useRef } from 'react';
import { Card } from '@mieweb/ui/components/Card';
import { Button } from '@mieweb/ui/components/Button';
import { Alert } from '@mieweb/ui/components/Alert';
import { SpinnerWithLabel } from '@mieweb/ui/components/Spinner';
import { CloudUpload } from 'lucide-react';

interface FileUploadProps {
  onFileUploaded: (fileUrl: string, artipodId: string, filename: string) => void;
  disabled?: boolean;
}

export const FileUpload: FC<FileUploadProps> = ({ onFileUploaded, disabled }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  const uploadFile = async (file: File) => {
    setUploading(true);
    setError(null);

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
            <SpinnerWithLabel size="lg" label="Uploading..." />
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
      {error && <Alert variant="danger">{error}</Alert>}
    </div>
  );
};
