import type {AudienceEvidence} from '@/lib/prospect-qualification.cjs';
export default function FollowerEvidence({followers,connections}:{followers?:AudienceEvidence|null;connections?:AudienceEvidence|null}){
 const label=followers?.count!=null?`${followers.count.toLocaleString()} followers`:followers?'Followers need review':'Followers unchecked';
 return <details className="text-xs text-[var(--text-dim)]" onClick={event=>event.stopPropagation()}>
  <summary className="cursor-pointer py-1">{label}</summary>
  <dl className="space-y-1 py-1 break-words">
   <div><dt className="inline">Profile text: </dt><dd className="inline">{followers?.rawText||'Not shown'}</dd></div>
   <div><dt className="inline">Parsed followers: </dt><dd className="inline">{followers?.count??'Unconfirmed'}{followers?.threshold!=null?` · Must exceed ${followers.threshold.toLocaleString()}`:''}</dd></div>
   {connections&&<div><dt className="inline">Connections: </dt><dd className="inline">{connections.rawText||connections.count||'Unconfirmed'}</dd></div>}
   {followers?.checkedAt&&<div><dt className="inline">Read: </dt><dd className="inline">{new Date(followers.checkedAt).toLocaleString()}</dd></div>}
  </dl>
 </details>;
}
