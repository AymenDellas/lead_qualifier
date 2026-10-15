import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

type Snapshot = Record<string, unknown> & { jobId: string; heartbeatAt: number };
type FileSystem = Pick<typeof fs.promises, 'mkdir' | 'writeFile' | 'rename' | 'unlink' | 'readFile'>;
type CachedJob = { snapshot: Snapshot; persistenceError?: string; cancelRequested?: boolean };
const state = globalThis as typeof globalThis & { __compelFinderProgress?: Map<string, CachedJob> };
const cache = state.__compelFinderProgress ??= new Map<string, CachedJob>();
const TRANSIENT_LOCKS = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Windows runtime files belong outside a synced workspace. Docker keeps its existing volume. */
export function finderRuntimeDirectory(workspace = process.cwd(), platform = process.platform, localAppData = process.env.LOCALAPPDATA): string {
    if (platform !== 'win32') return path.join(workspace, 'queue-results');
    const projectId = createHash('sha256').update(path.resolve(workspace).toLowerCase()).digest('hex').slice(0, 16);
    return path.join(localAppData || os.tmpdir(), 'Compel', 'lead-finder', projectId);
}

export function createFinderProgressStore(options: {
    directory?: string;
    legacyDirectory?: string;
    fileSystem?: FileSystem;
    retryDelays?: number[];
    onPersistenceError?: (jobId: string, code: string) => void;
} = {}) {
    const directory = options.directory || finderRuntimeDirectory();
    const legacyDirectory = options.legacyDirectory || path.join(process.cwd(), 'queue-results');
    const files = options.fileSystem || fs.promises;
    const retryDelays = options.retryDelays || [50, 100, 200, 400, 800];
    const filePath = (jobId: string, extension: string, root = directory) => {
        if (!/^find-\d+$/.test(jobId)) throw new Error('Invalid discovery job ID.');
        return path.join(root, `${jobId}.${extension}`);
    };
    const key = (jobId: string) => filePath(jobId, 'json');
    const retry = async <T>(operation: () => Promise<T>): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
            try { return await operation(); }
            catch (error) {
                const code = (error as NodeJS.ErrnoException).code || '';
                if (!TRANSIENT_LOCKS.has(code) || attempt >= retryDelays.length) throw error;
                await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
            }
        }
    };

    return {
        directory,
        async write(jobId: string, payload: Record<string, unknown>) {
            const file = key(jobId);
            const serialized = JSON.stringify({ ...payload, jobId, heartbeatAt: Date.now() });
            const entry: CachedJob = { ...cache.get(file), snapshot: JSON.parse(serialized) };
            cache.set(file, entry);
            // Independent temp names cannot overwrite another snapshot waiting on a lock.
            const temporary = `${file}.${randomUUID()}.tmp`;
            try {
                await retry(async () => {
                    await files.mkdir(directory, { recursive: true });
                    await files.writeFile(temporary, serialized, 'utf8');
                    await files.rename(temporary, file);
                });
                entry.persistenceError = undefined;
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code || 'IO_ERROR';
                if (entry.persistenceError !== code) {
                    try { options.onPersistenceError?.(jobId, code); } catch { /* Logging cannot stop discovery either. */ }
                }
                entry.persistenceError = code;
                // A progress checkpoint is separate from a CRM save. Polling can still
                // read this live snapshot, and the next update retries persistence.
            } finally {
                await files.unlink(temporary).catch(() => {});
            }
            // Bound completed history in memory; all running jobs remain readable.
            if (cache.size > 20) {
                for (const [cachedKey, value] of cache) {
                    if (cache.size <= 20) break;
                    if (value.snapshot.status !== 'running' && !value.persistenceError) cache.delete(cachedKey);
                }
            }
        },
        async read(jobId: string): Promise<Snapshot | null> {
            const live = cache.get(key(jobId));
            if (live) return live.persistenceError
                ? { ...live.snapshot, progressPersistenceWarning: `Progress checkpoint temporarily unavailable (${live.persistenceError}); live progress and CRM saves continue.` }
                : live.snapshot;
            for (const file of [...new Set([key(jobId), filePath(jobId, 'json', legacyDirectory)])]) {
                try { return JSON.parse(await retry(() => files.readFile(file, 'utf8'))); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
            return null;
        },
        cancelled(jobId: string) {
            return Boolean(cache.get(key(jobId))?.cancelRequested || fs.existsSync(filePath(jobId, 'cancel'))
                || fs.existsSync(filePath(jobId, 'cancel', legacyDirectory)));
        },
        async cancel(jobId: string) {
            const entry = cache.get(key(jobId));
            if (entry) entry.cancelRequested = true;
            await retry(async () => {
                await files.mkdir(directory, { recursive: true });
                await files.writeFile(filePath(jobId, 'cancel'), String(Date.now()), 'utf8');
            });
            // Older background tasks may still be checking their original flag path.
            if (directory !== legacyDirectory && fs.existsSync(filePath(jobId, 'json', legacyDirectory)))
                await files.writeFile(filePath(jobId, 'cancel', legacyDirectory), String(Date.now()), 'utf8').catch(() => {});
        },
        async clearCancel(jobId: string) {
            const entry = cache.get(key(jobId));
            if (entry) entry.cancelRequested = false;
            for (const file of [...new Set([filePath(jobId, 'cancel'), filePath(jobId, 'cancel', legacyDirectory)])])
                await files.unlink(file).catch(() => {});
        },
    };
}
