import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, FileText, Link2, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import {
  fieldLabels,
  MAX_SOURCE_CHARACTERS,
  type Brief,
  type BriefKey,
  type ImportResult,
} from '@/lib/copy-studio/shared/contracts';
import { importSource, readReference } from './api';
import { SourceCoverage } from './SourceCoverage';

export function ImportDialog({
  current,
  initial,
  onClose,
  onApply,
  targetOffer = '',
  initialUrl = '',
  projectLimitReached = false,
}: {
  current: Brief;
  initial: ImportResult | null;
  onClose: () => void;
  onApply: (result: ImportResult, keys: BriefKey[], separateOffer: boolean) => void;
  targetOffer?: string;
  initialUrl?: string;
  projectLimitReached?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<'url' | 'text'>(initial && !initial.source.url ? 'text' : 'url');
  const reusable = initial && (Object.keys(initial.extraction.fields).length || initial.extraction.offers?.length) && (!targetOffer || initial.selectedOffer === targetOffer) ? initial : null;
  const [url, setUrl] = useState(initial?.source.url || initialUrl);
  const [text, setText] = useState(initial?.source.url ? '' : initial?.source.text.slice(0, MAX_SOURCE_CHARACTERS) || '');
  const [offerFocus, setOfferFocus] = useState(targetOffer);
  const [result, setResult] = useState<ImportResult | null>(reusable);
  const [chosenOffer, setChosenOffer] = useState(reusable?.selectedOffer || '');
  const [selected, setSelected] = useState<BriefKey[]>([]);
  const [busy, setBusy] = useState(false);
  const [readingReference, setReadingReference] = useState(false);
  const [error, setError] = useState('');
  const differentOffer = Boolean(result?.selectedOffer && current.offerName.trim() && result.selectedOffer.toLowerCase().trim() !== current.offerName.toLowerCase().trim());
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      controller.current?.abort();
    };
  }, []);
  const runExtraction = async (input: { url?: string; text?: string; targetOffer?: string }, original?: ImportResult['source']) => {
    setBusy(true);
    setError('');
    const request = new AbortController();
    controller.current = request;
    const timeout = setTimeout(
      () => request.abort(new DOMException('Timed out', 'TimeoutError')),
      290000,
    );
    try {
      const extracted = await importSource(input, request.signal);
      if (original) extracted.source = original;
      setResult(extracted);
      setChosenOffer(extracted.selectedOffer ?? input.targetOffer ?? '');
      setSelected(
        (Object.keys(extracted.extraction.fields) as BriefKey[]).filter(
          (key) => !current[key].trim() || Boolean(extracted.selectedOffer && current.offerName.trim() && extracted.selectedOffer.toLowerCase().trim() !== current.offerName.toLowerCase().trim()),
        ),
      );
    } catch (err) {
      if (!request.signal.aborted)
        setError(err instanceof Error ? err.message : 'Could not import this page.');
      else if (request.signal.reason?.name === 'TimeoutError')
        setError('The import timed out. Try a shorter excerpt or retry.');
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  };
  const attachReference = async () => {
    if (!form.current?.reportValidity() || busy) return;
    setBusy(true);
    setReadingReference(true);
    setError('');
    const request = new AbortController();
    controller.current = request;
    const timeout = setTimeout(() => request.abort(new DOMException('Timed out', 'TimeoutError')), 150000);
    try {
      const source = await readReference(mode === 'url' ? { url } : { text }, request.signal);
      request.signal.throwIfAborted();
      onApply({ source, extraction: { fields: {}, evidence: [], warnings: [] } }, [], false);
    } catch (err) {
      if (!request.signal.aborted)
        setError(err instanceof Error ? err.message : 'Could not read the original copy.');
      else if (request.signal.reason?.name === 'TimeoutError')
        setError('Reading the page timed out. Paste its visible copy instead.');
    } finally {
      clearTimeout(timeout);
      setBusy(false);
      setReadingReference(false);
    }
  };
  const chooseOffer = (name: string) => result && void runExtraction({ text: result.source.text.slice(0, MAX_SOURCE_CHARACTERS), targetOffer: name }, result.source);
  const choosing = Boolean(result && (result.extraction.offers?.length || 0) > 1 && !chosenOffer);
  return (
    <dialog
      ref={dialog}
      className="import-dialog"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="import-heading"
    >
      <div className="dialog-header">
        <div>
          <span className="eyebrow">A HEAD START, GROUNDED IN FACTS</span>
          <h2 id="import-heading">
            {choosing ? 'Choose the offer for this page' : result ? 'Review what we found' : 'Bring your offer into focus'}
          </h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close import">
          <X size={20} />
        </button>
      </div>
      {result && <SourceCoverage source={result.source} />}
      {!result ? (
        <form ref={form} onSubmit={(event) => { event.preventDefault(); void attachReference(); }}>
          <p className="muted">
            Add the original page so the writer can use its full copy, tone, and context alongside
            your onboarding answers and requested changes. Extracting offer facts is optional.
          </p>
          <div className="segmented import-tabs">
            <button
              type="button"
              className={mode === 'url' ? 'active' : ''}
              onClick={() => setMode('url')}
              disabled={busy}
            >
              <Link2 size={16} />
              Website URL
            </button>
            <button
              type="button"
              className={mode === 'text' ? 'active' : ''}
              onClick={() => setMode('text')}
              disabled={busy}
            >
              <FileText size={16} />
              Paste text
            </button>
          </div>
          <div className="field">
            <label htmlFor="source-offer-focus">Offer to focus on <span className="optional">Optional</span></label>
            <input id="source-offer-focus" value={offerFocus} maxLength={200} disabled={busy} onChange={(event) => setOfferFocus(event.target.value)} placeholder="e.g. Executive Leadership Program" />
            <small className="field-hint">Used for optional fact extraction. Your brief decides which offer the new page promotes.</small>
          </div>
          <div className="field">
            {mode === 'url' ? (
              <>
                <label htmlFor="source-url">Page URL</label>
                <input
                  id="source-url"
                  type="url"
                  value={url}
                  placeholder="https://yourwebsite.com/offer"
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={busy}
                  required
                  maxLength={2000}
                />
                <small className="field-hint">
                  Reads public pages across this website, including links and sitemaps. Login-protected or JavaScript-only copy may need Paste text.
                </small>
              </>
            ) : (
              <>
                <label htmlFor="source-text">Visible page copy</label>
                <textarea
                  id="source-text"
                  rows={10}
                  value={text}
                  minLength={100}
                  maxLength={MAX_SOURCE_CHARACTERS}
                  placeholder="Paste the headings, offer details, testimonials, and calls to action…"
                  onChange={(e) => setText(e.target.value)}
                  disabled={busy}
                  required
                />
                <small className="field-hint">
                  {text.length.toLocaleString()} / {MAX_SOURCE_CHARACTERS.toLocaleString()} characters · Minimum 100
                </small>
              </>
            )}
          </div>
          {error && (
            <div role="alert" className="notice error">
              {error}
            </div>
          )}
          <div className="dialog-footer">
            <span>
              <ShieldCheck size={15} />
              Your approved brief controls the facts
            </span>
            <button type="button" className="button secondary" disabled={busy} onClick={() => {
              if (form.current?.reportValidity()) void runExtraction({ ...(mode === 'url' ? { url } : { text }), targetOffer: offerFocus });
            }}>
              {busy && !readingReference ? <LoaderCircle size={16} className="spin" /> : <FileText size={16} />}
              Extract offer facts
            </button>
            <button className="button primary" disabled={busy}>
              {busy ? (
                <>
                  <LoaderCircle size={16} className="spin" />
                  {mode === 'url' ? 'Reading website pages…' : readingReference ? 'Reading original copy…' : 'Reading the offer…'}
                </>
              ) : (
                <>
                  Use full copy as reference
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </div>
          {busy && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                controller.current?.abort();
              }}
            >
              Cancel import
            </button>
          )}
        </form>
      ) : choosing ? (
        <div>
          <p className="muted">This source contains {result!.extraction.offers!.length} offers. Pick one to keep its audience, price, proof, and next step together.</p>
          <div className="onboarding-options">
            {result!.extraction.offers!.map((offer) => <button className="offer-choice" key={offer.name} disabled={busy} onClick={() => chooseOffer(offer.name)}>
              <span><strong>{offer.name}</strong><small>{offer.summary}</small></span><ArrowRight size={16} />
            </button>)}
          </div>
          {busy && <p className="muted" role="status"><LoaderCircle size={15} className="spin" /> Reading the selected offer…</p>}
          {result!.extraction.warnings.length > 0 && <p className="notice warning">{result!.extraction.warnings.join(' ')}</p>}
          {error && <div className="notice error" role="alert">{error}</div>}
          <div className="dialog-footer">
            <button className="button secondary" disabled={busy} onClick={() => { setResult(null); setChosenOffer(''); }}>Try another source</button>
            <button className="button secondary" disabled={busy} onClick={() => onApply(result!, [], false)}>Use full copy as reference</button>
          </div>
        </div>
      ) : (
        <div>
          <p className="muted">
            Choose the fields to apply. Existing values are preserved unless you select their
            replacements. You can also use the full copy as a reference while keeping your brief unchanged.
          </p>
          <div className="extraction-source">
            <FileText size={16} />
            <span>{result.source.title}</span>
            {result.source.url && (
              <a href={result.source.url} target="_blank" rel="noreferrer">
                View source ↗
              </a>
            )}
          </div>
          {chosenOffer && <div className="selected-offer-note"><span>Selected offer: <strong>{chosenOffer}</strong></span>
            {(result.extraction.offers?.length || 0) > 1 && <button className="text-button" disabled={busy} onClick={() => setChosenOffer('')}>Choose another offer</button>}
          </div>}
          {differentOffer && <p className="notice warning">Applying this offer starts a separate copy project. Select its offer name and the facts to use. Previous pricing, proof, and terms are left out. Your existing project stays saved.</p>}
          {differentOffer && projectLimitReached && <p className="notice error">Export and remove an older project before adding another offer. This browser has reached 100 projects.</p>}
          <div className="selection-actions">
            <button
              onClick={() => setSelected(Object.keys(result.extraction.fields) as BriefKey[])}
            >
              Select all
            </button>
            <button onClick={() => setSelected([])}>Clear selection</button>
            <span>{selected.length} selected</span>
          </div>
          <div className="extracted-fields">
            {(Object.entries(result.extraction.fields) as [BriefKey, string][]).map(
              ([key, value]) => (
                <div
                  className={`extracted-field ${selected.includes(key) ? 'is-selected' : ''}`}
                  key={key}
                >
                  <label>
                    <input
                      type="checkbox"
                      checked={selected.includes(key)}
                      onChange={() =>
                        setSelected((old) =>
                          old.includes(key) ? old.filter((k) => k !== key) : [...old, key],
                        )
                      }
                    />
                    <span>
                      <strong>{fieldLabels[key]}</strong>
                      {current[key] && <small>Replaces your existing value</small>}
                      <p>{value}</p>
                    </span>
                  </label>
                  <details>
                    <summary>Source evidence</summary>
                    {result.extraction.evidence
                      .filter((e) => e.field === key)
                      .map((e, i) => (
                        <blockquote key={i}>{e.quote}</blockquote>
                      ))}
                  </details>
                </div>
              ),
            )}
          </div>
          {!Object.keys(result.extraction.fields).length && (
            <p className="notice warning">
              No facts could be supported by exact source quotes. Try a more detailed source or fill
              in your brief manually.
            </p>
          )}
          {result.extraction.warnings.length > 0 && (
            <details className="import-warnings">
              <summary>Information to check ({result.extraction.warnings.length})</summary>
              <ul>
                {result.extraction.warnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="dialog-footer">
            <button
              className="button subtle"
              onClick={() => {
                setResult(null);
                setChosenOffer('');
                setError('');
              }}
            >
              Try another source
            </button>
            <button
              className="button primary"
              disabled={!selected.length || (differentOffer && (!selected.includes('offerName') || projectLimitReached))}
              onClick={() => onApply(result, selected, differentOffer)}
            >
              <Check size={16} />
              Apply {selected.length} field{selected.length === 1 ? '' : 's'}
            </button>
            <button className="button secondary" onClick={() => onApply(result, [], false)}>Use full copy as reference</button>
          </div>
        </div>
      )}
    </dialog>
  );
}
