import {
  ArrowRight,
  Check,
  ChevronDown,
  FileText,
  Link2,
  LoaderCircle,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-react';
import {
  fieldLabels,
  requiredKeys,
  type BriefKey,
  type Project,
  type TemplateId,
  type FormulaId,
  copyContextSchema,
  type CopyContext,
  type ReferenceMode,
} from '@/lib/copy-studio/shared/contracts';
import { ReferencePanel } from './ReferencePanel';
import { templates, formulas } from '@/lib/copy-studio/shared/templates';

const placeholders: Partial<Record<BriefKey, string>> = {
  offerName: 'e.g. The Clear Offer Sprint',
  description:
    'The service, program, or resource you offer. Include its format and what makes it useful.',
  audience: 'Be specific: their role, situation, and who is a good fit.',
  problem: 'What are they struggling with right now? What have they already tried?',
  outcome: 'The meaningful change they want. Describe a goal, not a guaranteed result.',
  mechanism: 'Explain the approach and why it addresses the problem.',
  deliverables: 'List the actual sessions, resources, services, or features included.',
  proof:
    'Paste real testimonials, case studies, results, or credentials. Include exact quotes and context.',
  coachBio:
    'The coach’s name, relevant background, experience, qualifications, and why they work with this audience. Include only details approved for the page.',
  objections: 'What might stop a qualified person from taking the next step?',
  price: 'Exact price, currency, and payment terms, if relevant.',
  guarantee: 'Only the guarantee or refund policy you actually offer.',
  urgency: 'Only a real deadline or capacity limit. Leave blank if there is none.',
  customerLanguage: 'Phrases you hear in customer conversations or research.',
  nextStep: 'Call length, delivery method, or what they can expect after taking action.',
};
const essential: BriefKey[] = ['offerName', 'description', 'audience', 'problem', 'outcome'];
const substance: BriefKey[] = ['mechanism', 'deliverables', 'coachBio', 'proof', 'objections'];
const details: BriefKey[] = [
  'price',
  'guarantee',
  'urgency',
  'customerLanguage',
  'cta',
  'nextStep',
  'voice',
];

export function BriefPanel({
  project,
  disabled,
  attempted,
  stage,
  onCancel,
  onBrief,
  onTemplate,
  onFormula,
  onImport,
  onGenerate,
  onOnboarding,
  onContext,
  onboardingNote,
  onDetachOnboarding,
  onReferenceMode,
}: {
  project: Project;
  disabled: boolean;
  attempted: boolean;
  stage: string | null;
  onCancel: () => void;
  onBrief: (key: BriefKey, value: string) => void;
  onTemplate: (value: TemplateId) => void;
  onFormula: (value: FormulaId) => void;
  onImport: () => void;
  onGenerate: () => void;
  onOnboarding: () => void;
  onContext: (value: CopyContext) => void;
  onboardingNote: string;
  onDetachOnboarding: () => void;
  onReferenceMode: (value: ReferenceMode) => void;
}) {
  const context = copyContextSchema.parse(project.context || {});
  const count = requiredKeys.filter((k) => project.brief[k].trim().length >= 3).length;
  const field = (key: BriefKey) => {
    const required = essential.includes(key);
    const invalid = attempted && required && project.brief[key].trim().length < 3;
    const props = {
      id: `brief-${key}`,
      value: project.brief[key] ?? '',
      maxLength: 6000,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onBrief(key, e.target.value),
      placeholder: key === 'cta' ? templates[project.template].action : placeholders[key],
      'aria-invalid': invalid,
      'aria-describedby': invalid ? `error-${key}` : undefined,
      required,
    };
    return (
      <div className={`field ${invalid ? 'invalid' : ''}`} key={key}>
        <label htmlFor={props.id}>
          {fieldLabels[key]}
          {required && (
            <span className="required" aria-hidden="true">
              *
            </span>
          )}
          {!required && <span className="optional">Optional</span>}
        </label>
        {['offerName', 'cta', 'voice', 'price'].includes(key) ? (
          <input {...props} />
        ) : (
          <textarea {...props} rows={key === 'proof' ? 4 : 3} />
        )}
        {invalid && (
          <small className="field-error" id={`error-${key}`}>
            Add at least 3 characters to complete this field.
          </small>
        )}
        {key === 'proof' && (
          <small className="field-hint">
            No proof yet? Leave this empty. We’ll omit the proof block.
          </small>
        )}
        {key === 'coachBio' && (
          <small className="field-hint">
            Used for the About me section. Add the coach’s actual background; leave empty to omit it until you have the details.
          </small>
        )}
        {key === 'voice' && project.source && project.referenceMode !== 'off' && (
          <small className="field-hint">The original voice is preserved by default. Add a specific instruction here when you want to change it.</small>
        )}
        {key === 'urgency' && (
          <small className="field-hint">
            No scarcity switches. Only facts you can stand behind.
          </small>
        )}
      </div>
    );
  };
  return (
    <section className="brief-panel" aria-labelledby="brief-heading">
      <div className="panel-heading">
        <div className="panel-number">01</div>
        <div>
          <h2 id="brief-heading">Shape the brief</h2>
          <p>Good copy starts with a clear offer.</p>
        </div>
      </div>
      <button className="import-trigger onboarding-trigger" onClick={onOnboarding} disabled={disabled}>
        <span className="import-icon"><UserRound size={18} /></span>
        <span><strong>{project.onboarding ? project.onboarding.clientName || project.onboarding.projectName : 'Choose client onboarding'}</strong>
          <small>{project.onboarding ? project.onboarding.projectName : 'Find the client and review their answers'}</small></span>
        <ArrowRight size={17} />
      </button>
      {onboardingNote && <p className="onboarding-status" role="status">{onboardingNote}</p>}
      {project.onboarding && <button className="text-button small onboarding-unlink" disabled={disabled} onClick={onDetachOnboarding}>Unlink client</button>}
      <fieldset disabled={disabled} className="offer-scope">
        <legend className="eyebrow">WHAT ARE WE WRITING FOR?</legend>
        <div className="offer-mode-options" role="radiogroup" aria-label="Offer focus">
          {([
            ['current', project.onboarding ? 'The onboarding offer' : 'My current offer'],
            ['focused', 'One specific offer'],
            ['new', 'A new offer'],
          ] as const).map(([value, label]) => <label key={value} className={context.mode === value ? 'selected' : ''}>
            <input type="radio" name="offer-mode" checked={context.mode === value} onChange={() => onContext({ ...context, mode: value })} />{label}
          </label>)}
        </div>
        <p className="field-hint">{context.mode === 'focused' ? 'Name the offer below. When importing a page, choose that offer so its facts stay separate.' : context.mode === 'new' ? 'Build the brief around the new offer. Use client answers for context and edit the facts to fit.' : 'Use the brief below to define the offer. A page is optional.'} Each option keeps its own brief, so you can switch back without losing edits.</p>
        <details className="brief-accordion">
          <summary><span><Sparkles size={17} /> Creative direction & client notes</span><ChevronDown size={16} /></summary>
          <div className="accordion-content">
            {([
              ['direction', 'What should this page do differently?', 'e.g. Focus on the executive program for newly promoted leaders. Position the call as a fit assessment.'],
              ['background', 'Client context & traffic', 'Traffic sources, buyer awareness, qualification, or relevant client notes.'],
              ['mustKeep', 'What must stay?', 'Client preferences, approved wording, or brand requirements.'],
              ['avoid', 'What should we avoid?', 'Other offers, angles, terms, or language to leave out.'],
            ] as const).map(([key, label, placeholder]) => <div className="field" key={key}><label htmlFor={`context-${key}`}>{label}</label><textarea id={`context-${key}`} rows={3} maxLength={6000} value={context[key]} placeholder={placeholder} onChange={(event) => onContext({ ...context, [key]: event.target.value })} /></div>)}
          </div>
        </details>
      </fieldset>
      <button className="import-trigger" onClick={onImport} disabled={disabled}>
        <span className="import-icon">
          <Link2 size={18} />
        </span>
        <span>
          <strong>Start with an existing page</strong>
          <small>Add the original copy for its voice and context. Your brief and changes guide the rewrite.</small>
        </span>
        <ArrowRight size={17} />
      </button>
      {project.source && (
        <ReferencePanel source={project.source} mode={project.referenceMode || 'preserve_voice'} disabled={disabled} onMode={onReferenceMode} onChange={onImport} />
      )}
      <fieldset disabled={disabled} className="brief-fields">
        <div className="field-group-header">
          <span className="eyebrow">PAGE GOAL</span>
        </div>
        <div className="template-options" role="radiogroup" aria-label="Page goal">
          {Object.values(templates).map((t, index) => (
            <label
              className={`template-option ${project.template === t.id ? 'selected' : ''}`}
              key={t.id}
            >
              <input
                type="radio"
                name="template"
                value={t.id}
                checked={project.template === t.id}
                onChange={() => onTemplate(t.id)}
              />
              <span className="template-glyph">{index === 0 ? '↗' : index === 1 ? '↓' : '▷'}</span>
              <span>
                <strong>{t.name}</strong>
                <small>{t.short}</small>
              </span>
              <span className="radio-mark">{project.template === t.id && <span />}</span>
            </label>
          ))}
        </div>
        <div className="field-group-header essential-header">
          <span className="eyebrow">THE ESSENTIALS</span>
          <span className={`completion ${count === 5 ? 'complete' : ''}`}>
            {count === 5 && <Check size={12} />}
            {count}/5 complete
          </span>
        </div>
        {essential.map(field)}
        <details className="brief-accordion">
          <summary>
            <span>
              <ShieldCheck size={17} /> Give the copy substance
            </span>
            <ChevronDown size={16} />
          </summary>
          <div className="accordion-content">
            <p className="muted small">Specifics make your offer credible. Add what you know.</p>
            {substance.filter(key => key !== 'coachBio' || project.template === 'direct_to_call').map(field)}
          </div>
        </details>
        <details className="brief-accordion">
          <summary>
            <span>
              <FileText size={17} /> Terms, voice & next step
            </span>
            <ChevronDown size={16} />
          </summary>
          <div className="accordion-content">{details.map(field)}</div>
        </details>
        <details className="brief-accordion">
          <summary>
            <span>
              <Sparkles size={17} /> Writing approach
            </span>
            <ChevronDown size={16} />
          </summary>
          <div className="accordion-content">
            <div className="field">
              <label htmlFor="formula">Persuasion framework</label>
              <select
                id="formula"
                value={project.formula}
                onChange={(e) => onFormula(e.target.value as FormulaId)}
              >
                {Object.entries(formulas).map(([id, formula]) => (
                  <option key={id} value={id}>
                    {formula.name}
                  </option>
                ))}
              </select>
              <small className="field-hint">{formulas[project.formula].description}</small>
            </div>
          </div>
        </details>
      </fieldset>
      <div className="generate-bar">
        <button className="button primary generate-button" onClick={onGenerate} disabled={disabled}>
          {disabled ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}
          {disabled
            ? 'Working on your request…'
            : project.result
              ? 'Generate a new draft'
              : 'Generate my copy'}
          {!disabled && <ArrowRight size={17} />}
        </button>
        <p role={disabled ? 'status' : undefined}>
          {stage || 'Built around your offer. Grounded in your facts.'}
        </p>
        {disabled && (
          <button className="text-button" onClick={onCancel}>
            Cancel request
          </button>
        )}
      </div>
    </section>
  );
}
