import type { ReactNode } from 'react';
import { UserRound } from 'lucide-react';
import type { AccessItem } from '@/lib/business';

/** Shared by the real client portal and its private preview. */
export function ClientAccessRequests({ items, receiptControl }: {
    items: AccessItem[];
    receiptControl: (item: AccessItem) => ReactNode;
}) {
    return <div className="divide-y divide-[var(--line)]">
        {items.map(item => <div key={item.id} className="py-5 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-2">
                <UserRound className="w-4 h-4 text-[var(--text-faint)]" aria-hidden />
                <h3 className="font-medium">{item.platform}</h3>
                <span className="ml-auto text-xs text-[var(--text-faint)] capitalize">{item.status.replaceAll('_', ' ').toLowerCase()}</span>
            </div>
            <p className="text-sm text-[var(--text-dim)] mt-2">{item.reason}</p>
            <p className="text-sm mt-2">{item.instructions}</p>
            <div className="flex flex-wrap items-center gap-3 mt-3">
                <p className="text-xs text-[var(--text-faint)] flex-1">Requested permission: {item.permission}</p>
                {receiptControl(item)}
            </div>
        </div>)}
    </div>;
}
