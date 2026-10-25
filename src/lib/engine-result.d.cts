import type {Lead} from '../app/actions/scraper-actions';
export function normalizeEngineResult(value:unknown,fallbackUrl?:string):Lead|null;
export function normalizeEngineResults(value:unknown):Lead[];
