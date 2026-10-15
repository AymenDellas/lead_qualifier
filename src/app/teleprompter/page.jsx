'use client';

import { useEffect, useState } from 'react';
import Teleprompter, { teleprompterStoragePrefix } from '@/components/content-create/Teleprompter';
import '@/components/content-create/studio.css';

export default function TeleprompterPage() {
  const [draft,setDraft] = useState(null);
  const [error,setError] = useState('');
  useEffect(()=>{
    const load = ()=>{
      try {
        const token = window.location.hash.slice(1);
        if (!/^[a-f0-9-]{36}$/i.test(token)) throw new Error('Open a video in Create and choose Teleprompter.');
        const key = teleprompterStoragePrefix+token;
        const saved = JSON.parse(localStorage.getItem(key) || sessionStorage.getItem(key) || 'null');
        if (!saved || typeof saved.script!=='string' || !saved.script.trim()) throw new Error('The script is unavailable. Open the teleprompter again from Create.');
        sessionStorage.setItem(key,JSON.stringify(saved));
        localStorage.removeItem(key);
        setDraft({id:token,title:typeof saved.title==='string'?saved.title:'Your video script',script:saved.script});
        setError('');
        document.title = 'Teleprompter · Compel';
      } catch (failure) {
        setDraft(null);
        setError(failure.message || 'Could not load the script. Open the teleprompter again from Create.');
      }
    };
    load();
    window.addEventListener('hashchange',load);
    return ()=>window.removeEventListener('hashchange',load);
  },[]);
  if (!draft) return <main className="teleprompter-empty"><h1>Teleprompter</h1><p role={error?'alert':'status'}>{error || 'Opening your script…'}</p><a className="btn btn-outline" href="/">Back to workspace</a></main>;
  return <Teleprompter key={draft.id} title={draft.title} script={draft.script} standalone onClose={()=>window.close()}/>;
}
