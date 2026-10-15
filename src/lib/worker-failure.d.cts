export type WorkerFailure={stage:'linkedin'|'research'|'crm';code:string;reason:string;retryable:boolean;retryAt?:string|null};
export function failureOf(result:unknown):WorkerFailure;
