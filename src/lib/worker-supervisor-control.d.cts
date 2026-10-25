export type SupervisorStatus = {
    state: 'offline' | 'starting' | 'online' | 'unresponsive' | 'unavailable' | 'failed';
    canStart: boolean;
    message: string;
    stage?:string; failedStage?:string; action?:string;
};
export function createWorkerSupervisorController(options: {
    root?: string;
    isOnline: () => Promise<boolean>;
}): { status(): Promise<SupervisorStatus>; start(): Promise<SupervisorStatus> };
