import { headers } from 'next/headers';

// The local console is loopback-only. The hosted app uses requireAdmin here.
export async function requireWorkerAdmin() {
 const h = await headers(), host = h.get('host') || '';
 if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) throw new Error('Use the authenticated Compel dashboard to manage workers.');
 const origin = h.get('origin');
 if (origin && new URL(origin).host !== host) throw new Error('This request must come from the worker console.');
}
