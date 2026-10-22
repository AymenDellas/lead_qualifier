import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { EXTRACTION_VERSION, type ImportResult, type Project } from '@/lib/copy-studio/shared/contracts';
import { importSource } from './api';
import { SourceCoverage } from './SourceCoverage';

export function EvidenceRecoveryDialog({ project, onClose, onContinue }: {
  project: Project;
  onClose: () => void;
  onContinue: (result: ImportResult | null, include: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const saved = project.source!;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    setResult(null);
    const timer = setTimeout(() => request.abort(new DOMException('Timed out', 'TimeoutError')), 290000);
    // A current extraction can be reviewed without another crawl or AI call.
    const cached = !attempt && saved.extractionVersion === EXTRACTION_VERSION
      && saved.extraction.fields.proof?.trim()
      && saved.selectedOffer?.toLowerCase().trim() === project.brief.offerName.toLowerCase().trim();
    const task = cached ? Promise.resolve(saved) : importSource({
      ...(saved.source.url ? { url: saved.source.url } : { text: saved.source.text }),
      targetOffer: project.brief.offerName.slice(0, 200),
    }, request.signal);
    void task.then(value => {
      if (!request.signal.aborted) setResult(value);
    }).catch(err => {
      if (!request.signal.aborted || request.signal.reason?.name === 'TimeoutError')
        setError(request.signal.reason?.name === 'TimeoutError'
          ? 'The evidence check timed out. Retry, or continue without evidence.'
          : err instanceof Error ? err.message : 'The website evidence could not be checked.');
    }).finally(() => {
      clearTimeout(timer);
      if (!request.signal.aborted || request.signal.reason?.name === 'TimeoutError') setBusy(false);
    });
    return () => { clearTimeout(timer); request.abort(); };
  }, [project, attempt]);
  const proof = result?.extraction.fields.proof?.trim();
  return <dialog ref={dialog} className="import-dialog" aria-labelledby="evidence-recovery-heading"
    onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dialog-header">
      <div><span className="eyebrow">BEFORE YOUR NEXT DRAFT</span>
        <h2 id="evidence-recovery-heading">Recover missing client evidence</h2></div>
      <button className="icon-button" onClick={onClose} aria-label="Close evidence review"><X size={20} /></button>
    </div>
    <p className="muted">This project has an original page attached, but its saved client evidence is empty.
      Review evidence for <strong>{project.brief.offerName}</strong> before generating. Your other answers stay as you wrote them.</p>
    {busy ? <p role="status"><LoaderCircle className="spin" size={16} /> Checking the website and its testimonial routes…</p>
      : error ? <div className="notice error" role="alert">{error}</div>
      : proof ? <div className="extracted-field is-selected">
        <strong>Client results &amp; evidence</strong>
        <p style={{ whiteSpace: 'pre-wrap' }}>{proof}</p>
      </div> : <p className="notice warning">No matching, source-supported client evidence was found. Section 7 will stay omitted if you continue.</p>}
    {result && <SourceCoverage source={result.source} />}
    <div className="dialog-footer">
      {busy ? <button className="button secondary" onClick={onClose}>Cancel check</button> : <>
        <button className="button subtle" onClick={() => setAttempt(value => value + 1)}>Check website again</button>
        <button className="button secondary" onClick={() => onContinue(result, false)}>Generate without evidence</button>
        {proof && <button className="button primary" onClick={() => onContinue(result, true)}>Use evidence and generate</button>}
      </>}
    </div>
  </dialog>;
}
