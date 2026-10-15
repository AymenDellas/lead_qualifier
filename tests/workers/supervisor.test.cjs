'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const source=fs.readFileSync(path.resolve(__dirname,'../../scripts/linkedin-worker-supervisor.cjs'),'utf8');

function supervisor(selectedIds=['one']) {
 const accounts=[{id:'one',label:'Account 1',changed_at:'version-1',archived:false,login_requested_at:null},
  {id:'two',label:'Account 2',changed_at:'version-1',archived:false,login_requested_at:'request-1'}];
 const launches=[],errors=[];
 const pool={query:async(sql,values)=>({rows:sql.startsWith('UPDATE')?[]:sql.startsWith('SELECT status')?[{status:{status:'offline'}}]:accounts.filter(a=>!a.archived&&(a.login_requested_at||a.logout_requested_at||values[0].includes(a.id)))}),end:async()=>{}};
 const modules={
  'node:fs':{readFileSync:()=>'',mkdirSync(){},existsSync:()=>false},'node:path':path,
  'node:child_process':{fork:(_file,args)=>{
   const child=new EventEmitter();child.connected=true;child.pid=100+launches.length;child.args=args;
   child.send=()=>{child.stopped=true;queueMicrotask(()=>child.emit('exit',0));};
   launches.push(child);return child;
  },execFileSync:()=>assert.fail('No force termination expected')},
  pg:{Pool:class{constructor(){return pool;}}},
  '../src/lib/linkedin-workers.cjs':{selectedAccounts:async()=>accounts.filter(a=>!a.archived&&!a.logout_requested_at&&!a.signed_out_at&&selectedIds.includes(a.id))},
 };
 const context=vm.createContext({__dirname:path.resolve(__dirname,'../../scripts'),require:name=>modules[name],
  process:{env:{},on(){},platform:'win32'},console:{log(){},error:(...args)=>errors.push(args)},
  setTimeout,clearTimeout,clearInterval,Date});
 const functions=vm.runInContext(source.slice(0,source.lastIndexOf('\nmain().catch'))+'\n({tick,children})',context);
 return {...functions,accounts,launches,errors};
}
async function exited(child) { child.emit('exit',0); await new Promise(resolve=>queueMicrotask(resolve)); }

test('consuming a sign-in request keeps an unselected manual browser alive until it finishes',async()=>{
 const s=supervisor();await s.tick();assert.equal(s.launches.length,2);
 const manual=s.launches.find(child=>child.args.includes('two'));
 assert.ok(manual.args.includes('--check-login'));
 s.accounts[1].login_requested_at=null;
 await s.tick();assert.equal(manual.stopped,undefined);assert.equal(s.launches.length,2);
 await exited(manual);await s.tick();
 assert.equal(s.launches.length,2,'an unselected account stays signed in without starting a worker');
 assert.deepEqual(s.errors,[]);
});

test('successful sign-in transitions a selected account to one normal worker without repeated checks or crash delay',async()=>{
 const s=supervisor(['one','two']);await s.tick();
 const manual=s.launches.find(child=>child.args.includes('two'));
 s.accounts[1].login_requested_at=null;await exited(manual);await s.tick();
 assert.equal(s.launches.length,3);
 const normal=s.launches[2];assert.deepEqual([...normal.args],['--account','two']);
 await s.tick();await s.tick();assert.equal(s.launches.length,3);
 assert.deepEqual(s.errors,[]);
});

test('removing an account still stops its manual browser after the request has been consumed',async()=>{
 const s=supervisor();await s.tick();
 const manual=s.launches.find(child=>child.args.includes('two'));
 s.accounts[1].login_requested_at=null;s.accounts[1].archived=true;
 await s.tick();assert.equal(manual.stopped,true);assert.equal(s.launches.length,2);
 assert.deepEqual(s.errors,[]);
});
test('sign-out stops the normal browser before opening the same profile solely for logout',async()=>{
 const s=supervisor(['one']);await s.tick();const normal=s.launches[0];
 s.accounts[0].logout_requested_at='logout-1';s.accounts[0].changed_at='version-2';
 await s.tick();
 assert.equal(normal.stopped,true);
 assert.deepEqual([...s.launches.at(-1).args],['--account','one','--logout']);
 const logout=s.launches.at(-1);await s.tick();assert.equal(logout.stopped,undefined);
 s.accounts[0].logout_requested_at=null;s.accounts[0].signed_out_at='done';await exited(logout);await s.tick();
 assert.equal(s.launches.length,3,'a signed-out account must not auto-login');assert.deepEqual(s.errors,[]);
});
