'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  Check,
  CheckCheck,
  CircleHelp,
  LoaderCircle,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  fingerprint,
  MAX_PROOF_CHARACTERS,
  projectSchema,
  requiredKeys,
  sectionSchema,
  type Project,
  type RevisionInput,
  type Section,
  briefSchema,
  copyContextSchema,
  onboardingLinkSchema,
} from '@/lib/copy-studio/shared/contracts';
import { matchOnboardings, type OnboardingBrief } from '@/lib/copy-studio/shared/onboarding';
import { changeOfferContext } from '@/lib/copy-studio/shared/workspace';
import { applyRecoveredEvidence, needsEvidenceReview, recordEvidenceReview } from '@/lib/copy-studio/shared/evidence-recovery';
import { mergeDraftIssues, isLegacyDirectCallDraft, validateStructure } from '@/lib/copy-studio/shared/quality';
import { generateCopy, reviseCopy, testConnection, loadOnboardings } from './api';
import {
  loadProjects,
  newProject,
  sampleProject,
  saveProjects,
  download,
  storageKey,
} from './storage';
import { exportMarkdown } from './export';
import { BriefPanel } from './BriefPanel';
import { DraftPanel } from './DraftPanel';
import { ImportDialog } from './ImportDialog';
import { EvidenceRecoveryDialog } from './EvidenceRecoveryDialog';
import { OnboardingDialog } from './OnboardingDialog';
import './copy-studio.css';

export default function CopyStudio() {
  const [initial] = useState(loadProjects);
  const [projects, setProjects] = useState(initial.projects);
  const [activeId, setActiveId] = useState(initial.projects[0].id);
  const [saveError, setSaveError] = useState(initial.error);
  const [savingPaused, setSavingPaused] = useState(Boolean(initial.error));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [evidenceProject, setEvidenceProject] = useState<Project | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardings, setOnboardings] = useState<OnboardingBrief[]>([]);
  const [onboardingLoading, setOnboardingLoading] = useState(false);
  const [onboardingError, setOnboardingError] = useState('');
  const onboardingRequest = useRef<AbortController | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [health, setHealth] = useState<{ configured: boolean; model: string } | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [connectionVerified, setConnectionVerified] = useState(false);
  const request = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const project = projects.find((p) => p.id === activeId) || projects[0];
  const stale = Boolean(project.result && (project.generatedFrom !== fingerprint(project) ||
    isLegacyDirectCallDraft(project.result.draft, project.template)));
  const linkedOnboarding = onboardings.find((record) => record.id === project.onboarding?.id);
  const onboardingMatches = matchOnboardings(onboardings, project.source?.source.url || '');
  const onboardingNote = project.onboarding
    ? linkedOnboarding && linkedOnboarding.revision !== project.onboarding.revision
      ? 'New onboarding answers are available. Open the client brief to review them.'
      : linkedOnboarding && requiredKeys.some(key => linkedOnboarding.brief[key].trim().length < 3)
        ? 'This onboarding is missing essential answers. Prefill from page or add the missing details below.'
      : 'Client answers are saved with this project. You can review and edit them anytime.'
    : onboardingMatches.length
      ? `${onboardingMatches.length === 1 ? 'Client onboarding found for this website.' : `${onboardingMatches.length} onboarding projects match this website.`} Choose the client brief above.`
      : '';
  const refreshOnboardings = () => {
    onboardingRequest.current?.abort();
    const controller = new AbortController();
    onboardingRequest.current = controller;
    setOnboardingLoading(true);
    setOnboardingError('');
    const timeout = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 20000);
    void loadOnboardings(controller.signal).then(setOnboardings).catch((error) => {
      if (!controller.signal.aborted || controller.signal.reason?.name === 'TimeoutError')
        setOnboardingError(error instanceof Error ? error.message : 'Onboarding could not be loaded. Please retry.');
    }).finally(() => {
      clearTimeout(timeout);
      if (onboardingRequest.current === controller) setOnboardingLoading(false);
    });
  };
  useEffect(() => {
    refreshOnboardings();
    return () => onboardingRequest.current?.abort();
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/copy-studio/health', { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(setHealth)
      .catch(() => {
        if (!abort.signal.aborted) setHealthFailed(true);
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (savingPaused) return;
    setSaved(false);
    const issue = saveProjects(projects);
    const timer = setTimeout(() => {
      setSaveError(issue);
      setSaved(!issue);
    }, 300);
    const flush = () => {
      saveProjects(projects);
    };
    window.addEventListener('pagehide', flush);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pagehide', flush);
    };
  }, [projects, savingPaused]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => () => request.current?.abort(), []);

  const update = (transform: (p: Project) => Project, id = project.id) => {
    setProjects((old) =>
      old.map((p) => (p.id === id ? { ...transform(p), updatedAt: new Date().toISOString() } : p)),
    );
  };
  const snapshot = (p: Project) =>
    p.result
      ? [...p.history, { result: p.result, generatedFrom: p.generatedFrom }].slice(-8)
      : p.history;
  const select = (id: string) => {
    setActiveId(id);
    setError('');
    setAttempted(false);
  };
  const add = (sample = false) => {
    if (projects.length >= 100) {
      setError('You have reached 100 projects. Export and remove an older project first.');
      return;
    }
    const next = sample ? sampleProject() : newProject();
    setProjects((old) => [next, ...old]);
    select(next.id);
  };
  const execute = async (task: (signal: AbortSignal) => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    request.current = controller;
    const timer = setTimeout(
      () => controller.abort(new DOMException('Timed out', 'TimeoutError')),
      310000,
    );
    try {
      await task(controller.signal);
    } catch (err) {
      if (controller.signal.aborted && controller.signal.reason?.name !== 'TimeoutError')
        setToast('Request cancelled. Your previous draft is unchanged.');
      else setError(err instanceof Error ? err.message : 'The request failed. Please try again.');
    } finally {
      clearTimeout(timer);
      setBusy(false);
      setStage(null);
      request.current = null;
      inFlight.current = false;
    }
  };
  const generate = (captured = project, evidenceReviewed = false) => {
    setAttempted(true);
    const missing = requiredKeys.find((k) => captured.brief[k].trim().length < 3);
    if (missing) {
      document.getElementById(`brief-${missing}`)?.focus();
      setError('Complete the five essential fields so the copy can be specific to your offer.');
      return;
    }
    if (!evidenceReviewed && needsEvidenceReview(captured)) {
      setEvidenceProject(captured);
      return;
    }
    void execute(async (signal) => {
      setStage('Preparing your brief');
      const result = await generateCopy(captured, signal, setStage);
      signal.throwIfAborted();
      update(
        (p) => ({ ...p, result, generatedFrom: fingerprint(captured), history: snapshot(p) }),
        captured.id,
      );
      setToast('Your draft is ready. Open Design prompt to take the page into ChatGPT.');
    });
  };
  const revise = (sectionId: string, direction: RevisionInput['direction']) => {
    const captured = project;
    if (!captured.result || stale) return;
    void execute(async (signal) => {
      setStage('Refining your selected section');
      const result = await reviseCopy(
        { ...captured, draft: captured.result!.draft, sectionId, direction },
        signal,
      );
      signal.throwIfAborted();
      update((p) => {
        if (!p.result) return p;
        const draft = {
          ...p.result.draft,
          sections: p.result.draft.sections.map((s) => (s.id === sectionId ? result.section : s)),
        };
        return {
          ...p,
          history: snapshot(p),
          result: { draft, issues: mergeDraftIssues(draft, p.brief, p.result.issues, [sectionId], result.issues) },
        };
      }, captured.id);
      setToast('Section updated. Use Undo to restore the previous version.');
    });
  };
  const edit = (section: Section) => {
    const parsed = sectionSchema.safeParse({
      ...section,
      bullets: section.bullets.filter((b) => b.trim()),
    });
    if (!parsed.success) {
      setError(
        `Keep this section within 8 bullets, 800 characters per bullet, and ${(section.id === 'proof' ? MAX_PROOF_CHARACTERS : 6000).toLocaleString('en-US')} characters of body copy.`,
      );
      return false;
    }
    if (!project.result) return false;
    const draft = {
      ...project.result.draft,
      sections: project.result.draft.sections.map((s) => (s.id === section.id ? parsed.data : s)),
    };
    try {
      validateStructure(draft, project.template, true);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Keep a headline and useful copy in required sections.',
      );
      return false;
    }
    update((p) => ({
      ...p,
      history: snapshot(p),
      result: { draft, issues: mergeDraftIssues(draft, p.brief, p.result?.issues || [], []) },
    }));
    setToast('Section saved.');
    return true;
  };
  const copy = async (text?: string) => {
    try {
      await navigator.clipboard.writeText(text ?? exportMarkdown(project));
      setToast('Copied to clipboard.');
    } catch {
      setError('Clipboard access is unavailable. Use Export to download the copy instead.');
    }
  };
  const importProject = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw new Error('Project files must be smaller than 5 MB.');
      const parsed = projectSchema.parse(JSON.parse(await file.text()));
      if (parsed.result) {
        const template = parsed.generatedFrom
          ? JSON.parse(parsed.generatedFrom).template
          : parsed.template;
        validateStructure(parsed.result.draft, template, true);
      }
      if (projects.length >= 100)
        throw new Error('Export and remove an older project before importing another.');
      const imported = { ...parsed, id: crypto.randomUUID(), updatedAt: new Date().toISOString() };
      setProjects((old) => [imported, ...old]);
      select(imported.id);
      setToast('Project imported.');
    } catch (err) {
      setError(
        err instanceof Error && !err.message.startsWith('[')
          ? err.message
          : 'This is not a valid Copy Studio project backup.',
      );
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const backup = () =>
    download(
      `${slug(project.name)}.copy-studio.json`,
      JSON.stringify(project, null, 2),
      'application/json',
    );
  const deleteProject = () => {
    if (
      !window.confirm(
        `Delete “${project.name}” from this browser? Download a project backup first if you want to keep it.`,
      )
    )
      return;
    const remaining = projects.filter((p) => p.id !== project.id);
    if (!remaining.length) remaining.push(newProject());
    setProjects(remaining);
    select(remaining[0].id);
  };

  return (
    <div className="copy-studio">
      <div className="copy-workspace">
        <div className="copy-project-toolbar">
          <label className="copy-project-picker">
            <span className="label-micro">Project</span>
            <select
              aria-label="Choose a copy project"
              value={project.id}
              disabled={busy}
              onChange={(event) => select(event.target.value)}
            >
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-outline" onClick={() => add()} disabled={busy}>
            <Plus size={15} />
            New project
          </button>
          <details className="copy-tools">
            <summary className="btn btn-ghost">
              <Settings2 size={15} />
              Tools
            </summary>
            <div className="copy-tools-menu panel">
              <button
                disabled={busy}
                onClick={(event) => {
                  event.currentTarget.closest('details')?.removeAttribute('open');
                  fileInput.current?.click();
                }}
              >
                <Upload size={15} />
                Import a project
              </button>
              <button
                onClick={(event) => {
                  event.currentTarget.closest('details')?.removeAttribute('open');
                  setSettingsOpen((value) => !value);
                }}
              >
                <Settings2 size={15} />
                Setup & storage
              </button>
            </div>
          </details>
          <div className="topbar-status">
            <span className={`save-status ${saveError ? 'save-failed' : ''}`}>
              {saved ? (
                <CheckCheck size={15} />
              ) : saveError ? (
                <CircleHelp size={15} />
              ) : (
                <LoaderCircle size={14} />
              )}
              {saveError ? 'Not saved' : saved ? 'Saved locally' : 'Saving…'}
            </span>
            <span
              className={`provider-status ${health?.configured ? '' : 'offline'}`}
              title={
                health
                  ? `Model: ${health.model}. Connection is checked when you generate.`
                  : 'Checking the server'
              }
            >
              <i />
              {connectionVerified
                ? 'AI connected'
                : health?.configured
                  ? 'AI configured'
                  : healthFailed
                    ? 'Server offline'
                    : health
                      ? 'Setup needed'
                      : 'Connecting'}
            </span>
          </div>
        </div>
        <div className="copy-main-content">
          <div className="page-header">
            <div>
              <div className="project-context">Landing page workspace</div>
              <input
                className="project-title"
                aria-label="Project name"
                value={project.name}
                maxLength={200}
                disabled={busy}
                onChange={(e) => update((p) => ({ ...p, name: e.target.value }))}
                onBlur={() => {
                  if (!project.name.trim()) update((p) => ({ ...p, name: 'Untitled project' }));
                }}
              />
              <p>Manage the brief, review your copy, and prepare the design handoff.</p>
            </div>
            <div className="page-header-actions">
              <button className="button secondary" onClick={backup}>
                <ArrowDownToLine size={16} />
                <span>Project backup</span>
              </button>
              <button
                className="icon-button delete-project"
                aria-label="Delete project"
                title="Delete project"
                onClick={deleteProject}
                disabled={busy}
              >
                <Trash2 size={17} />
              </button>
            </div>
          </div>
          {saveError && (
            <div className="notice error" role="alert">
              <div>
                <strong>{saveError}</strong>
                <div className="row">
                  <button className="text-button" onClick={backup}>
                    Download current project
                  </button>
                  {savingPaused && (
                    <>
                      <button
                        className="text-button"
                        onClick={() => {
                          try {
                            download(
                              'copy-studio-recovery.json',
                              localStorage.getItem(storageKey) || '{}',
                              'application/json',
                            );
                          } catch {
                            setError('Browser storage could not be accessed.');
                          }
                        }}
                      >
                        Download saved data
                      </button>
                      <button
                        className="text-button"
                        onClick={() => {
                          if (
                            window.confirm(
                              'Replace unreadable browser data with the current workspace? Download the saved data first.',
                            )
                          )
                            setSavingPaused(false);
                        }}
                      >
                        Reset saved data
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              <div>{error}</div>
              <button
                className="icon-button"
                onClick={() => setError('')}
                aria-label="Dismiss error"
              >
                <X size={17} />
              </button>
            </div>
          )}
          {(settingsOpen || (health && !health.configured) || healthFailed) && (
            <section className="settings-card">
              <div>
                <h2>
                  <Settings2 size={18} />
                  Setup & storage
                </h2>
                <p>
                  Projects are saved in this browser on this address. Download a project backup to
                  move devices or protect against cleared browser data.
                </p>
                <p>
                  AI: <strong>{health?.model || 'Server unavailable'}</strong>. Set{' '}
                  <code>COPY_STUDIO_API_KEY</code> in <code>.env.local</code>. Optional:{' '}
                  <code>COPY_STUDIO_BASE_URL</code> and <code>COPY_STUDIO_MODEL</code>. Restart the
                  server after changes. Your key stays on the server.
                </p>
                <p>
                  Offer details and imported copy are sent to your configured AI provider when you
                  request generation, extraction, or revision.
                </p>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void execute(async (signal) => {
                      setStage('Testing the AI connection');
                      await testConnection(signal);
                      setConnectionVerified(true);
                      setToast('AI connection confirmed. You can generate copy now.');
                    })
                  }
                >
                  {busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}Test
                  AI connection
                </button>
              </div>
              <button
                className="icon-button"
                aria-label="Close setup"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={17} />
              </button>
            </section>
          )}
          <nav className="copy-mobile-sections" aria-label="Copy editor sections"><a href="#copy-brief">Edit brief</a><a href="#copy-draft">Review draft ↓</a></nav>
          <div className="editor-grid">
            <BriefPanel
              project={project}
              disabled={busy}
              attempted={attempted}
              stage={stage}
              onCancel={() => request.current?.abort()}
              onBrief={(key, value) =>
                update((p) => {
                  const next = {
                    ...p,
                    brief: { ...p.brief, [key]: value },
                    name:
                      key === 'offerName' &&
                      (p.name === 'Untitled project' || p.name === p.brief.offerName)
                        ? value || 'Untitled project'
                        : p.name,
                  };
                  return key === 'proof' ? recordEvidenceReview(next, value.trim() ? 'included' : 'excluded') : next;
                })
              }
              onTemplate={(template) => update((p) => ({ ...p, template }))}
              onFormula={(formula) => update((p) => ({ ...p, formula }))}
              onImport={() => setImportOpen(true)}
              onGenerate={() => generate()}
              onReviewEvidence={() => setEvidenceProject(project)}
              onOnboarding={() => { setOnboardingOpen(true); refreshOnboardings(); }}
              onboardingNote={onboardingNote}
              onDetachOnboarding={() => update((p) => ({ ...p, onboarding: null }))}
              onContext={(context) => update((p) => changeOfferContext(p, context))}
              onReferenceMode={(referenceMode) => update((p) => ({ ...p, referenceMode }))}
            />
            <DraftPanel
              project={project}
              busy={busy}
              stage={stage}
              stale={stale}
              onCancel={() => request.current?.abort()}
              onEdit={edit}
              onRevise={revise}
              onUndo={() =>
                update((p) => {
                  const previous = p.history.at(-1);
                  return previous ? { ...p, ...previous, history: p.history.slice(0, -1) } : p;
                })
              }
              onCopy={copy}
              onExport={() =>
                download(`${slug(project.name)}.md`, exportMarkdown(project), 'text/markdown')
              }
              onExportDesign={(prompt) =>
                download(`${slug(project.name)}-design-prompt.txt`, prompt, 'text/plain')
              }
              onExample={() => add(true)}
            />
          </div>
        </div>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {importOpen && (
        <ImportDialog
          current={project.brief}
          initial={project.source}
          targetOffer={project.context?.mode === 'focused' ? project.brief.offerName.slice(0, 200) : ''}
          initialUrl={linkedOnboarding?.landingPageUrl || linkedOnboarding?.website || ''}
          projectLimitReached={projects.length >= 100}
          onClose={() => setImportOpen(false)}
          onApply={(source, keys, separateOffer) => {
            if (separateOffer) {
              if (projects.length >= 100) return;
              const brief = briefSchema.parse({ voice: project.brief.voice });
              for (const key of keys) brief[key] = source.extraction.fields[key] || '';
              const next: Project = {
                ...newProject(), brief, source, onboarding: project.onboarding,
                template: project.template, formula: project.formula,
                context: { ...copyContextSchema.parse(project.context || {}), mode: 'focused' },
                name: brief.offerName || source.selectedOffer || 'Untitled project',
              };
              setProjects((old) => [recordEvidenceReview(next, keys.includes('proof') ? 'included' : 'excluded'), ...old]);
              select(next.id);
              setImportOpen(false);
              setToast('A separate offer project is ready. Your previous project is saved.');
              return;
            }
            update((p) => {
              const brief = { ...p.brief };
              for (const key of keys) brief[key] = source.extraction.fields[key] || '';
              const next: Project = {
                ...p,
                brief,
                source,
                referenceMode: p.referenceMode === 'rework_voice' ? 'rework_voice' : 'preserve_voice',
                name: p.name === 'Untitled project' && brief.offerName ? brief.offerName : p.name,
              };
              return recordEvidenceReview(next, keys.includes('proof') ? 'included' : 'excluded');
            });
            setImportOpen(false);
            setToast(keys.length ? `${keys.length} reviewed fields added. Full original copy is also attached as a reference.` : 'Original copy attached. Your brief stays unchanged.');
          }}
        />
      )}
      {evidenceProject && <EvidenceRecoveryDialog project={evidenceProject}
        onClose={() => setEvidenceProject(null)}
        onContinue={(source, include) => {
          const captured = applyRecoveredEvidence(evidenceProject, source, include);
          update(() => captured, captured.id);
          setEvidenceProject(null);
          generate(captured, true);
        }} />}
      {onboardingOpen && <OnboardingDialog
        project={project} records={onboardings} loading={onboardingLoading} error={onboardingError}
        onRefresh={refreshOnboardings} onClose={() => setOnboardingOpen(false)}
        onApply={(record, fields, useTemplate, useConstraints, useReference) => {
          update((p) => {
            const brief = { ...p.brief };
            const differentClient = Boolean(p.onboarding && p.onboarding.id !== record.id);
            if (differentClient) brief.coachBio = '';
            for (const key of fields) brief[key] = record.brief[key];
            return {
              ...p, brief,
              source: useReference && record.source ? record.source : p.source,
              offerBriefs: differentClient && p.offerBriefs ? {
                current: p.offerBriefs.current && { ...p.offerBriefs.current, coachBio: '' },
                focused: p.offerBriefs.focused && { ...p.offerBriefs.focused, coachBio: '' },
                new: p.offerBriefs.new && { ...p.offerBriefs.new, coachBio: '' },
              } : p.offerBriefs,
              onboarding: onboardingLinkSchema.parse(record),
              template: useTemplate ? record.template : p.template,
              context: useConstraints ? { ...copyContextSchema.parse(p.context || {}), background: record.context.background, mustKeep: record.context.mustKeep, avoid: record.context.avoid } : p.context,
              name: p.name === 'Untitled project' ? record.projectName : p.name,
            };
          });
          setOnboardingOpen(false);
          setToast('Client onboarding selected. Review the offer brief before generating.');
        }}
      />}
      <input
        type="file"
        ref={fileInput}
        accept=".json"
        hidden
        onChange={(e) => void importProject(e.target.files?.[0])}
      />
    </div>
  );
}

function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'copy-studio'
  );
}
