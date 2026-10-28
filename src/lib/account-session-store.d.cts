export type SessionState={revision:number;engine:'aliasmode-chromium'|'cloakbrowser';launchMode:'headful'|'headless';proxyId:string;proxyHost:string;proxyPort:number|null;proxyCountry:string;proxyTimezone:string;expectedExitIp:string;policy:Record<string,number>;lifecycle:{state:string;reason:string;done?:number;required?:number;limit?:number;resumeAt?:string};network:Record<string,unknown>|null;gate:{verdict?:string;reason?:string;checkedAt?:string;reportId?:string;approvedAt?:string;sites?:{url:string;verdict:string;reason:string}[]}|null;fingerprint:{hash:string;fields:Record<string,unknown>;checkedAt:string}|null;drift:Record<string,unknown>|null;diagnosticRequested:string|null};
export function ensure(pool:unknown):Promise<void>;
export function configure(pool:unknown,input:unknown):Promise<void>;
export function request(pool:unknown,id:string,command:string):Promise<void>;
export function evidence(pool:unknown,id:string):Promise<Record<string,unknown>>;
export function approveUnknown(pool:unknown,input:unknown):Promise<void>;
