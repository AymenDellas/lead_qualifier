'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {descendants,createSampler}=require('../../src/lib/engine-process-metrics.cjs');
const mb=1048576;
test('includes every descendant renderer and excludes unrelated Chrome and sampler helper',()=>{
 const rows=[{pid:1,ppid:0,name:'node'},{pid:2,ppid:1,name:'chrome'},{pid:3,ppid:2,name:'chrome'},
  {pid:4,ppid:0,name:'chrome'},{pid:5,ppid:1,name:'powershell.exe'}];
 assert.deepEqual(descendants(rows,1).map(row=>row.pid),[1,2,3]);
});
test('reports whole Chrome RSS and per-core CPU using successive samples',async()=>{
 let at=0,cpu=100;
 const sample=createSampler({pid:1,now:()=>at,read:async()=>[
  {pid:1,ppid:0,name:'node',rss:30*mb,cpuMs:10},
  {pid:2,ppid:1,name:'chrome.exe',rss:150*mb,cpuMs:cpu},
  {pid:3,ppid:2,name:'chrome.exe',rss:100*mb,cpuMs:cpu},
 ]});
 const first=await sample();assert.equal(first.treeRssMB,280);assert.equal(first.chromeRssMB,250);assert.equal(first.cpuPercent,null);
 at=1000;cpu=350;const second=await sample();assert.equal(second.cpuPercent,50);assert.equal(second.peakTreeRssMB,280);
});
