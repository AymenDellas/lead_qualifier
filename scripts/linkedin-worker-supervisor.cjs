'use strict';
// Fixed dashboard launcher, retained as an alias. It runs the same single agent.
const {main,safeMessage}=require('../worker.cjs');
if(require.main===module)main().catch(error=>{console.error('[Agent]',safeMessage(error));process.exitCode=1;});
module.exports={main};
