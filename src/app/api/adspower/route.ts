import {NextResponse} from 'next/server';
export const dynamic='force-dynamic';
export function GET(){return NextResponse.json({error:'AdsPower integration retired. Use AliasMode profile controls.'},{status:410});}
export const POST=GET;
export const PUT=GET;

// import {NextResponse} from 'next/server';
// import {pool} from '@/lib/pg_setup';
// import {requireWorkerAdmin} from '@/lib/worker-admin';
// import {ensure,settings} from '@/lib/linkedin-workers.cjs';
// import * as ads from '@/lib/adspower-store.cjs';
// export const dynamic='force-dynamic';
// export const runtime='nodejs';
// async function authorize(request:Request,mutation=false){await requireWorkerAdmin();if(mutation){const origin=request.headers.get('origin');if(!origin||new URL(origin).origin!==new URL(request.url).origin||request.headers.get('sec-fetch-site')==='cross-site')throw Error('Use AdsPower controls in the local CompelOS app.');if(!request.headers.get('content-type')?.startsWith('application/json'))throw Error('Expected a JSON request.');}}
// export async function GET(request:Request){try{await authorize(request);}catch{return NextResponse.json({error:'AdsPower settings are available only in the local worker app.'},{status:403});}try{await ensure(pool);return NextResponse.json(await ads.publicSettings(pool),{headers:{'Cache-Control':'no-store'}});}catch{return NextResponse.json({error:'Could not load AdsPower settings from PostgreSQL. Check the local worker database connection.'},{status:503});}}
// export async function PUT(request:Request){try{await authorize(request,true);}catch{return NextResponse.json({error:'Use AdsPower settings in the local worker app.'},{status:403});}try{await ensure(pool);return NextResponse.json(await ads.saveConfig(pool,await request.json()),{headers:{'Cache-Control':'no-store'}});}catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Could not save AdsPower settings.'},{status:400});}}
// export async function POST(request:Request){try{await authorize(request,true);}catch{return NextResponse.json({error:'Use profile controls in the local worker app.'},{status:403});}try{
//  await ensure(pool);const body=await request.json();if(body.action==='refresh')await ads.requestRefresh(pool);
//  else if(body.action==='allow')await ads.allowProcessing(pool,body.enabled);
//  else if(body.action==='bind')await ads.bind(pool,body);
//  else if(body.action==='import')await ads.importProfile(pool,body);
//  else if(body.action==='update')await ads.updateAccount(pool,body);
//  else if(body.action==='close'){if(typeof body.accountId!=='string')throw Error('Choose an account.');await ads.requestClose(pool,body.accountId);}
//  else throw Error('Unknown AdsPower action.');
//  return NextResponse.json({provider:await ads.publicSettings(pool),accounts:await settings(pool)},{headers:{'Cache-Control':'no-store'}});
//  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:'Could not update AdsPower profiles.'},{status:400});}}
