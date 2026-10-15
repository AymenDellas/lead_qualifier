'use client';
import { useId, type ReactNode } from 'react';

export function Field({
    label,
    value,
    onChange,
    type = 'text',
    multiline = false,
    hint,
    required = false,
    children,
}: {
    label: string;
    value?: string | number;
    onChange?: (value: string) => void;
    type?: string;
    multiline?: boolean;
    hint?: string;
    required?: boolean;
    children?: ReactNode;
}) {
    const id = useId();
    return (
        <div className="space-y-1.5 min-w-0">
            <label className="block text-sm text-[var(--text-dim)]" htmlFor={children ? undefined : id}>
                {label}
                {required ? ' *' : ''}
            </label>
            {children ||
                (multiline ? (
                    <textarea
                        id={id}
                        className="field w-full min-h-28"
                        value={value}
                        onChange={(e) => onChange?.(e.target.value)}
                        required={required}
                    />
                ) : (
                    <input
                        id={id}
                        className="field w-full"
                        type={type}
                        value={value ?? ''}
                        onChange={(e) => onChange?.(e.target.value)}
                        required={required}
                        min={type === 'number' ? 0 : undefined}
                        step={type === 'number' ? 'any' : undefined}
                    />
                ))}
            {hint && <p className="text-xs text-[var(--text-faint)]">{hint}</p>}
        </div>
    );
}
export function Panel({
    title,
    children,
    action,
}: {
    title: string;
    children: ReactNode;
    action?: ReactNode;
}) {
    return (
        <section className="panel min-w-0">
            <div className="panel-head flex items-center justify-between gap-3">
                <h2 className="text-base font-medium">{title}</h2>
                {action}
            </div>
            <div className="panel-body space-y-4">{children}</div>
        </section>
    );
}
export function Empty({ children }: { children: ReactNode }) {
    return <p className="py-10 text-[var(--text-dim)] text-base">{children}</p>;
}
export function LinkOut({ url, children }: { url: string; children: ReactNode }) {
    return /^https?:\/\//i.test(url) ? (
        <a
            className="text-[var(--signal)] underline underline-offset-4 break-all"
            href={url}
            target="_blank"
            rel="noreferrer"
        >
            {children}
        </a>
    ) : null;
}
export function dateTime(value: string) {
    return value
        ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
        : 'No date set';
}
export function localInput(value: string) {
    if (!value) return '';
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function isoInput(value: string) {
    return value ? new Date(value).toISOString() : '';
}
export const money = (value: number | null) =>
    value === null
        ? 'Fee not set'
        : new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency: 'USD',
              maximumFractionDigits: 0,
          }).format(value);
export type RunAction = <T>(work: () => Promise<T>, message?: string) => Promise<T | null>;
