import { useState } from 'react';
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  Eye,
  FileText,
  LoaderCircle,
  Pencil,
  PenLine,
  PanelTop,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react';
import {
  MAX_PROOF_CHARACTERS,
  type Issue,
  type Project,
  type Section,
  type TemplateId,
  type RevisionInput,
} from '@/lib/copy-studio/shared/contracts';
import { templates } from '@/lib/copy-studio/shared/templates';
import { isLegacyDirectCallDraft } from '@/lib/copy-studio/shared/quality';
import { sectionWritingRole } from '@/lib/copy-studio/shared/persuasion';
import { sectionAngleOptions, wordingOptions } from '@/lib/copy-studio/shared/revision-options';
import { sectionText } from './export';
import { buildDesignPrompt } from '@/lib/copy-studio/shared/design-prompt';
import { DesignPromptPanel } from './DesignPromptPanel';
import { ProofBody } from './ProofBody';

function SectionCard({
  section,
  name,
  index,
  issues,
  disabled,
  writingRole,
  onEdit,
  onRevise,
  onCopy,
}: {
  section: Section;
  name: string;
  index: number;
  issues: Issue[];
  disabled: boolean;
  writingRole: ReturnType<typeof sectionWritingRole>;
  onEdit: (s: Section) => boolean;
  onRevise: (id: string, direction: RevisionInput['direction']) => void;
  onCopy: (text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(section);
  const [menuPlacement, setMenuPlacement] = useState({ above: false, space: 400 });
  const empty = !sectionText(section).trim();
  return (
    <article className={`copy-section ${empty ? 'omitted-section' : ''}`}>
      <div className="section-toolbar">
        <span className="section-label">
          {String(index + 1).padStart(2, '0')} <span>{name}</span>
        </span>
        <div className="section-tools">
          {!empty && (
            <button
              className="icon-button"
              title={`Copy ${name}`}
              aria-label={`Copy ${name}`}
              onClick={() => onCopy(sectionText(section))}
            >
              <Copy size={14} />
            </button>
          )}
          <button
            className="icon-button"
            disabled={disabled || editing}
            title={`Edit ${name}`}
            aria-label={`Edit ${name}`}
            onClick={() => {
              setValue(section);
              setEditing(true);
            }}
          >
            <Pencil size={14} />
          </button>
          <details className="rewrite-menu" onToggle={event => {
            if (!event.currentTarget.open) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const below = window.innerHeight - rect.bottom - 16;
            const topBoundary = Math.max(16, ...Array.from(document.querySelectorAll('header')).map(header => {
              const position = window.getComputedStyle(header).position;
              const bounds = header.getBoundingClientRect();
              return ['sticky', 'fixed'].includes(position) && bounds.top <= 0 ? bounds.bottom + 12 : 16;
            }));
            const above = rect.top - topBoundary;
            setMenuPlacement({ above: above > below, space: Math.max(120, Math.max(above, below)) });
          }} onKeyDown={event => {
            if (event.key === 'Escape') {
              event.currentTarget.removeAttribute('open');
              event.currentTarget.querySelector('summary')?.focus();
            }
          }}>
            <summary aria-label={`Rewrite ${name}`} title={`Rewrite ${name}`}>
              <RotateCcw size={14} />
              <ChevronDown size={11} />
            </summary>
            <div className={`rewrite-options ${menuPlacement.above ? 'opens-above' : ''}`}
              style={{ maxHeight: `min(560px, ${menuPlacement.space}px)` }}>
              <div className="rewrite-context">
                <strong>Page framework: {writingRole.framework}</strong>
                <span>Section role: {writingRole.stages.map(stage => stage.stage).join(' + ') || 'Support the page goal'}</span>
                <span>Change the framing within this role.</span>
              </div>
              {sectionAngleOptions(section.id).length > 0 && <div className="rewrite-group-label">Section angle</div>}
              {sectionAngleOptions(section.id).map(({ direction, label }) => (
                <button key={direction} disabled={disabled || editing} onClick={event => {
                  event.currentTarget.closest('details')?.removeAttribute('open');
                  onRevise(section.id, direction);
                }}>{label}</button>
              ))}
              <div className="rewrite-group-label">Wording</div>
              {wordingOptions.map(({ direction, label }) => (
                <button
                  key={direction}
                  disabled={disabled || editing}
                  onClick={(e) => {
                    e.currentTarget.closest('details')?.removeAttribute('open');
                    onRevise(section.id, direction);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </details>
        </div>
      </div>
      {editing ? (
        <form
          className="section-editor"
          onSubmit={(e) => {
            e.preventDefault();
            if (onEdit(value)) setEditing(false);
          }}
        >
          <label>
            Headline
            <input
              value={value.headline}
              maxLength={250}
              onChange={(e) => setValue({ ...value, headline: e.target.value })}
            />
          </label>
          <label>
            Body
            <textarea
              rows={6}
              value={value.body}
              maxLength={section.id === 'proof' ? MAX_PROOF_CHARACTERS : 6000}
              onChange={(e) => setValue({ ...value, body: e.target.value })}
            />
          </label>
          <label>
            Bullets, one per line
            <textarea
              rows={4}
              value={value.bullets.join('\n')}
              onChange={(e) => setValue({ ...value, bullets: e.target.value.split('\n') })}
            />
          </label>
          <label>
            Button label
            <input
              value={value.cta}
              maxLength={120}
              onChange={(e) => setValue({ ...value, cta: e.target.value })}
            />
          </label>
          <div className="row">
            <button type="submit" className="button primary small-button" disabled={disabled}>
              <Check size={14} />
              Save section
            </button>
            <button
              type="button"
              className="button subtle small-button"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : empty ? (
        <p className="omitted-message">
          <ShieldCheck size={17} />
          Omitted until you add the facts needed for this section.
        </p>
      ) : (
        <div className="section-copy">
          {section.headline && <h3>{section.headline}</h3>}
          {section.body && (section.id === 'proof' ? <ProofBody body={section.body} /> : <p>{section.body}</p>)}
          {section.bullets.length > 0 && (
            <ul>
              {section.bullets.map((bullet, i) => (
                <li key={i}>{bullet}</li>
              ))}
            </ul>
          )}
          {section.cta && (
            <span className="draft-cta">
              {section.cta}
              <ArrowUpRight size={14} />
            </span>
          )}
        </div>
      )}
      {issues.length > 0 && (
        <div className="section-issues">
          {issues.map((issue, i) => (
            <p key={i}>
              <AlertCircle size={14} />
              {issue.message}
            </p>
          ))}
        </div>
      )}
    </article>
  );
}

export function DraftPanel({
  project,
  busy,
  stage,
  stale,
  onCancel,
  onEdit,
  onRevise,
  onUndo,
  onCopy,
  onExport,
  onExportDesign,
  onExample,
}: {
  project: Project;
  busy: boolean;
  stage: string | null;
  stale: boolean;
  onCancel: () => void;
  onEdit: (s: Section) => boolean;
  onRevise: (id: string, direction: RevisionInput['direction']) => void;
  onUndo: () => void;
  onCopy: (text?: string) => void;
  onExport: () => void;
  onExportDesign: (prompt: string) => void;
  onExample: () => void;
}) {
  const [view, setView] = useState<'sections' | 'preview' | 'design'>('sections');
  const result = project.result;
  let draftTemplate: TemplateId = project.template;
  try {
    if (project.generatedFrom) draftTemplate = JSON.parse(project.generatedFrom).template;
  } catch {
    /* validated project fallback */
  }
  const template =
    templates[result ? draftTemplate : project.template] || templates[project.template];
  const previousTemplate = Boolean(result && isLegacyDirectCallDraft(result.draft, project.template));
  const wordCount =
    result?.draft.sections.map(sectionText).join(' ').trim().split(/\s+/).filter(Boolean).length ||
    0;
  return (
    <section className="draft-panel" id="copy-draft" aria-labelledby="draft-heading">
      <a className="copy-mobile-back" href="#copy-brief">↑ Back to brief</a>
      <div className="panel-heading draft-heading">
        <div className="panel-number" aria-hidden="true"><PenLine size={16} /></div>
        <div>
          <h2 id="draft-heading">Make every word work</h2>
          <p>Review sections, refine the writing, and export your page.</p>
        </div>
        {result && <span className="word-count">{wordCount} words</span>}
      </div>
      {stage && (
        <div className="generation-progress" role="status">
          <span className="progress-orbit">
            <LoaderCircle size={23} className="spin" />
          </span>
          <div>
            <strong>{stage}</strong>
            <small>This can take a few minutes. Your previous draft stays safe.</small>
          </div>
          <button
            onClick={onCancel}
            className="icon-button"
            title="Cancel request"
            aria-label="Cancel request"
          >
            <X size={17} />
          </button>
        </div>
      )}
      {!result ? (
        <div className="draft-empty">
          <div className="empty-intro">
            <span className="eyebrow">YOUR PAGE OUTLINE</span>
            <h3>Your first draft starts with the brief.</h3>
            <p>
              Add the five essentials or prefill from a source. Your generated copy and design prompt will appear here.
            </p>
          </div>
          <div className="outline-card">
            <div className="outline-title">
              <FileText size={17} />
              <strong>Your {template.name.toLowerCase()} blueprint</strong>
              <span>{template.sections.length} sections</span>
            </div>
            <ol>
              {template.sections.map((s, i) => (
                <li key={s.id}>
                  <span>{String(i + 1).padStart(2, '0')}</span>
                  <div>
                    <strong>{s.name}</strong>
                    <small>{s.purpose}</small>
                  </div>
                  <Check size={14} />
                </li>
              ))}
            </ol>
          </div>
          <div className="empty-footer">
            <span>Want to get a feel for the workflow?</span>
            <button onClick={onExample} disabled={busy}>
              Try a sample brief <ArrowUpRight size={14} />
            </button>
          </div>
        </div>
      ) : (
        <>
          {stale && (
            <div className="notice warning">
              <AlertCircle size={17} />
              <div>
                <strong>{previousTemplate ? 'This draft uses the earlier template.' : 'Your brief has changed.'}</strong>
                <p>
                  {previousTemplate
                    ? 'Generate a new draft to add About me and the updated section headings. Your existing copy stays saved; section editing is paused.'
                    : 'Generate a new draft to apply the changes. This draft still reflects the earlier brief; section editing is paused.'}
                </p>
              </div>
            </div>
          )}
          <details className="strategy-card">
            <summary className="strategy-summary">
              <span className="strategy-title"><Sparkles size={16} /><span>Page strategy</span></span>
              <span className="strategy-summary-meta">{result.draft.strategy.framework?.name || 'Earlier draft'}<span className="strategy-summary-hint">View the reasoning</span><ChevronDown size={15} /></span>
            </summary>
            <div className="strategy-content">
            {result.draft.strategy.framework && <p className="field-hint"><strong>{result.draft.strategy.framework.name}</strong>{result.draft.strategy.framework.recommended ? ' · Recommended for this page' : ' · Selected framework'}</p>}
            {!result.draft.strategy.framework && <p className="field-hint">This earlier draft has no recorded framework. Generate a new draft to apply the current framework plan.</p>}
            <h3>{result.draft.strategy.angle}</h3>
            <p>{result.draft.strategy.promise}</p>
              <dl>
                {result.draft.strategy.framework && <><dt>Why this framework</dt><dd>{result.draft.strategy.framework.reason}</dd></>}
                {result.draft.strategy.frameworkPlan?.map(step => <div key={step.stage}><dt>{step.stage}</dt><dd>{step.application} <small>Sections: {step.sectionIds.map(id => template.sections.find(section => section.id === id)?.name || id).join(', ')}</small></dd></div>)}
                <dt>Hesitation to address</dt>
                <dd>{result.draft.strategy.objection || 'No specific objection supplied.'}</dd>
                <dt>The action</dt>
                <dd>{result.draft.strategy.action}</dd>
                {result.draft.strategy.missingEvidence.length > 0 && (
                  <>
                    <dt>Facts to strengthen the page</dt>
                    <dd>{result.draft.strategy.missingEvidence.join(' ')}</dd>
                  </>
                )}
              </dl>
            </div>
          </details>
          <div className="draft-actions">
            <div className="segmented" aria-label="Draft views">
              <button
                className={view === 'sections' ? 'active' : ''}
                aria-pressed={view === 'sections'}
                onClick={() => setView('sections')}
              >
                <FileText size={14} />
                Sections
              </button>
              <button
                className={view === 'preview' ? 'active' : ''}
                aria-pressed={view === 'preview'}
                onClick={() => setView('preview')}
              >
                <Eye size={14} />
                Preview
              </button>
              <button
                className={view === 'design' ? 'active' : ''}
                aria-pressed={view === 'design'}
                onClick={() => setView('design')}
              >
                <PanelTop size={14} />
                Design prompt
              </button>
            </div>
            {view !== 'design' && (
            <div className="row">
              <button
                className="icon-button"
                title="Undo the last draft change"
                aria-label="Undo the last draft change"
                disabled={busy || !project.history.length}
                onClick={onUndo}
              >
                <Undo2 size={16} />
              </button>
              <button className="button subtle small-button" onClick={() => onCopy()}>
                <Copy size={14} />
                Copy
              </button>
              <button className="button secondary small-button" onClick={onExport}>
                <ArrowDownToLine size={14} />
                Export
              </button>
            </div>
            )}
          </div>
          <div className="review-status">
            <ShieldCheck size={15} />
            <span>
              {result.issues.length
                ? `${result.issues.length} point${result.issues.length === 1 ? '' : 's'} to review before publishing`
                : 'Automated checks complete. Review facts before publishing.'}
            </span>
          </div>
          {view === 'design' ? (
            <DesignPromptPanel
              prompt={buildDesignPrompt(project)}
              busy={busy}
              onCopy={onCopy}
              onExport={() => onExportDesign(buildDesignPrompt(project))}
            />
          ) : view === 'sections' ? (
            <div className="copy-sections">
              {result.draft.sections.map((section, i) => (
                <SectionCard
                  key={`${project.id}-${section.id}`}
                  section={section}
                  index={i}
                  name={template.sections.find((s) => s.id === section.id)?.name || section.id}
                  issues={result.issues.filter((v) => v.sectionId === section.id)}
                  disabled={busy || stale}
                  writingRole={sectionWritingRole({ ...project, template: draftTemplate,
                    formula: result.draft.strategy.framework?.id || project.formula }, section.id)}
                  onCopy={onCopy}
                  onEdit={onEdit}
                  onRevise={onRevise}
                />
              ))}
            </div>
          ) : (
            <div className="page-preview">
              {result.draft.sections
                .filter((s) => sectionText(s).trim())
                .map((section) => (
                  <div className={`preview-section preview-${section.id}`} key={section.id}>
                    <h3>{section.headline}</h3>
                    {section.id === 'proof' ? <ProofBody body={section.body} /> : <p>{section.body}</p>}
                    {section.bullets.length > 0 && (
                      <ul>
                        {section.bullets.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    )}
                    {section.cta && (
                      <span className="draft-cta">
                        {section.cta}
                        <ArrowUpRight size={15} />
                      </span>
                    )}
                  </div>
                ))}
            </div>
          )}
          {result.draft.notes.length > 0 && (
            <details className="writer-notes" open>
              <summary>
                <Pencil size={15} />
                Writer’s notes <ChevronDown size={14} />
              </summary>
              <ul>
                {result.draft.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
              <p>Notes and review flags are kept out of the copy export.</p>
            </details>
          )}
        </>
      )}
    </section>
  );
}
