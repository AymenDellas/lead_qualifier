'use strict';
const path=require('node:path'),{execFile}=require('node:child_process');
const {profileId,providerError}=require('./aliasmode-client.cjs');

function helperPath(value=process.env.ALIASMODE_HELPER_PATH){
 const executable=value||(process.platform==='win32'&&process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'AliasMode','aliasmode-mcp.exe'):'');
 if(!executable||!path.isAbsolute(executable)||!/^aliasmode-mcp(?:\.exe)?$/i.test(path.basename(executable)))throw providerError('ALIASMODE_HELPER_PATH','Set ALIASMODE_HELPER_PATH to the installed AliasMode helper executable.');
 return executable;
}
function environment(source=process.env){
 const allowed=new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA','TEMP','TMP','HOME','XDG_DATA_HOME','ALIASMODE_RUNTIME_DESCRIPTOR']);
 return Object.fromEntries(Object.entries(source).filter(([key])=>allowed.has(key.toUpperCase())));
}
function commandError(error,output){
 if(error?.code==='ENOENT')return providerError('ALIASMODE_HELPER_MISSING','AliasMode helper was not found. Install AliasMode or set ALIASMODE_HELPER_PATH, then restart the agent.');
 if(error?.killed||error?.code==='ETIMEDOUT')return providerError('ALIASMODE_CLI_TIMEOUT','AliasMode helper timed out. Check the profile state in AliasMode before trying again.');
 if(/mode_conflict/.test(String(output?.error||'')))return providerError('ALIASMODE_MODE_CONFLICT','This profile is open in a different browser mode. Close the profile before switching modes.');
 if(/not_owned|does not own/.test(String(output?.error||'')))return providerError('ALIASMODE_CLI_RACE','The profile was opened by another connection. Close it explicitly before retrying.');
 return providerError('ALIASMODE_CLI_REJECTED','AliasMode helper could not complete the command. Check the installed helper and local AliasMode runtime.');
}
function createAliasModeCli({executable,run=execFile,env=process.env}={}){
 // One short-lived helper at a time bounds transient RAM. No helper runs per lead.
 const queue=require('./bounded-work.cjs').createBoundedQueue({capacity:10});let versionTask=null;
 async function command(args,timeout=20000){
  return (await queue.submit(()=>new Promise((resolve,reject)=>{
   let file;try{file=helperPath(executable);}catch(error){reject(error);return;}
   const complete=(error,stdout)=>{let value;try{value=JSON.parse(stdout);}catch{}if(error||value?.ok!==true||!value.result||typeof value.result!=='object')reject(commandError(error,value));else resolve(value.result);};
   try{run(file,[...args,'--json'],{windowsHide:true,shell:false,encoding:'utf8',timeout,maxBuffer:256*1024,env:environment(env)},complete);}catch(error){reject(commandError(error));}
  }))).done;
 }
 function version(){if(!versionTask)versionTask=command(['version']).then(value=>{if(typeof value.version!=='string'||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version))throw providerError('ALIASMODE_HELPER_VERSION','AliasMode helper returned an unsupported version response. Update AliasMode, then restart the agent.');return value.version;}).catch(error=>{versionTask=null;throw error;});return versionTask;}
 async function status(id){profileId(id);const value=await command(['browser','status','--profile',id]);
  if(value.profileId!==id||typeof value.running!=='boolean'||!['running','closed','uncertain'].includes(value.state))throw providerError('ALIASMODE_CLI_RESPONSE','AliasMode helper returned an unsupported profile state.');
  if(value.running&&(typeof value.headless!=='boolean'||!Number.isInteger(value.port)||value.port<1||value.port>65535))throw providerError('ALIASMODE_MODE_UNVERIFIED','AliasMode did not confirm the browser mode and connection. Check the Chromium profile in AliasMode.');
  return {running:value.running,state:value.state,headless:value.running?value.headless:null,port:value.running?value.port:null};
 }
 async function open(id,{headless=true}={}){profileId(id);if(typeof headless!=='boolean')throw providerError('ALIASMODE_MODE_UNVERIFIED','Choose a supported browser mode.');
  await version();const value=await command(['browser','open','--profile',id,...(headless?['--headless']:[])],120000);
  if(value.profileId!==id||value.alreadyOpen!==false||!Number.isInteger(value.port)||value.port<1||value.port>65535)throw providerError('ALIASMODE_CLI_RACE','AliasMode did not confirm a newly opened profile. Reconcile it before retrying.');
  // The receipt is safe numeric ownership evidence, never a CDP capability URL.
  if(value.headless!==headless)throw Object.assign(providerError('ALIASMODE_MODE_UNVERIFIED',headless?'AliasMode did not start headlessly. Processing remains paused.':'AliasMode did not open a visible browser. Set its normal runtime mode to visible for manual sign-in.'),{startedProfilePort:value.port});
  return {headless:value.headless,port:value.port};
 }
 return {version,status,open,idle:queue.idle};
}
module.exports={createAliasModeCli,helperPath,environment};
