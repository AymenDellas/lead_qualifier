'use strict';
// Inspect generated manifests, never session files or environment-file contents.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),build=path.join(root,'.next');
const privateRoot=/^(?:\.browser-profiles.*|data|progress|queue.*|case-study-queue|case-study-results|scrape-results|api-data|backups|output|tmp|\.git|\.env.*)$/i;
let manifests=0,privateEntries=0;
function inspect(directory){
 for(const item of fs.readdirSync(directory,{withFileTypes:true})){
  const file=path.join(directory,item.name);
  if(item.isDirectory()){inspect(file);continue;}
  if(!item.name.endsWith('.nft.json'))continue;
  manifests++;
  for(const entry of JSON.parse(fs.readFileSync(file,'utf8')).files||[]){
   const relative=path.relative(root,path.resolve(directory,entry));
   if(!relative.startsWith('..')&&!path.isAbsolute(relative)&&privateRoot.test(relative.split(path.sep)[0]))privateEntries++;
  }
 }
}
if(!fs.existsSync(path.join(build,'BUILD_ID')))throw Error('Run npm run build first.');
inspect(path.join(build,'server'));
console.log(JSON.stringify({manifests,privateRuntimeEntries:privateEntries}));
if(!manifests||privateEntries)process.exitCode=1;
