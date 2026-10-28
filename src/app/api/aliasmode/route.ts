import {NextResponse} from 'next/server';
import {pool} from '@/lib/pg_setup';
import {requireWorkerAdmin} from '@/lib/worker-admin';
import {ensure,settings} from '@/lib/linkedin-workers.cjs';
import * as ads from '@/lib/aliasmode-store.cjs';
import * as sessions from '@/lib/account-session-store.cjs';
export const dynamic='force-dynamic';
export const runtime='nodejs';
async function authorize(request:Request,mutation=false){await requireWorkerAdmin();if(mutation){const origin=request.headers.get('origin');if(!origin||new URL(origin).origin!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')throw Error('Use AliasMode controls in the local CompelOS app.');if(!request.headers.get('content-type')?.startsWith('application/json'))throw Error('Expected a JSON request.');}}
export async function GET(request:Request){try{await authorize(request);}catch{return NextResponse.json({error:'AliasMode settings are available only in the local worker app.'},{status:403});}try{await ensure(pool);const id=new URL(request.url).searchParams.get('evidence');return NextResponse.json(id?await sessions.evidence(pool,id):await ads.publicSettings(pool),{headers:{'Cache-Control':'no-store'}});}catch{return NextResponse.json({error:'Could not load AliasMode settings from PostgreSQL. Check the local worker database connection.'},{status:503});}}
export async function PUT(request:Request){try{await authorize(request,true);}catch{return NextResponse.json({error:'Use AliasMode settings in the local worker app.'},{status:403});}try{await ensure(pool);return NextResponse.json(await ads.saveConfig(pool,await request.json()),{headers:{'Cache-Control':'no-store'}});}catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Could not save AliasMode settings.'},{status:400});}}
export async function POST(request:Request){try{await authorize(request,true);}catch{return NextResponse.json({error:'Use profile controls in the local worker app.'},{status:403});}try{
 await ensure(pool);const body=await request.json();if(body.action==='refresh')await ads.requestRefresh(pool);
 else if(body.action==='allow')await ads.allowProcessing(pool,body.enabled);
 else if(body.action==='bind')await ads.bind(pool,body);
 else if(body.action==='import')await ads.importProfile(pool,body);
 else if(body.action==='update')await ads.updateAccount(pool,body);
 else if(body.action==='session-policy'){const {action:_action,...input}=body;void _action;await sessions.configure(pool,input);}
 else if(body.action==='session-check')await sessions.request(pool,body.accountId,body.command);
 else if(body.action==='approve-unclear')await sessions.approveUnknown(pool,body);
 else if(body.action==='close'){if(typeof body.accountId!=='string')throw Error('Choose an account.');await ads.requestClose(pool,body.accountId);}
 else throw Error('Unknown AliasMode action.');
 return NextResponse.json({provider:await ads.publicSettings(pool),accounts:await settings(pool)},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Could not update AliasMode profiles.'},{status:400});}}
