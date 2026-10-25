'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFile}=require('node:child_process');
const normalize=value=>String(value||'').replace(/\\/g,'/').toLowerCase();
async function isProcessOwner(pid,script) {
 if(!Number.isInteger(pid)||pid<=0)return false;
 try{process.kill(pid,0);}catch(error){return error.code==='ESRCH'?false:null;}
 try {
  let command;
  if(process.platform==='linux')command=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').replace(/\0/g,' ');
  else {
   const file=process.platform==='win32'?'powershell.exe':'ps';
   const args=process.platform==='win32'?['-NoProfile','-NonInteractive','-Command',`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){$p.CommandLine | ConvertTo-Json -Compress}`]:['-p',String(pid),'-o','command='];
   const output=await new Promise((resolve,reject)=>execFile(file,args,{windowsHide:true,timeout:5000,maxBuffer:32768},(error,stdout)=>error?reject(error):resolve(stdout.trim())));
   if(!output)return false;
   command=process.platform==='win32'?JSON.parse(output):output;
  }
  const scripts=Array.isArray(script)?script:[script],normalized=normalize(command);
  if(scripts.some(file=>normalized.includes(normalize(path.resolve(file)))))return true;
  // A relative Node entry point has unknown cwd. Never misclassify that live
  // process as dead and erase its lock (the previous code did exactly that).
  if(scripts.some(file=>normalized.includes(normalize(path.basename(file)))))return null;
  return false;
 }catch{return null;} // Unknown ownership never authorizes deletion or termination.
}
async function clearUnownedProcessLock(file,script,{staleMs=0,now=Date.now}={}) {
 let original,saved;try{original=fs.readFileSync(file,'utf8');saved=JSON.parse(original);}catch{return;}
 if(await isProcessOwner(saved.pid,script)!==false)return;
 if(now()-Number(saved.heartbeatAt||saved.startedAt||fs.statSync(file).mtimeMs)<staleMs)return;
 if(fs.readFileSync(file,'utf8')===original)fs.unlinkSync(file);
}
module.exports={isProcessOwner,clearUnownedProcessLock};
