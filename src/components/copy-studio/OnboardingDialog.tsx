import { useEffect, useRef, useState } from 'react';
import { Check, LoaderCircle, X } from 'lucide-react';
import { fieldLabels, type BriefKey, type Project } from '@/lib/copy-studio/shared/contracts';
import { matchOnboardings, type OnboardingBrief } from '@/lib/copy-studio/shared/onboarding';
import { templates } from '@/lib/copy-studio/shared/templates';

export function OnboardingDialog({ project, records, loading, error, onRefresh, onClose, onApply }: {
  project: Project;
  records: OnboardingBrief[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onClose: () => void;
  onApply: (record: OnboardingBrief, fields: BriefKey[], useTemplate: boolean, useConstraints: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState(project.onboarding?.id || '');
  const [fields, setFields] = useState<BriefKey[]>([]);
  const [useTemplate, setUseTemplate] = useState(!project.result);
  const [useConstraints, setUseConstraints] = useState(!project.context?.mustKeep && !project.context?.avoid && !project.context?.background);
  const matches = matchOnboardings(records, query || project.source?.source.url || '');
  const selected = records.find((record) => record.id === selectedId);
  const visible = query.trim()
    ? (matches.length ? matches : records.filter((record) =>
        `${record.clientName} ${record.businessName} ${record.projectName}`.toLowerCase().includes(query.trim().toLowerCase())))
    : [...matches, ...records.filter((record) => !matches.some((match) => match.id === record.id))];
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    setFields(selected ? (Object.keys(fieldLabels) as BriefKey[]).filter((key) =>
      key !== 'voice' && (project.context?.mode === undefined || project.context.mode === 'current' || key === 'audience') && Boolean(selected.brief[key]) && !project.brief[key].trim()) : []);
  }, [selected, project.brief, project.context?.mode]);
  return (
    <dialog ref={dialog} className="import-dialog onboarding-dialog" aria-labelledby="onboarding-picker-heading"
      onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dialog-header">
        <div><span className="eyebrow">CLIENT BRIEF</span><h2 id="onboarding-picker-heading">Choose client onboarding</h2></div>
        <button className="icon-button" aria-label="Close onboarding picker" onClick={onClose}><X size={20} /></button>
      </div>
      <p className="muted">Find the client by name or page URL. Review their answers before adding them to this copy project.</p>
      <div className="field">
        <label htmlFor="onboarding-search">Find a client or paste their page URL</label>
        <input id="onboarding-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Client, business, project, or https://…" />
      </div>
      {loading && <p className="muted" role="status"><LoaderCircle className="spin" size={14} /> Loading onboarding…</p>}
      {error && <div className="notice error" role="alert">{error}</div>}
      <div className="onboarding-options" role="radiogroup" aria-label="Client onboarding">
        {visible.map((record) => (
          <label className={`onboarding-option ${selectedId === record.id ? 'selected' : ''}`} key={record.id}>
            <input type="radio" name="client-onboarding" checked={selectedId === record.id} onChange={() => setSelectedId(record.id)} />
            <span><strong>{record.clientName || record.businessName || record.projectName}</strong>
              <small>{record.projectName} · {record.formStatus === 'COMPLETE' ? 'Form complete' : 'Form in progress'}</small>
              {matches.some((match) => match.id === record.id) && <small className="onboarding-match">Matches this page’s website</small>}
            </span>
          </label>
        ))}
      </div>
      {!loading && !error && !visible.length && <p className="muted">{records.length ? 'No matching clients. Try their name or another URL.' : 'No onboarding records yet. You can build a brief manually, or add a client in Onboarding.'}</p>}
      {selected && <div className="onboarding-review">
        <h3>Review {selected.clientName || selected.projectName}’s answers</h3>
        <p className="muted">Select fields to apply. Existing values change only when you select a replacement. Missing answers stay editable in your brief.</p>
        <div className="selection-actions">
          <button onClick={() => setFields((Object.keys(fieldLabels) as BriefKey[]).filter((key) => key !== 'voice' && Boolean(selected.brief[key])))}>Select all answers</button>
          <button onClick={() => setFields([])}>Clear selection</button>
        </div>
        <div className="extracted-fields">
          {(Object.keys(fieldLabels) as BriefKey[]).filter((key) => key !== 'voice' && selected.brief[key]).map((key) => (
            <div className={`extracted-field ${fields.includes(key) ? 'is-selected' : ''}`} key={key}>
              <label><input type="checkbox" checked={fields.includes(key)} onChange={() => setFields((old) => old.includes(key) ? old.filter((field) => field !== key) : [...old, key])} />
                <span><strong>{fieldLabels[key]}</strong>{project.brief[key] && <small>Replaces your existing value</small>}<p>{selected.brief[key]}</p></span>
              </label>
            </div>
          ))}
        </div>
        <label className="onboarding-check"><input type="checkbox" checked={useTemplate} onChange={(event) => setUseTemplate(event.target.checked)} />Use the onboarding page goal: {templates[selected.template].name}</label>
        {(selected.context.mustKeep || selected.context.avoid || selected.context.background) && <div>
          <label className="onboarding-check"><input type="checkbox" checked={useConstraints} onChange={(event) => setUseConstraints(event.target.checked)} />Apply the client’s context, must-keep and avoid notes</label>
          <p className="muted onboarding-client-notes">{[selected.context.background, selected.context.mustKeep && `Keep: ${selected.context.mustKeep}`, selected.context.avoid && `Avoid: ${selected.context.avoid}`].filter(Boolean).join('\n\n')}</p>
        </div>}
      </div>}
      <div className="dialog-footer">
        <button className="button secondary" onClick={onRefresh} disabled={loading}>Refresh onboarding</button>
        <button className="button primary" disabled={!selected || loading} onClick={() => selected && onApply(selected, fields, useTemplate, useConstraints)}><Check size={16} />Use this onboarding</button>
      </div>
    </dialog>
  );
}
