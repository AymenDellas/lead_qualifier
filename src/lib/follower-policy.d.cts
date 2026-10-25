import type {AudienceEvidence} from './prospect-qualification.cjs';
export const DEFAULT_MIN_FOLLOWERS:number;
export function minFollowers(env?:Record<string,string|undefined>):number;
export function parseFollowerCount(value:unknown):number|null;
export function audienceRecord(value:unknown,kind?:'followers'|'connections'):{rawText:string;count:number|null};
export function followersDecision(record?:Pick<AudienceEvidence,'rawText'|'count'>|null,threshold?:number):{status:'CONTINUE'|'REVIEW'|'REJECTED';reason:string|null;threshold:number};
