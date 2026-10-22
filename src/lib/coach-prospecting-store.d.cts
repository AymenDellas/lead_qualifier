export function ensure(pool: any): Promise<void>;
export function transaction<T>(
  pool: any,
  work: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T>;
export function createRun(pool: any, input: any): Promise<string>;
export function changeRun(
  pool: any,
  id: string,
  operation: string,
): Promise<void>;
export function refreshRuns(pool: any): Promise<void>;
export function activity(
  client: any,
  id: string,
  kind: string,
  note: string,
): Promise<void>;
