"use client";

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Search, X, type LucideIcon } from 'lucide-react';

export type WorkspaceDestination = { id: string; label: string; group: string; icon: LucideIcon };

/** Navigation search, deliberately scoped to the actual pages in this workspace. */
export default function WorkspaceCommandMenu({ open, items, onClose, onSelect }: {
    open: boolean;
    items: WorkspaceDestination[];
    onClose: () => void;
    onSelect: (id: string) => void;
}) {
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    const dialog = useRef<HTMLDivElement>(null);
    const listId = useId();
    const results = useMemo(() => items.filter(item => `${item.label} ${item.group}`.toLowerCase().includes(query.trim().toLowerCase())), [items, query]);
    const active = Math.min(selected, Math.max(0, results.length - 1));

    useEffect(() => {
        if (!open) return;
        const previous = document.activeElement as HTMLElement | null;
        setQuery(''); setSelected(0);
        input.current?.focus();
        return () => {
            if (previous?.isConnected && previous.getClientRects().length) previous.focus();
            else document.querySelector<HTMLButtonElement>('.workspace-header button[aria-label="Open navigation"]')?.focus();
        };
    }, [open]);

    useEffect(() => {
        if (open) dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    }, [active, open]);

    if (!open) return null;
    return <div className="workspace-command-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
        <div className="workspace-command" role="dialog" aria-modal="true" aria-label="Jump to a page" ref={dialog}
            onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); onClose(); }
                if (event.key === 'Tab') {
                    const controls = dialog.current?.querySelectorAll<HTMLElement>('input, button');
                    const first = controls?.[0], last = controls?.[controls.length - 1];
                    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
                }
            }}>
            <div className="workspace-command-input">
                <Search size={18} aria-hidden />
                <input ref={input} type="search" role="combobox" aria-label="Find a workspace page" aria-autocomplete="list" aria-expanded="true"
                    aria-controls={listId} aria-activedescendant={results.length ? `${listId}-${active}` : undefined}
                    value={query} placeholder="Where would you like to go?" autoComplete="off"
                    onChange={event => { setQuery(event.target.value); setSelected(0); }}
                    onKeyDown={event => {
                        if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((active + 1) % Math.max(1, results.length)); }
                        if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((active + results.length - 1) % Math.max(1, results.length)); }
                        if (event.key === 'Enter' && results[active]) { event.preventDefault(); onSelect(results[active].id); }
                    }} />
                <button type="button" className="workspace-icon-button" onClick={onClose} aria-label="Close page search"><X size={17} /></button>
            </div>
            <p className="workspace-command-label">Pages in your workspace</p>
            <ul id={listId} role="listbox" aria-label="Workspace pages" className="workspace-command-results">
                {results.map((item, index) => <li key={item.id} id={`${listId}-${index}`} role="option" aria-selected={index === active}
                    className={index === active ? 'is-selected' : ''} onMouseEnter={() => setSelected(index)}
                    onMouseDown={event => event.preventDefault()} onClick={() => onSelect(item.id)}>
                    <item.icon size={17} aria-hidden /><span>{item.label}<small>{item.group}</small></span><ArrowUpRight size={15} aria-hidden />
                </li>)}
                {!results.length && <li className="workspace-command-empty" role="presentation">No matching page. Try “Leads”, “Projects”, or “Copy Studio”.</li>}
            </ul>
            <div className="workspace-command-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open page</span><span><kbd>esc</kbd> close</span></div>
        </div>
    </div>;
}
