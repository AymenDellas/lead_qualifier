const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
process.env.EMAIL_VERIFY_HOST_INTERVAL_MS = '0';
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...args) {
    if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2));
    return originalResolve.call(this, request, parent, ...args);
};
require.extensions['.ts'] = (module, filename) => {
    let source = fs.readFileSync(filename, 'utf8');
    if (filename.endsWith('email-verifier-actions.ts')) source += '\nexport const __test = {classifyReject, rejectToResult, applySmtpResult, isValidSyntax, getVerificationReadiness};';
    module._compile(ts.transpileModule(source, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    }}).outputText, filename);
};
const dnsModule = require('../src/lib/email-dns.ts');
const smtp = require('../src/lib/email-smtp.ts');
const destinations = new Map();
dnsModule.resolveMailDomain = async domain => destinations.get(domain) ?? {status:'TEMP_ERROR', records:[], reason:'DNS timed out'};
const verifier = require('../src/app/actions/email-verifier-actions.ts');
const { classifyReject, rejectToResult } = verifier.__test;
const realConnect = net.createConnection;
const hosts = new Map();
// Tests can only connect to our local fixture; never contact a real mail server.
net.createConnection = options => {
    assert.ok(hosts.has(options.host), 'unexpected SMTP destination: ' + options.host);
    return realConnect({host:'127.0.0.1', port:hosts.get(options.host)});
};
let passed = 0;
const test = async (label, fn) => { await fn(); passed++; console.log('PASS ' + label); };
const absent = code => Promise.reject(Object.assign(new Error(code), {code}));
const fixtures = [];
async function fixture(host, handler, banner = '220 local SMTP\r\n', senderReply = '250 Sender OK\r\n') {
    const commands = [];
    const connections = new Set();
    const server = net.createServer(socket => {
        connections.add(socket); socket.on('close', () => connections.delete(socket));
        socket.on('error', () => {});
        let buffer = '';
        if (banner) socket.write(banner);
        socket.on('data', data => {
            buffer += data.toString();
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const command = buffer.slice(0,newline).trim(); buffer = buffer.slice(newline+1);
                commands.push(command);
                if (command === 'QUIT') {socket.end('221 Bye\r\n'); continue;}
                if (command.startsWith('MAIL')) socket.write(senderReply);
                else handler(command, socket);
            }
        });
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    hosts.set(host, server.address().port);
    fixtures.push(async()=>{ for(const socket of connections) socket.destroy(); await new Promise(resolve=>server.close(resolve));});
    return commands;
}
const normalHandler = (actualReply, controlReply = '550 5.1.1 No such user') => (command, socket) => {
    if (command.startsWith('EHLO') || command.startsWith('HELO')) socket.write('250-Hello\r\n250 OK\r\n');
    else if (command.startsWith('RCPT')) socket.write((command.includes('<real@') ? actualReply : controlReply) + '\r\n');
};
function destination(domain, mx) {destinations.set(domain,{status:'OK',records:mx.map((exchange,priority)=>({exchange,priority})),reason:'MX found'});}
function probe(host, emails = ['real@fixture.test'], overrides = {}) {
    return smtp.runSmtpProbe({host,helo:'verify.fixture.test',mailFrom:'contact@fixture.test', emails,
        control:'random1234@fixture.test',timeoutMs:1000,classify:classifyReject,reject:rejectToResult,
        summarize:text=>text,noteHostBlock:()=>false,...overrides});
}
(async()=>{
    await test('SMTP refusal classification preserves temporary and ambiguous mailboxes', async()=>{
        for (const code of [421,450,451,452]) assert.equal(classifyReject(code,'550 5.1.1 User unknown'),'TRANSIENT');
        assert.equal(classifyReject(550,'550 5.7.1 Client blocked using Spamhaus'),'POLICY_BLOCK');
        assert.equal(classifyReject(550,'550 5.1.1 User unknown'),'MAILBOX_UNKNOWN');
        assert.equal(classifyReject(550,'550 garbl rejected'),'AMBIGUOUS');
        for (const [code,text] of [[550,'550 Rejected'],[551,'551 User not local'],[552,'552 5.2.2 Mailbox full'],[550,'550 5.2.1 Mailbox disabled'],[550,'550 Mailbox unavailable']]) {
            assert.equal(classifyReject(code,text),'AMBIGUOUS');
            assert.equal(rejectToResult(code,text).valid,null);
        }
        assert.equal(rejectToResult(450,'450 Rate limited').message,'SMTP temporarily deferred; retry later');
        assert.equal(rejectToResult(451,'451 Greylisted').message,'GREYLISTED');
    });
    await test('split packets, multiline replies, and coalesced replies', async()=>{
        const reader = new smtp.SmtpReplyReader();
        assert.deepEqual(reader.push('250-Hel'),[]);
        assert.deepEqual(reader.push('lo\r\n250 O'),[]);
        assert.deepEqual(reader.push('K\r\n550 5.1.1 Missing\r\n'),[
            {code:250,text:'250-Hello\r\n250 OK'}, {code:550,text:'550 5.1.1 Missing'}]);
        assert.throws(()=>new smtp.SmtpReplyReader().push('x'.repeat(65537)),/64 KiB/);
        assert.throws(()=>new smtp.SmtpReplyReader().push('250-Hello\r\n550 Wrong\r\n'),/Inconsistent/);
    });
    await test('MX timeout remains UNKNOWN and discovery retains possible address', async()=>{
        let fallback = false;
        const answer=await dnsModule.lookupMailDomain('timeout.test',{resolveMx:()=>absent('ETIMEOUT'),resolve4:()=>{fallback=true;return[]},resolve6:()=>[]});
        assert.equal(answer.status,'TEMP_ERROR'); assert.equal(fallback,false);
        const single=await verifier.verifyEmail('real@timeout.test'); assert.equal(single.status,'UNKNOWN');
        const batch=await verifier.verifyEmailBatchFast(['real@timeout.test']); assert.equal(batch[0].status,'UNKNOWN');
    });
    await test('null MX explicitly refuses mail; absent MX uses IPv6 implicit destination', async()=>{
        for (const exchange of ['.','']) {
            const result=await dnsModule.lookupMailDomain('no-mail.test',{resolveMx:async()=>[{exchange,priority:0}],resolve4:()=>{throw Error('unexpected A')},resolve6:()=>[]});
            assert.equal(result.status,'NO_MAIL');
        }
        const result=await dnsModule.lookupMailDomain('ipv6.test',{resolveMx:()=>absent('ENODATA'),resolve4:()=>absent('ENODATA'),resolve6:async()=>['::1']});
        assert.equal(result.status,'OK'); assert.equal(result.records[0].exchange,'ipv6.test');
        assert.equal((await dnsModule.lookupMailDomain('missing.test',{resolveMx:()=>absent('ENOTFOUND'),resolve4:()=>absent('ENOTFOUND'),resolve6:()=>absent('ENODATA')})).status,'NO_MAIL');
        assert.equal((await dnsModule.lookupMailDomain('a-timeout.test',{resolveMx:()=>absent('ENODATA'),resolve4:()=>absent('ETIMEOUT'),resolve6:()=>absent('ENODATA')})).status,'TEMP_ERROR');
    });
    await test('real acceptance plus mailbox-level control rejection reaches VALID', async()=>{
        const commands=await fixture('mx.valid.test',normalHandler('250 2.1.5 OK')); destination('valid.test',['mx.valid.test']);
        const result=await verifier.verifyEmail('real@valid.test');
        assert.equal(result.status,'VALID'); assert.equal(result.checks.catchAll,false); assert.equal(result.method,'SMTP_DIRECT');
        assert.ok(result.expiresAt); assert.ok(commands.every(command=>!command.startsWith('DATA')));
    });
    await test('catch-all and policy-rejected control stay RISKY', async()=>{
        await fixture('mx.catch.test',normalHandler('250 OK','250 OK')); destination('catch.test',['mx.catch.test']);
        assert.equal((await verifier.verifyEmail('real@catch.test')).status,'RISKY');
        await fixture('mx.control.test',normalHandler('250 OK','550 5.7.1 Policy rejected')); destination('control.test',['mx.control.test']);
        const result=await verifier.verifyEmail('real@control.test'); assert.equal(result.status,'RISKY');
        assert.equal(result.checks.catchAll,null); assert.match(result.reason,/Policy rejected/);
    });
    await test('batch refuses sender at banner, EHLO or MAIL without losing evidence', async()=>{
        for (const stage of ['BANNER','EHLO','MAIL']) {
            const host='mx.'+stage.toLowerCase()+'.test';
            const commands=await fixture(host,(command,socket)=>{
                if(command.startsWith('EHLO')) socket.write(stage==='EHLO'?'550 5.7.1 Spamhaus blocked\r\n':'250 OK\r\n');
            },stage==='BANNER'?'554 5.7.1 Spamhaus blocked\r\n':undefined,
              stage==='MAIL'?'550 5.7.1 Spamhaus blocked\r\n':undefined);
            const results=await probe(host,['real@fixture.test','other@fixture.test']);
            for(const result of results.values()) {assert.equal(result.valid,null);assert.equal(result.blocked,true);assert.match(result.text,/Spamhaus/);}
            assert.ok(!commands.some(command=>command.startsWith('RCPT')));
            destination(stage.toLowerCase()+'-cache.test',[host]);
            await verifier.verifyEmailBatchFast(['real@'+stage.toLowerCase()+'-cache.test']);
            assert.ok((await verifier.getBlockedHosts()).some(block=>block.host===host));
        }
    });
    await test('disconnect and stalled control preserve previously accepted recipient', async()=>{
        await fixture('mx.closed.test',(command,socket)=>{
            if(command.startsWith('EHLO')) socket.write('250 OK\r\n');
            else if(command.includes('<real@')) socket.write('250 OK\r\n'); else socket.destroy();
        });
        const answer=(await probe('mx.closed.test')).get('real@fixture.test');
        assert.equal(answer.valid,true);assert.equal(answer.catchAll,null);assert.match(answer.text,/closed/);
        await fixture('mx.stall.test',(command,socket)=>{
            if(command.startsWith('EHLO')) socket.write('250 OK\r\n');
            else if(command.includes('<real@')) socket.write('250 OK\r\n');
        });
        const stalled=(await probe('mx.stall.test',undefined,{timeoutMs:100})).get('real@fixture.test');
        assert.equal(stalled.valid,true);assert.equal(stalled.catchAll,null);assert.match(stalled.text,/deadline/);
    });
    await test('EHLO unsupported falls back to HELO', async()=>{
        const commands=await fixture('mx.helo.test',(command,socket)=>{
            if(command.startsWith('EHLO')) socket.write('502 Command not supported\r\n');
            else if(command.startsWith('HELO')) socket.write('250 Hello\r\n');
            else socket.write(command.includes('<real@')?'250 OK\r\n':'550 5.1.1 Missing\r\n');
        });
        assert.equal((await probe('mx.helo.test')).get('real@fixture.test').catchAll,false);
        assert.ok(commands.some(command=>command.startsWith('HELO')));
    });
    await test('STARTTLS refusal remains UNKNOWN and never sends MAIL in clear', async()=>{
        const commands=await fixture('mx.tls.test',(command,socket)=>socket.write(command.startsWith('EHLO')?'250-Hello\r\n250 STARTTLS\r\n':'454 TLS temporarily unavailable\r\n'));
        const answer=(await probe('mx.tls.test')).get('real@fixture.test'); assert.equal(answer.valid,null);assert.equal(answer.code,454);
        assert.ok(commands.includes('STARTTLS'));assert.ok(!commands.some(command=>command.startsWith('MAIL')));
    });
    await test('batch retries unresolved recipient at alternate MX without reprocessing proven recipient', async()=>{
        const first=await fixture('mx.first.test',(command,socket)=>{
            if(command.startsWith('EHLO'))socket.write('250 OK\r\n');
            else if(command.includes('<first@'))socket.write('250 OK\r\n');
            else if(command.includes('<second@'))socket.write('450 4.1.1 Try later\r\n');
            else socket.write('550 5.1.1 No such user\r\n');
        });
        const second=await fixture('mx.second.test',(command,socket)=>{
            if(command.startsWith('EHLO'))socket.write('250 OK\r\n');
            else socket.write(command.includes('<second@')?'250 OK\r\n':'550 5.1.1 No such user\r\n');
        });
        destination('multi.test',['mx.first.test','mx.second.test']);
        const results=await verifier.verifyEmailBatchFast(['first@multi.test','second@multi.test']);
        assert.deepEqual(results.map(result=>result.status),['VALID','VALID']);
        assert.ok(!second.some(command=>command.includes('<first@')));assert.ok(first.some(command=>command.includes('<second@')));
        assert.equal(results[1].checks.policyBlocked,false);assert.equal(results[1].checks.refusalText,undefined);
    });
    await test('batch cache stops repeated host reputation refusals', async()=>{
        const commands=await fixture('mx.blocked.test',normalHandler('550 5.7.1 IP blocked using Spamhaus'));destination('blocked.test',['mx.blocked.test']);
        const results=await verifier.verifyEmailBatchFast(['real@blocked.test','other@blocked.test']);
        assert.ok(results.every(result=>result.status==='UNKNOWN'&&result.checks.policyBlocked));
        const before=commands.length; await verifier.verifyEmailBatchFast(['real@blocked.test']);
        assert.equal(commands.length,before);
        assert.match(results[0].reason,/Spamhaus/);
    });
    await test('mailbox refusal cannot poison the host cache for another valid recipient', async()=>{
        await fixture('mx.address.test',(command,socket)=>{
            if(command.startsWith('EHLO'))socket.write('250 OK\r\n');
            else if(command.includes('<good@'))socket.write('250 OK\r\n');
            else socket.write('550 5.1.1 User unknown; Spamhaus check passed\r\n');
        });destination('address.test',['mx.address.test']);
        const result=await verifier.verifyEmailBatchFast(['missing@address.test','good@address.test']);
        assert.deepEqual(result.map(answer=>answer.status),['INVALID','VALID']);
        assert.ok(!(await verifier.getBlockedHosts()).some(block=>block.host==='mx.address.test'));
    });
    await test('100 inputs keep their positions, duplicate addresses and ten-recipient cap', async()=>{
        const commands=await fixture('mx.many.test',(command,socket)=>{
            if(command.startsWith('EHLO'))socket.write('250 OK\r\n');
            else socket.write(/<lead\d+@/.test(command)?'250 OK\r\n':'550 5.1.1 No such user\r\n');
        }); destination('many.test',['mx.many.test']);
        const inputs=Array.from({length:98},(_,i)=>'lead'+i+'@many.test');inputs.splice(4,0,'broken');inputs.push(inputs[0]);
        const results=await verifier.verifyEmailBatchFast(inputs);
        assert.equal(results.length,inputs.length);assert.equal(results[4].status,'INVALID');
        for(let i=0;i<inputs.length;i++){assert.equal(results[i].email,inputs[i]);if(i!==4)assert.equal(results[i].status,'VALID');}
        const envelopeSizes=[];let count=0;
        for(const command of commands){if(command.startsWith('RCPT'))count++;if(command==='QUIT'){envelopeSizes.push(count);count=0;}}
        assert.ok(envelopeSizes.every(size=>size<=11));
        await assert.rejects(verifier.verifyEmailBatchFast(Array(101).fill('real@many.test')),/100/);
    });
    await test('SMTP identity rejects command injection', async()=>{
        await assert.rejects(probe('mx.valid.test',undefined,{helo:'x\r\nDATA'}),/Invalid SMTP/);
    });
    await test('valid dot-atom addresses are not rejected by an over-narrow syntax filter', async()=>{
        const syntax=verifier.__test.isValidSyntax;
        for(const address of ["ann.o'neill@example.test",'_contact@example.test','person+tag@example.test','a/b@example.test']) assert.equal(syntax(address),true,address);
        for(const address of ['a..b@example.test','person@-example.test','person@example-.test','person@example..test']) assert.equal(syntax(address),false,address);
    });
    await test('persistence rejects unsupported positives and negatives independently', async()=>{
        const {toPersistedVerification}=require('../src/lib/verification-persist.ts');
        const base={email:'real@fixture.test',status:'VALID',score:95,reason:'Fixture',method:'SMTP_DIRECT',
            checks:{syntax:true,mxRecord:true,smtpValid:true,catchAll:false,disposable:false,systemAddress:false,freeProvider:false}};
        assert.equal(toPersistedVerification(base).status,'VALID');
        assert.equal(toPersistedVerification({...base,checks:{...base.checks,smtpValid:null,catchAll:null}}).status,'UNKNOWN');
        assert.equal(toPersistedVerification({...base,checks:{...base.checks,catchAll:true}}).status,'RISKY');
        assert.equal(toPersistedVerification({...base,status:'INVALID',checks:{...base.checks,smtpValid:null,catchAll:null,dnsStatus:'TEMP_ERROR'}}).status,'UNKNOWN');
        assert.equal(toPersistedVerification({...base,status:'INVALID',checks:{...base.checks,smtpValid:null,catchAll:null,dnsStatus:'NO_MAIL'}}).status,'INVALID');
        assert.equal(toPersistedVerification(base).expectedEmail,base.email);
    });
    await test('CRM and export proof gate reject expired, future, oversized and incomplete evidence', async()=>{
        const {hasFreshSmtpProof,hasExpiredSmtpProof}=require('../src/lib/email-verification-proof.ts');
        const now=Date.now();
        const proof={email_status:'VALID',email_verification_method:'SMTP_DIRECT',email_verification_score:95,
            email_verified_at:new Date(now-1000).toISOString(),email_verification_expires_at:new Date(now+86400000).toISOString()};
        assert.equal(hasFreshSmtpProof(proof,now),true);
        for(const changes of [{email_verification_score:null},{email_verification_score:35},{email_verification_method:null},
            {email_verified_at:null},{email_verification_expires_at:new Date(now-1).toISOString()},
            {email_verified_at:new Date(now+3600000).toISOString()},
            {email_verification_expires_at:new Date(now+365*86400000).toISOString()}]) assert.equal(hasFreshSmtpProof({...proof,...changes},now),false);
        assert.equal(hasExpiredSmtpProof({...proof,email_verification_expires_at:new Date(now-1).toISOString()},now),true);
    });
    console.log('Email verification checks passed: '+passed+' scenarios.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    net.createConnection=realConnect;
    for(const close of fixtures) await close();
});
