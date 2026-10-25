export function controlEngine(pool:unknown,action:'resume'|'pause'):Promise<{action:'resume'|'pause';updated:string[];blocked:{id:string;label:string;reason:string}[]}>;
