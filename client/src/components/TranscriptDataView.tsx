import type { FC } from 'react';
import type { EditableWord, Transcript } from '../types';
import './TranscriptDataView.scss';

interface TranscriptDataViewProps {
  transcript: Transcript;
  editedWords: EditableWord[];
  dataSource: 'editor' | 'original';
  dataFormat: 'yaml' | 'json';
  onDataSourceChange: (source: 'editor' | 'original') => void;
  onDataFormatChange: (format: 'yaml' | 'json') => void;
}

/** Format data as JSON or simple YAML (ported from the retired TranscriptViewer) */
function formatData(data: unknown, format: 'yaml' | 'json'): string {
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }
  const toYaml = (obj: unknown, indent = 0): string => {
    const spaces = '  '.repeat(indent);
    if (obj === null || obj === undefined) return 'null';
    if (typeof obj === 'boolean' || typeof obj === 'number') return String(obj);
    if (typeof obj === 'string') {
      if (obj.includes('\n') || obj.includes(':') || obj.includes('#') ||
          obj.startsWith(' ') || obj.endsWith(' ') || obj === '') {
        return JSON.stringify(obj);
      }
      return obj;
    }
    if (Array.isArray(obj)) {
      if (obj.length === 0) return '[]';
      return obj.map(item => {
        const itemStr = toYaml(item, indent + 1);
        if (typeof item === 'object' && item !== null) {
          return `\n${spaces}- ${itemStr.trim().replace(/^\n/, '').replace(/\n/g, '\n' + spaces + '  ')}`;
        }
        return `\n${spaces}- ${itemStr}`;
      }).join('');
    }
    if (typeof obj === 'object') {
      const entries = Object.entries(obj as Record<string, unknown>);
      if (entries.length === 0) return '{}';
      return entries.map(([key, value]) => {
        const valueStr = toYaml(value, indent + 1);
        if (typeof value === 'object' && value !== null) {
          return `\n${spaces}${key}:${valueStr}`;
        }
        return `\n${spaces}${key}: ${valueStr}`;
      }).join('');
    }
    return String(obj);
  };
  return toYaml(data).trim();
}

/** Raw-data debug view (Editor/Original × YAML/JSON) — pulseclip app concern */
export const TranscriptDataView: FC<TranscriptDataViewProps> = ({
  transcript,
  editedWords,
  dataSource,
  dataFormat,
  onDataSourceChange,
  onDataFormatChange,
}) => {
  const dataToShow = dataSource === 'original' ? transcript : editedWords;
  return (
    <div className="transcript-data-view">
      <div className="transcript-data-view__header">
        <h3>{dataSource === 'original' ? 'Original' : 'Editor'}</h3>
        <div className="transcript-data-view__actions">
          <div className="transcript-data-view__source-toggle" role="group" aria-label="Data source">
            <button
              className={dataSource === 'editor' ? 'is-active' : ''}
              onClick={() => onDataSourceChange('editor')}
              aria-pressed={dataSource === 'editor'}
            >
              Editor
            </button>
            <button
              className={dataSource === 'original' ? 'is-active' : ''}
              onClick={() => onDataSourceChange('original')}
              aria-pressed={dataSource === 'original'}
            >
              Original
            </button>
          </div>
          <label className="transcript-data-view__format-toggle">
            <input
              type="checkbox"
              checked={dataFormat === 'json'}
              onChange={(e) => onDataFormatChange(e.target.checked ? 'json' : 'yaml')}
            />
            <span>JSON</span>
          </label>
        </div>
      </div>
      <div className="transcript-data-view__raw">
        <pre>{formatData(dataToShow, dataFormat)}</pre>
      </div>
    </div>
  );
};
