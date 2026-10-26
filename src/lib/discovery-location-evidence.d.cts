export type DiscoveryCountry='UK'|'US'|'Canada';
export type DiscoveryLocationStatus='CONFIRMED'|'OUTSIDE_TARGET'|'UNCONFIRMED'|'CONFLICT';
export type DiscoveryLocationEvidence={version:1;status:'CONFIRMED';country:DiscoveryCountry;rawText:string;source:string;requestedLocation:string;observedAt:string};
export type PersonLocation={status:DiscoveryLocationStatus;country:DiscoveryCountry|null;rawText:string};
export function canonicalDiscoveryTarget(value:unknown):DiscoveryCountry|null;
export function parsePersonLocation(value:unknown):PersonLocation;
export function assessDiscoveryLocation(item:unknown,requestedLocation:string,observedAt?:string):PersonLocation&{source:string|null;reasonCode:string|null;evidence?:DiscoveryLocationEvidence};
