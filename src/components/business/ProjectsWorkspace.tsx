'use client';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Copy, FileText, Plus, RefreshCw, Save, X } from 'lucide-react';
import type { BusinessSnapshot, ClientProject } from '@/lib/business';
import { normalizeOnboarding, onboardingBlockers } from '@/lib/business';
import { archiveProjectFileAction, loadProjectFilesAction, saveProjectWorkspaceAction, uploadProjectFileAction } from '@/app/actions/project-actions';
import { currentReview, deliveryWorkspace, DELIVERABLE_STATUS_LABELS, formatProjectDate, MAX_PROJECT_FILE_BYTES, PROJECT_FILE_EXTENSIONS,
  PROJECT_STATUS_LABELS, REQUEST_STATUS_LABELS, SETUP_STATUS_LABELS, workspaceEdit, workspaceEditSchema, type ProjectFile, type WorkspaceEdit } from '@/lib/project-workspace';
import { Empty, Field, LinkOut, Panel, type RunAction } from './BusinessUi';
import './projects.css';

type Props = { snapshot: BusinessSnapshot; busy: boolean; run: RunAction; refresh: () => Promise<void>; onOnboarding: (id: string) => void };
export default function ProjectsWorkspace({ snapshot, busy, run, refresh, onOnboarding }: Props) {
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('ALL');
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState('deliverables');
  const rows = snapshot.projects.map(project => {
    const onboarding = normalizeOnboarding(project.data, snapshot.opportunities.find(o => o.id === project.opportunityId)?.data, snapshot.offer.profile);
    const delivery = deliveryWorkspace(project.data);
    return { project, onboarding, waiting: delivery.requests.filter(r => ['REQUESTED', 'CHANGES_REQUESTED'].includes(r.status)).length,
      review: project.data.deliverables.filter(d => d.visibleToClient && d.status === 'REVIEW').length,
      submitted: delivery.requests.filter(r => r.status === 'SUBMITTED').length,
      remaining: delivery.setup.filter(t => t.status !== 'DONE').length + onboarding.access.filter(a => a.required && !a.nonBlocking && !['VERIFIED', 'NOT_NEEDED'].includes(a.status)).length };
  });
  const selected = rows.find(row => row.project.id === selectedId);
  const leave = () => { if (!dirty || window.confirm('Leave without saving your project changes?')) { setSelectedId(''); setDirty(false); } };
  if (selected) return <ProjectEditor key={`${selected.project.id}-${selected.project.revision}`} {...{ ...selected, busy, run, refresh, onOnboarding, tab }} onTabChange={setTab} onBack={leave} onDirty={setDirty} />;
  const visible = rows.filter(row => `${row.onboarding.clientName} ${row.onboarding.projectName}`.toLowerCase().includes(query.toLowerCase())
    && (filter === 'ALL' || (filter === 'ATTENTION' ? row.waiting + row.review + row.submitted > 0 : row.project.data.status === filter)));
  return <div className="projects-workspace">
    <div className="project-intro"><div><p className="project-eyebrow">Client delivery</p><h2>Delivery at a glance.</h2><p>Review client responses, share deliverables, and track remaining setup.</p></div><button className="btn btn-outline" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} /> Refresh updates</button></div>
    <div className="project-totals" aria-label="Project summary"><div><span>Active projects</span><strong>{rows.filter(r => r.project.data.status !== 'COMPLETE').length}</strong></div><div><span>Client responses to review</span><strong>{rows.reduce((n,r) => n + r.submitted, 0)}</strong></div><div><span>Deliverables awaiting approval</span><strong>{rows.reduce((n,r) => n + r.review, 0)}</strong></div></div>
    <div className="project-list-tools"><label className="project-search">Find a client or project<input className="field" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search projects" /></label><label>Show<select className="field" value={filter} onChange={e => setFilter(e.target.value)}><option value="ALL">All projects</option><option value="ATTENTION">Needs attention</option>{Object.entries(PROJECT_STATUS_LABELS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label></div>
    {!rows.length ? <Panel title="Your client projects"><Empty>Projects appear here when you create a client’s onboarding.</Empty><button className="btn btn-primary" onClick={() => onOnboarding('')}>Open onboarding</button></Panel>
      : !visible.length ? <Empty>No projects match this search.</Empty> : <div className="project-client-list">{visible.map(row => <button className="project-client-row" key={row.project.id} onClick={() => { setDirty(false); setSelectedId(row.project.id); }}>
        <span className="project-initial" aria-hidden>{row.onboarding.clientName.charAt(0).toUpperCase()}</span><span className="project-client-name"><strong>{row.onboarding.clientName}</strong><span>{row.onboarding.projectName}</span></span><span className="project-phase">{PROJECT_STATUS_LABELS[row.project.data.status]}</span><span className="project-row-next">{row.submitted ? `${row.submitted} client response${row.submitted > 1 ? 's' : ''} to review` : row.review ? `${row.review} awaiting client approval` : row.waiting ? `${row.waiting} request${row.waiting > 1 ? 's' : ''} with the client` : row.remaining ? `${row.remaining} setup item${row.remaining > 1 ? 's' : ''} remaining` : 'Open project'}</span><ArrowUpRight size={17} /></button>)}</div>}
  </div>;
}

function ProjectEditor({ project, onboarding, busy, run, refresh, onBack, onDirty, onOnboarding, tab, onTabChange }: {
  project: ClientProject; onboarding: ReturnType<typeof normalizeOnboarding>; busy: boolean; run: RunAction;
  refresh: () => Promise<void>; onBack: () => void; onDirty: (dirty: boolean) => void; onOnboarding: (id: string) => void;
  tab: string; onTabChange: (tab: string) => void;
}) {
  const [edit, setEdit] = useState(() => workspaceEdit(project.data));
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [fileError, setFileError] = useState('');
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const dirty = JSON.stringify(edit) !== JSON.stringify(workspaceEdit(project.data));
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { let active = true; loadProjectFilesAction(project.id).then(value => { if (active) setFiles(value); }).catch(() => { if (active) setFileError('Files could not be loaded. Refresh updates to try again.'); }); return () => { active = false; }; }, [project.id]);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  useEffect(() => { if (!dirty) return; const warn = (event: Event) => { if (!window.confirm('Leave without saving your project changes?')) event.preventDefault(); }; window.addEventListener('compel:before-navigation', warn); return () => window.removeEventListener('compel:before-navigation', warn); }, [dirty]);
  const locked = busy || localBusy;
  const set = (patch: Partial<WorkspaceEdit>) => setEdit(old => ({ ...old, ...patch }));
  const updateDeliverable = (id: string, patch: Partial<WorkspaceEdit['deliverables'][number]>) => setEdit(old => ({ ...old, deliverables: old.deliverables.map(item => item.id === id ? { ...item, ...patch } : item) }));
  const updateRequest = (id: string, patch: Partial<WorkspaceEdit['requests'][number]>) => setEdit(old => ({ ...old, requests: old.requests.map(item => item.id === id ? { ...item, ...patch } : item) }));
  const updateSetup = (id: string, patch: Partial<WorkspaceEdit['setup'][number]>) => setEdit(old => ({ ...old, setup: old.setup.map(item => item.id === id ? { ...item, ...patch } : item) }));
  const origin = (process.env.NEXT_PUBLIC_CLIENT_PORTAL_URL || '').replace(/\/$/, '');
  const portalPath = onboarding.portalToken ? `/portal/${onboarding.portalToken}/project` : '';
  const portalHref = `${origin}${portalPath}`;
  const save = async () => {
    setError('');
    const parsed = workspaceEditSchema.safeParse(edit);
    if (!parsed.success) { setError(`${parsed.error.issues[0].path.join(' › ')}: ${parsed.error.issues[0].message}`); return; }
    await run(() => saveProjectWorkspaceAction(project.id, project.revision, parsed.data), 'Project saved. Published changes are available in the client workspace.');
  };
  const upload = async (itemId: string, file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_PROJECT_FILE_BYTES) { setError('Use a file smaller than 3 MB, or share a link.'); return; }
    const form = new FormData(); form.set('projectId', project.id); form.set('itemId', itemId); form.set('kind', 'deliverable'); form.set('revision', String(project.revision)); form.set('file', file);
    setLocalBusy(true); try { await run(async () => { await uploadProjectFileAction(form); return true; }, 'File saved. Deliverable version updated.'); } finally { setLocalBusy(false); }
  };
  const removeFile = async (file: ProjectFile) => { setLocalBusy(true); try { await run(async () => { await archiveProjectFileAction(project.id, file.id, project.revision); return true; }, 'File removed from the shared workspace.'); } finally { setLocalBusy(false); } };
  const blockers = onboardingBlockers(onboarding);
  return <div className="projects-workspace project-editor">
    <div className="project-heading"><button className="btn btn-ghost" onClick={onBack}><ArrowLeft size={15} /> All projects</button><span>{dirty ? 'Unsaved changes' : 'All changes saved'}</span><button className="btn btn-primary" disabled={!dirty || locked} onClick={() => void save()}><Save size={15} /> {locked ? 'Saving…' : 'Save changes'}</button></div>
    <div className="project-intro"><div><p className="label-micro">{onboarding.clientName} / PROJECT WORKSPACE</p><h2>{onboarding.projectName}</h2><p>Share the work when it’s ready. Collect client answers and approvals here.</p></div><div className="project-header-links">{portalPath ? <><a href={portalHref} target="_blank" rel="noreferrer" className="btn btn-outline">Client workspace <ArrowUpRight size={15} /></a><button className="btn btn-outline" onClick={async () => { try { await navigator.clipboard.writeText(new URL(portalHref, window.location.origin).href); setCopied(true); } catch { setError('The link could not be copied. Open Client workspace and copy its address.'); } }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy client link'}</button></> : <button className="btn btn-outline" onClick={() => onOnboarding(project.id)}>Activate portal in onboarding</button>}<button className="btn btn-ghost" disabled={dirty || locked} onClick={() => void refresh()}><RefreshCw size={14} /> Refresh updates</button></div></div>
    {error && <p className="project-alert" role="alert">{error}</p>}{fileError && <p className="project-alert" role="alert">{fileError}</p>}
    <fieldset disabled={locked} className="project-status-row project-fields"><Select label="Project phase" value={edit.status} options={PROJECT_STATUS_LABELS} onChange={value => set({ status: value as WorkspaceEdit['status'] })} disabled={locked} /><Field label="Target launch" type="date" value={edit.launchAt.slice(0,10)} onChange={value => set({ launchAt: value })} /><p>{deliveryWorkspace(project.data).requests.filter(r => r.status === 'SUBMITTED').length} client responses to review<br />{project.data.deliverables.filter(d => d.status === 'REVIEW' && d.visibleToClient).length} deliverables awaiting approval</p></fieldset>
    <nav className="project-tabs" aria-label="Project sections">{[['deliverables','Deliverables'],['requests','Client requests'],['setup','Remaining setup'],['scope','Scope & notes']].map(([id,label]) => <button key={id} className={tab === id ? 'is-active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => onTabChange(id)}>{label}</button>)}</nav>
    <fieldset disabled={locked} className="project-fields">
      <section hidden={tab !== 'deliverables'}><div className="project-section-intro"><div><h3>The actual work</h3><p>Keep drafts private until you select Share with client. Use Ready for review to request approval.</p></div><button className="btn btn-outline" disabled={edit.deliverables.length >= 100} onClick={() => set({ deliverables: [...edit.deliverables, { id: crypto.randomUUID(), title: '', content: '', url: '', dueAt: '', status: 'TODO', visibleToClient: false }] })}><Plus size={15} /> Add deliverable</button></div>
        {!edit.deliverables.length && <Empty>Add the first deliverable for this project.</Empty>}{edit.deliverables.map((item,index) => { const saved = project.data.deliverables.find(d => d.id === item.id); const review = saved ? currentReview(saved) : undefined; return <details className="project-entry" key={item.id} open={index === 0 || !saved}><summary><span className="project-item-number">{String(index+1).padStart(2,'0')}</span><strong>{item.title || 'New deliverable'}</strong><span>{item.visibleToClient ? 'Shared' : 'Internal draft'}</span><span className="project-badge">{DELIVERABLE_STATUS_LABELS[item.status]}</span></summary><div className="project-entry-body">
          <Field label="Deliverable title" value={item.title} onChange={title => updateDeliverable(item.id,{title})} required /><div className="project-two-cols"><Select label={`Status for ${item.title || 'new deliverable'}`} value={item.status} options={DELIVERABLE_STATUS_LABELS} onChange={status => updateDeliverable(item.id,{status:status as typeof item.status})} /><Field label="Due date" type="date" value={item.dueAt.slice(0,10)} onChange={dueAt => updateDeliverable(item.id,{dueAt})} /></div>
          <Field label="Deliverable content or notes for the client" multiline value={item.content} onChange={content => updateDeliverable(item.id,{content})} hint="Everything here is client-facing once this deliverable is shared. Put private notes in Scope & notes." /><Field label="Preview or document link" type="url" value={item.url} onChange={url => updateDeliverable(item.id,{url})} />
          <label className="project-check"><input type="checkbox" checked={item.visibleToClient} onChange={e => updateDeliverable(item.id,{visibleToClient:e.target.checked})} /> Share this deliverable with the client</label>
          {review && <div className="project-response"><strong>{review.decision === 'APPROVED' ? 'Client approved' : 'Client requested changes'} · Version {review.version}</strong><p>{review.feedback || 'Approved without additional comments.'}</p><small>{formatProjectDate(review.createdAt)}</small></div>}
          {(saved?.reviews?.length || 0) > 0 && <details><summary className="text-sm">Review history ({saved!.reviews!.length})</summary><div className="project-history">{saved!.reviews!.map((entry,i) => <p key={i}>Version {entry.version} · {entry.decision === 'APPROVED' ? 'Approved' : 'Changes requested'} · {formatProjectDate(entry.createdAt)}{entry.feedback && ` — ${entry.feedback}`}</p>)}</div></details>}
          <FileList files={files.filter(f => f.itemId === item.id && f.kind === 'deliverable')} onRemove={file => void removeFile(file)} disabled={dirty || locked} />
          <label className="project-file-input">Add a file<input type="file" accept={PROJECT_FILE_EXTENSIONS.map(ext => `.${ext}`).join(',')} disabled={dirty || locked || !saved} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(item.id,file); }} /></label><p className="project-help">{dirty || !saved ? 'Save your changes before adding or removing files. ' : ''}Files up to 3 MB. Use a link for larger files. File changes create a new version.</p>
          {!saved && <button className="btn btn-ghost" onClick={() => set({deliverables:edit.deliverables.filter(d => d.id !== item.id)})}><X size={14} /> Remove unsaved item</button>}
        </div></details>; })}
      </section>
      <section hidden={tab !== 'requests'}><div className="project-section-intro"><div><h3>What you need from the client</h3><p>Give each request clear instructions. Their answer and files stay attached to it.</p></div><button className="btn btn-outline" disabled={edit.requests.length >= 100} onClick={() => set({requests:[...edit.requests,{id:crypto.randomUUID(),title:'',instructions:'',responseType:'ANY',dueAt:'',required:true,status:'REQUESTED',feedback:''}]})}><Plus size={15} /> Add request</button></div>
        {!edit.requests.length && <Empty>No additional requests. Onboarding answers and access requests already carry through.</Empty>}{edit.requests.map((item,index) => {const saved = deliveryWorkspace(project.data).requests.find(r => r.id === item.id);return <details className="project-entry" key={item.id} open={index === 0 || !saved}><summary><strong>{item.title || 'New client request'}</strong><span className="project-badge">{REQUEST_STATUS_LABELS[item.status]}</span></summary><div className="project-entry-body"><Field label="Request title" value={item.title} onChange={title => updateRequest(item.id,{title})} required /><Field label="Instructions for the client" multiline value={item.instructions} onChange={instructions => updateRequest(item.id,{instructions})} /><div className="project-two-cols"><Select label="Client should provide" value={item.responseType} options={{ANY:'Answer, link or file',TEXT:'Written answer',LINK:'Link',FILE:'File'}} onChange={responseType => updateRequest(item.id,{responseType:responseType as typeof item.responseType})} /><Field label="Request deadline" type="date" value={item.dueAt.slice(0,10)} onChange={dueAt => updateRequest(item.id,{dueAt})} /></div><label className="project-check"><input type="checkbox" checked={item.required} onChange={e => updateRequest(item.id,{required:e.target.checked})} /> Required before this work can proceed</label>
          {saved?.submittedAt && <div className="project-response"><strong>Client response · {formatProjectDate(saved.submittedAt)}</strong><p>{saved.response}</p><LinkOut url={saved.responseUrl}>Open submitted link <ArrowUpRight size={13} /></LinkOut><FileList files={files.filter(f => f.kind === 'request' && f.itemId === item.id)} /></div>}
          <Select label="Request status" value={item.status} options={Object.fromEntries(Object.entries(REQUEST_STATUS_LABELS).filter(([status]) => status !== 'SUBMITTED' || saved?.submittedAt))} onChange={status => updateRequest(item.id,{status:status as typeof item.status})} /><Field label="Feedback or clarification for the client" multiline value={item.feedback} onChange={feedback => updateRequest(item.id,{feedback})} hint="Explain what to fix when choosing Please update your response." />{!saved && <button className="btn btn-ghost" onClick={() => set({requests:edit.requests.filter(r => r.id !== item.id)})}>Remove unsaved request</button>}
        </div></details>;})}
      </section>
      <section hidden={tab !== 'setup'}><div className="project-section-intro"><div><h3>Keep setup moving</h3><p>Assign ownership and describe the exact action. Client-reported completion waits for your verification.</p></div><button className="btn btn-outline" disabled={edit.setup.length >= 100} onClick={() => set({setup:[...edit.setup,{id:crypto.randomUUID(),title:'',instructions:'',owner:'COMPEL',status:'TODO',dueAt:''}]})}><Plus size={15} /> Add setup task</button></div>
        <Panel title="Access from onboarding">{onboarding.access.length ? onboarding.access.map(item => <div className="project-simple-row" key={item.id}><div><strong>{item.platform}</strong><p>{item.reason}</p></div><span className="project-badge">{({NOT_REQUESTED:'Not requested',REQUESTED:'With client',RECEIVED:'Ready to verify',VERIFIED:'Verified',NOT_NEEDED:'Not needed'})[item.status]}</span></div>) : <p>No access requests recorded yet.</p>}<button className="btn btn-outline" disabled={dirty} onClick={() => onOnboarding(project.id)}>Manage onboarding and access <ArrowUpRight size={14} /></button></Panel>
        {edit.setup.map((item,index) => <details className="project-entry" key={item.id} open={index === 0 || !deliveryWorkspace(project.data).setup.some(t => t.id === item.id)}><summary><strong>{item.title || 'New setup task'}</strong><span>{item.owner === 'CLIENT' ? 'Client' : 'Compel'}</span><span className="project-badge">{SETUP_STATUS_LABELS[item.status]}</span></summary><div className="project-entry-body"><Field label="Setup task" value={item.title} onChange={title => updateSetup(item.id,{title})} required /><Field label="Setup instructions" multiline value={item.instructions} onChange={instructions => updateSetup(item.id,{instructions})} /><div className="project-two-cols"><Select label="Who handles this?" value={item.owner} options={{COMPEL:'Compel',CLIENT:'Client'}} onChange={owner => updateSetup(item.id,{owner:owner as typeof item.owner})} /><Select label="Setup status" value={item.status} options={SETUP_STATUS_LABELS} onChange={status => updateSetup(item.id,{status:status as typeof item.status})} /></div><Field label="Setup deadline" type="date" value={item.dueAt.slice(0,10)} onChange={dueAt => updateSetup(item.id,{dueAt})} />{!deliveryWorkspace(project.data).setup.some(t => t.id === item.id) && <button className="btn btn-ghost" onClick={() => set({setup:edit.setup.filter(t => t.id !== item.id)})}>Remove unsaved task</button>}</div></details>)}
      </section>
      <section hidden={tab !== 'scope'}><Panel title="Included in this project"><p className="project-prose">{onboarding.scope.included || 'No included work recorded.'}</p><p className="project-help">{onboarding.scope.confirmed ? 'Client has confirmed this scope.' : 'Scope is awaiting client confirmation.'}</p></Panel><Panel title="Outside the agreed scope"><p className="project-prose">{onboarding.scope.excluded || 'No exclusions recorded.'}</p><button className="btn btn-outline" disabled={dirty} onClick={() => onOnboarding(project.id)}>Review scope in onboarding</button></Panel><Panel title="Preparation still outstanding">{blockers.length ? <ul className="project-blockers">{blockers.map(item => <li key={item.key}><strong>{item.label}</strong><p>{item.detail}</p></li>)}</ul> : <p>All onboarding requirements are complete.</p>}</Panel><Panel title="Internal project notes"><Field label="Private notes" multiline value={edit.internalNotes} onChange={internalNotes => set({internalNotes})} hint="Only visible inside your Compel workspace." /></Panel></section>
    </fieldset>
  </div>;
}

function Select({ label, value, options, onChange, disabled = false }: {label:string;value:string;options:Record<string,string>;onChange:(value:string)=>void;disabled?:boolean}) {
  return <label className="project-select">{label}<select aria-label={label} className="field w-full" value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>{Object.entries(options).map(([id,text]) => <option key={id} value={id}>{text}</option>)}</select></label>;
}
function FileList({ files, onRemove, disabled }: {files:ProjectFile[];onRemove?:(file:ProjectFile)=>void;disabled?:boolean}) {
  return files.length ? <ul className="project-files">{files.map(file => <li key={file.id}><FileText size={15} /><a href={`/api/project-files/${file.id}`}>{file.name}</a><small>{Math.ceil(file.size/1024)} KB</small>{onRemove && <button type="button" className="btn btn-ghost" disabled={disabled} aria-label={`Remove ${file.name} from shared files`} onClick={() => onRemove(file)}><X size={14} /></button>}</li>)}</ul> : null;
}
