export const DEFAULT_PROSPECT_BATCH_SIZE = 200;
export const MAX_PROSPECT_BATCH_SIZE = 1000;
export const PROSPECT_JOB_POLL_SIZE = 100;

export function validateProspectBatchSize(value: number) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_PROSPECT_BATCH_SIZE) {
        throw new Error(`Choose a whole number between 1 and ${MAX_PROSPECT_BATCH_SIZE.toLocaleString()}.`);
    }
    return value;
}
