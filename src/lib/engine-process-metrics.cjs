'use strict';
const fs=require('node:fs/promises'),{execFile}=require('node:child_process'),{performance}=require('node:perf_hooks');
function descendants(rows,root){
 const ids=new Set([root]);let changed=true;
 while(changed){changed=false;for(const row of rows)if(ids.has(row.ppid)&&!ids.has(row.pid)){ids.add(row.pid);changed=true;}}
 return rows.filter(row=>ids.has(row.pid)&&!/^powershell(?:\.exe)?$/i.test(row.name));
}
async function processRows(){
 if(process.platform==='win32'){
  const command="Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";
  const output=await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],
   {windowsHide:true,timeout:10000,maxBuffer:4*1024*1024},(error,stdout)=>error?reject(error):resolve(stdout)));
  const parsed=JSON.parse(output);return (Array.isArray(parsed)?parsed:[parsed]).map(row=>({pid:Number(row.ProcessId),ppid:Number(row.ParentProcessId),
   name:row.Name,rss:Number(row.WorkingSetSize),cpuMs:(Number(row.KernelModeTime)+Number(row.UserModeTime))/10000}));
 }
 if(process.platform==='linux'){
  const names=await fs.readdir('/proc'),rows=[];
  await Promise.all(names.filter(name=>/^\d+$/.test(name)).map(async name=>{
   try{const [stat,status]=await Promise.all([fs.readFile('/proc/'+name+'/stat','utf8'),fs.readFile('/proc/'+name+'/status','utf8')]);
    const end=stat.lastIndexOf(')'),values=stat.slice(end+2).split(' ');
    // Linux clock ticks are read from getconf rather than assuming HZ.
    rows.push({pid:Number(name),ppid:Number(values[1]),name:stat.slice(stat.indexOf('(')+1,end),
     rss:Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]||0)*1024,ticks:Number(values[11])+Number(values[12])});
   }catch{/* Process exited during sampling. */}
  }));
  const hz=await new Promise((resolve,reject)=>execFile('getconf',['CLK_TCK'],{timeout:2000},(error,out)=>error?reject(error):resolve(Number(out))));
  return rows.map(row=>({...row,cpuMs:row.ticks*1000/hz}));
 }
 throw Error('Process-tree measurements are available on Windows and Linux.');
}
function createSampler({pid=process.pid,read=processRows,now=Date.now}={}){
 let previous=null,peakMB=0,peakCpuPercent=0;
 return async()=>{
  const clock=performance.now(),all=await read(),at=now(),rows=descendants(all,pid);
  const treeCpu=rows.reduce((sum,row)=>sum+row.cpuMs,0),byPid=new Map(rows.map(row=>[row.pid,row.cpuMs]));
  // Compare only surviving PIDs; a process exiting must not subtract CPU used
  // by surviving renderers. Short-lived processes can still be missed; disclose it.
  const cpuDelta=previous?rows.reduce((sum,row)=>sum+Math.max(0,row.cpuMs-(previous.byPid.get(row.pid)??row.cpuMs)),0):null;
  const cpuPercent=previous&&at>previous.at?cpuDelta*100/(at-previous.at):null;
  const chrome=rows.filter(row=>/chrome|chromium/i.test(row.name)),mb=bytes=>Math.round(bytes/1048576);
  const treeRssMB=mb(rows.reduce((sum,row)=>sum+row.rss,0));peakMB=Math.max(peakMB,treeRssMB);peakCpuPercent=Math.max(peakCpuPercent,cpuPercent||0);
  previous={at,byPid};
  return {pid,treeRssMB,chromeRssMB:mb(chrome.reduce((sum,row)=>sum+row.rss,0)),nodeRssMB:mb(rows.find(row=>row.pid===pid)?.rss||0),
   processes:rows.length,chromeProcesses:chrome.length,cpuPercent,peakTreeRssMB:peakMB,peakCpuPercent,
   cpuAccounting:'one core = 100%; sampled surviving processes',cpuMs:treeCpu,sampleMs:performance.now()-clock};
 };
}
function startResourceMonitor({pool,owner,queryStats,intervalMs=15000,log=()=>{}}){
 const telemetry=require('./engine-telemetry.cjs'),sample=createSampler();let running=false,closed=false,active=null;
 async function tick(){
  if(running||closed)return;running=true;
  try{const data={...await sample(),...telemetry.queryRates(queryStats)};
   await telemetry.ensure(pool);await pool.query(`INSERT INTO compel_engine_resources(owner,pid,data) VALUES($1,$2,$3::jsonb)
    ON CONFLICT(owner) DO UPDATE SET data=EXCLUDED.data,seen_at=NOW()`,[owner,process.pid,JSON.stringify(data)]);
  }catch(error){log('Process measurement unavailable: '+error.message);}finally{running=false;}
 }
 const timer=setInterval(()=>{active=tick();},intervalMs);timer.unref();active=tick();
 return async()=>{closed=true;clearInterval(timer);await active;};
}
module.exports={descendants,processRows,createSampler,startResourceMonitor};
