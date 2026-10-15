import { ChevronDown, FileText } from 'lucide-react';
import type { ImportResult, ReferenceMode } from '@/lib/copy-studio/shared/contracts';
import { SourceCoverage } from './SourceCoverage';

export function ReferencePanel({ source, mode, disabled, onMode, onChange }: {
  source: ImportResult;
  mode: ReferenceMode;
  disabled: boolean;
  onMode: (mode: ReferenceMode) => void;
  onChange: () => void;
}) {
  const text = source.source.text;
  return (
    <section className="original-reference" aria-label="Original copy reference settings">
      <div className="reference-heading">
        <strong><FileText size={15} /> Original copy reference</strong>
        <button className="text-button" onClick={onChange} disabled={disabled}>Change</button>
      </div>
      <p className="reference-title">{source.source.title}</p>
      <SourceCoverage source={source.source} />
      <div className="field">
        <label htmlFor="reference-mode">How to use the original copy</label>
        <select id="reference-mode" value={mode} onChange={(event) => onMode(event.target.value as ReferenceMode)} disabled={disabled}>
          <option value="preserve_voice">Preserve the client’s voice</option>
          <option value="rework_voice">Rework the voice, keep the context</option>
          <option value="off">Do not use this reference</option>
        </select>
        <small className="field-hint" role="status">
          {mode === 'off' ? 'Generation uses your brief and client notes. This reference is turned off.' : mode === 'rework_voice' ? 'The writer reads the full copy for context and follows your requested brand voice.' : 'The writer reads the full copy and keeps the client’s voice while applying your changes.'}
        </small>
      </div>
      <details className="reference-preview">
        <summary>View original copy · {text.length.toLocaleString()} characters <ChevronDown size={15} /></summary>
        <textarea aria-label="Original copy reference" value={text} readOnly rows={8} />
      </details>
      <p className="field-hint">Your requested changes and approved brief take priority over conflicting details in the original page.</p>
    </section>
  );
}
