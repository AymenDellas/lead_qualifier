// The development checkout uses its existing business-workspace access gate.
// The hosted checkout delegates this boundary to dashboard-auth.requireAdmin.
import { loadBusinessAction } from '@/app/actions/business-actions';
export async function requireAdmin() { await loadBusinessAction(); }
