'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, ArrowUpRight, Check, FileText } from 'lucide-react';
import { reportProjectAccessAction, reportProjectSetupAction, reviewProjectDeliverableAction, submitProjectRequestAction } from '@/app/actions/project-portal-actions';
import type { ProjectActionResult } from '@/lib/project-portal-store';
import { CompelLogo } from './CompelLogo';
import { currentReview, DELIVERABLE_STATUS_LABELS, formatProjectDate, MAX_PROJECT_FILE_BYTES, PROJECT_FILE_EXTENSIONS,
  PROJECT_STATUS_LABELS, REQUEST_STATUS_LABELS, SETUP_STATUS_LABELS, type ClientProjectView, type ProjectFile } from '@/lib/project-workspace';
import { LinkOut } from './BusinessUi';
import './compel-onboarding.css';
import './projects.css';

export default function ProjectClientWorkspace({ token, project, files, onboardingTasks }: {
  token: string; project: ClientProjectView; files: ProjectFile[]; onboardingTasks: { key: string; label: string; detail: string }[];
}) {
  const [tab, setTab] = useState('overview');
  const [notice, setNotice] = useState<ProjectActionResult | null>(null);
  const requests = project.requests.filter(item => ['REQUESTED', 'CHANGES_REQUESTED'].includes(item.status));
  const reviews = project.deliverables.filter(item => item.status === 'REVIEW');
  const setup = project.setup.filter(item => item.owner === 'CLIENT' && ['TODO', 'DOING'].includes(item.status));
  const access = project.access.filter(item => !['VERIFIED', 'NOT_NEEDED', 'RECEIVED'].includes(item.status));
  const actions = requests.length + reviews.length + setup.length + access.length;
  return <main className="compel-onboarding compel-portal project-client-page">
    <header className="compel-portal-header"><CompelLogo /><span className="compel-portal-header-label">Your project workspace</span><a className="project-onboarding-link" href={`/portal/${token}`}>Onboarding & agreement <ArrowUpRight size={14} /></a></header>
    <div className="project-client-wrap">
      <section className="project-client-hero"><div><p className="label-micro">{project.clientName} / YOUR PROJECT</p><h1>{project.name}</h1><p>Your deliverables, our requests, and the next steps. Everything stays here.</p></div><div className="project-client-phase"><span className="project-badge">{PROJECT_STATUS_LABELS[project.status]}</span>{project.launchAt && <span>Target launch · {formatProjectDate(project.launchAt)}</span>}</div></section>
      {notice && <div className={`project-notice ${notice.ok ? '' : 'is-error'}`} role={notice.ok ? 'status' : 'alert'}>{notice.message}</div>}
      <nav className="project-tabs" aria-label="Your project sections">{[['overview','Your next steps'],['deliverables','Deliverables'],['requests','Requests'],['setup','Setup'],['scope','Project scope']].map(([id,label]) => <button key={id} className={tab === id ? 'is-active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}{id === 'requests' && requests.length > 0 && <span className="project-nav-count">{requests.length}</span>}</button>)}</nav>
      <section hidden={tab !== 'overview'} className="project-client-section"><div className="project-section-intro"><div><p className="label-micro">UP NEXT</p><h2>{actions ? `${actions} ${actions === 1 ? 'thing needs' : 'things need'} your attention` : 'You’re up to date.'}</h2><p>{actions ? 'Open an item below. Your response goes straight to your project team.' : 'We’ll share new work and requests in this workspace as the project moves forward.'}</p></div></div>
        <div className="project-next-list">{requests.map(item => <NextStep key={item.id} label="REQUEST" title={item.title} detail={item.feedback || item.instructions || 'Share your answer, link or file.'} dueAt={item.dueAt} onClick={() => setTab('requests')} />)}{reviews.map(item => <NextStep key={item.id} label="REVIEW" title={item.title} detail="Review the shared version, then approve it or tell us what to change." dueAt={item.dueAt} onClick={() => setTab('deliverables')} />)}{setup.map(item => <NextStep key={item.id} label="SETUP" title={item.title} detail={item.instructions} dueAt={item.dueAt} onClick={() => setTab('setup')} />)}{access.map(item => <NextStep key={item.id} label="ACCESS" title={item.platform} detail={item.reason} onClick={() => setTab('setup')} />)}</div>
        {onboardingTasks.length > 0 && <details className="project-preparation"><summary>Preparation and onboarding · {onboardingTasks.length} items remaining</summary><ul>{onboardingTasks.map(item => <li key={item.key}><strong>{item.label}</strong><p>{item.detail}</p></li>)}</ul><a className="btn btn-outline" href={`/portal/${token}`}>Open onboarding <ArrowUpRight size={14} /></a></details>}
        <div className="project-client-overview-line"><span>{project.deliverables.filter(item => item.status === 'DONE').length} shared deliverables complete</span><span>{project.requests.filter(item => item.status === 'SUBMITTED').length} responses with Compel for review</span></div>
      </section>
      <section hidden={tab !== 'deliverables'} className="project-client-section"><div className="project-section-intro"><div><h2>Your deliverables</h2><p>Open the work and files below. Approvals apply to the version you review.</p></div></div>
        {!project.deliverables.length && <div className="project-empty"><h3>Your work will appear here as it’s ready.</h3><p>You can see everything included in Project scope.</p><button className="btn btn-outline" onClick={() => setTab('scope')}>View project scope</button></div>}
        {project.deliverables.map(item => { const review = currentReview(item); return <article className="project-client-item" key={`${item.id}-${item.version}`}><div className="project-client-item-head"><div><p className="label-micro">VERSION {item.version}{item.dueAt ? ` / DUE ${formatProjectDate(item.dueAt)}` : ''}</p><h3>{item.title}</h3></div><span className="project-badge">{DELIVERABLE_STATUS_LABELS[item.status]}</span></div>
          {item.content && <div className="project-prose">{item.content}</div>}<LinkOut url={item.url}>Open the deliverable <ArrowUpRight size={14} /></LinkOut><ClientFiles files={files.filter(file => file.kind === 'deliverable' && file.itemId === item.id)} token={token} />
          {review && <div className="project-response"><strong>{review.decision === 'APPROVED' ? 'You approved this version' : 'You requested changes'} · {formatProjectDate(review.createdAt)}</strong>{review.feedback && <p>{review.feedback}</p>}</div>}
          {item.status === 'REVIEW' && <ClientAction action={reviewProjectDeliverableAction} onResult={setNotice}><input type="hidden" name="token" value={token} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="version" value={item.version} /><label className="project-select">Comments or requested changes<textarea className="field" name="feedback" rows={4} maxLength={20000} placeholder="Tell us what works or what you would like changed." /></label><div className="project-action-row"><button className="btn btn-primary" name="decision" value="APPROVED" type="submit"><Check size={15} /> Approve this version</button><button className="btn btn-outline" name="decision" value="CHANGES_REQUESTED" type="submit">Request changes</button></div><p className="project-help">Add a comment when requesting changes. Editing this work or its files will require a new review.</p></ClientAction>}
        </article>; })}
      </section>
      <section hidden={tab !== 'requests'} className="project-client-section"><div className="project-section-intro"><div><h2>What we need from you</h2><p>Follow the instructions, then submit your response here. You can share a link for larger files.</p></div></div>
        {!project.requests.length && <div className="project-empty"><h3>No additional requests right now.</h3><p>Your onboarding answers are already with the team.</p></div>}
        {project.requests.map(item => <article className="project-client-item" key={`${item.id}-${item.version}-${item.responseRevision}`}><div className="project-client-item-head"><div><p className="label-micro">{item.required ? 'REQUIRED' : 'OPTIONAL'}{item.dueAt ? ` / DUE ${formatProjectDate(item.dueAt)}` : ''}</p><h3>{item.title}</h3></div><span className="project-badge">{REQUEST_STATUS_LABELS[item.status]}</span></div><p className="project-prose">{item.instructions}</p>
          {item.feedback && <div className="project-response"><strong>Feedback from Compel</strong><p>{item.feedback}</p></div>}<ClientFiles files={files.filter(file => file.kind === 'request' && file.itemId === item.id)} token={token} />
          {item.status === 'COMPLETE' ? <div className="project-prose"><strong>Your response</strong><p>{item.response}</p><LinkOut url={item.responseUrl}>Open your submitted link <ArrowUpRight size={14} /></LinkOut></div>
            : <ClientAction action={submitProjectRequestAction} onResult={setNotice}><input type="hidden" name="token" value={token} /><input type="hidden" name="itemId" value={item.id} /><input type="hidden" name="version" value={item.version} /><input type="hidden" name="responseRevision" value={item.responseRevision} />
              <label className="project-select">{item.responseType === 'TEXT' ? 'Your answer' : 'Your answer or notes'}<textarea className="field" name="response" rows={4} defaultValue={item.response} maxLength={20000} required={item.responseType === 'TEXT'} /></label>
              {['LINK','ANY'].includes(item.responseType) ? <label className="project-select">{item.responseType === 'LINK' ? 'Your link' : 'Link, if needed'}<input className="field" name="responseUrl" type="url" defaultValue={item.responseUrl} maxLength={2000} required={item.responseType === 'LINK'} placeholder="https://" /></label> : <input type="hidden" name="responseUrl" value={item.responseUrl} />}
              {['FILE','ANY'].includes(item.responseType) && <label className="project-file-input">Attach a file<input name="file" type="file" accept={PROJECT_FILE_EXTENSIONS.map(ext => `.${ext}`).join(',')} /><span className="project-help">Up to 3 MB. Existing attachments stay with this request.</span></label>}<div className="project-action-row"><button className="btn btn-primary" type="submit">{item.status === 'SUBMITTED' ? 'Update your response' : 'Submit response'} <ArrowRight size={15} /></button>{item.submittedAt && <span className="project-help">Last submitted {formatProjectDate(item.submittedAt)}</span>}</div>
            </ClientAction>}
        </article>)}
      </section>
      <section hidden={tab !== 'setup'} className="project-client-section"><div className="project-section-intro"><div><h2>Getting everything connected</h2><p>Each task says who handles it. We verify access and setup before marking it complete.</p></div></div>
        {!project.setup.length && !project.access.length && <div className="project-empty"><h3>No setup tasks have been added yet.</h3><p>We’ll add instructions here when there is something to connect.</p></div>}
        {project.access.map(item => <article className="project-client-item" key={item.id}><div className="project-client-item-head"><div><p className="label-micro">TOOL ACCESS</p><h3>{item.platform}</h3></div><span className="project-badge">{({NOT_REQUESTED:'Needs access',REQUESTED:'Needs access',RECEIVED:'With Compel for verification',VERIFIED:'Verified',NOT_NEEDED:'Not needed'})[item.status]}</span></div><p>{item.reason}</p><p className="project-prose">{item.instructions}</p><p className="project-help">Requested permission: {item.permission}. Send an invitation rather than sharing a password.</p>{['NOT_REQUESTED','REQUESTED'].includes(item.status) && <ClientAction action={reportProjectAccessAction} onResult={setNotice}><input type="hidden" name="token" value={token} /><input type="hidden" name="itemId" value={item.id} /><button className="btn btn-outline" type="submit">I’ve sent the invitation</button></ClientAction>}</article>)}
        {project.setup.map(item => <article className="project-client-item" key={item.id}><div className="project-client-item-head"><div><p className="label-micro">{item.owner === 'CLIENT' ? 'YOUR TASK' : 'COMPEL IS HANDLING THIS'}{item.dueAt ? ` / DUE ${formatProjectDate(item.dueAt)}` : ''}</p><h3>{item.title}</h3></div><span className="project-badge">{SETUP_STATUS_LABELS[item.status]}</span></div><p className="project-prose">{item.instructions}</p>{item.owner === 'CLIENT' && ['TODO','DOING'].includes(item.status) && <ClientAction action={reportProjectSetupAction} onResult={setNotice}><input type="hidden" name="token" value={token} /><input type="hidden" name="itemId" value={item.id} /><button className="btn btn-outline" type="submit">Ready for Compel to verify</button></ClientAction>}</article>)}
      </section>
      <section hidden={tab !== 'scope'} className="project-client-section"><div className="project-section-intro"><div><h2>Your project scope</h2><p>Carried over from your onboarding. {project.scope.confirmed ? 'You have confirmed this scope.' : 'Review and confirm the scope in your onboarding.'}</p></div></div><article className="project-client-item"><h3>What’s included</h3><p className="project-prose">{project.scope.included || 'Your project team is preparing the scope.'}</p></article><article className="project-client-item"><h3>What’s not included</h3><p className="project-prose">{project.scope.excluded || 'No exclusions recorded.'}</p></article><a className="btn btn-outline" href={`/portal/${token}#scope-confirmation`}>Review onboarding and agreement <ArrowUpRight size={14} /></a></section>
      <footer className="project-client-footer">Your project, in one place. <a href={`/portal/${token}`}>Open onboarding and agreement</a></footer>
    </div>
  </main>;
}

function NextStep({ label, title, detail, dueAt, onClick }: {label:string;title:string;detail:string;dueAt?:string;onClick:()=>void}) {
  return <button className="project-next-row" onClick={onClick}><span><span className="label-micro">{label}{dueAt ? ` / DUE ${formatProjectDate(dueAt)}` : ''}</span><strong>{title}</strong><span>{detail}</span></span><ArrowRight size={18} /></button>;
}
function ClientFiles({ files, token }: {files:ProjectFile[];token:string}) {
  return files.length ? <ul className="project-files">{files.map(file => <li key={file.id}><FileText size={15} /><a href={`/portal/${token}/files/${file.id}`}>{file.name}</a><small>{Math.ceil(file.size/1024)} KB</small></li>)}</ul> : null;
}
function ClientAction({ action, onResult, children }: {action:(form:FormData)=>Promise<ProjectActionResult>;onResult:(result:ProjectActionResult)=>void;children:ReactNode}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (submitter instanceof HTMLButtonElement && submitter.name) form.set(submitter.name, submitter.value);
    const file = form.get('file');
    if (file instanceof File && file.size > MAX_PROJECT_FILE_BYTES) { setError('Use a file smaller than 3 MB, or share a link instead.'); return; }
    setError(''); setPending(true);
    try { const result = await action(form); onResult(result); if (result.ok) router.refresh(); else setError(result.message); }
    catch { setError('This update could not be saved. Your answers are still here. Please try again.'); }
    finally { setPending(false); }
  };
  return <form onSubmit={submit} className="project-client-form"><fieldset disabled={pending}>{children}</fieldset>{pending && <p role="status" className="project-help">Saving your update…</p>}{error && <p role="alert" className="project-alert">{error}</p>}</form>;
}
