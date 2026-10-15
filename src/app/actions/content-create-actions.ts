'use server';

import { createStudio } from '@/lib/content-create/studio';

const studio = createStudio();

// Return expected errors explicitly: production Server Actions intentionally
// hide thrown server messages, which would otherwise erase useful recovery copy.
async function result<T>(work: () => T | Promise<T>) {
  try { return { data: await work() }; }
  catch (error) { return { error: error instanceof Error ? error.message : 'Create could not finish that request. Please try again.' }; }
}

export async function loadContentStudio() { return result(() => studio.state()); }
export async function saveContentDirection(input: Record<string, string>) { return result(() => studio.saveDirection(input)); }
export async function generateMoreContentIdeas() { return result(() => studio.ideas()); }
export async function generateContentPost(input: Record<string, unknown>) { return result(() => studio.draft(input)); }
export async function saveContentPost(id: string, patch: Record<string, unknown>, expectedUpdatedAt: string) { return result(() => studio.save(id, patch, expectedUpdatedAt)); }
export async function reviseContentPost(id: string, instruction: string, expectedUpdatedAt: string) { return result(() => studio.revise(id, instruction, expectedUpdatedAt)); }
export async function recordContentFeedback(input: { postId?: string; ideaId?: string; kind: string; reason?: string; expectedUpdatedAt?: string }) { return result(() => studio.feedback(input)); }
export async function restoreContentVersion(id: string, expectedUpdatedAt: string) { return result(() => studio.restore(id, expectedUpdatedAt)); }
export async function markContentPublished(id: string, date: string) { return result(() => studio.publish(id, date)); }
export async function scheduleContentPost(id: string, date: string) { return result(() => studio.schedule(id, date)); }
export async function startContentFragment() { return result(() => studio.manual()); }
