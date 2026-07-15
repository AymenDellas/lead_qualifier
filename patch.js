const fs = require('fs');
let code = fs.readFileSync('worker.cjs', 'utf8');

code = code.replace(
    /await page\.waitForSelector\('#username', \{ timeout: 15000 \}\);[\s\S]*?catch \(e\) \{/,
    `await page.waitForSelector('#username, #session_key', { timeout: 15000 });
            const usernameInput = await page.$('#username') ? '#username' : '#session_key';
            const passwordInput = await page.$('#password') ? '#password' : '#session_password';
            
            await page.type(usernameInput, accounts[0].email, { delay: 120 });
            await sleep(800);
            await page.type(passwordInput, accounts[0].password, { delay: 120 });
            await sleep(800);
            await page.click('button[type="submit"]');
            await sleep(5000);
        } catch (e) {`
);

code = code.replace(
    /log\(\`\?\? Login form not found: \$\{e\.message\}\`\);/,
    `log(\`?? Login form not found: \${e.message}\`);
            try { await page.screenshot({ path: '/app/progress/login-error.png' }); } catch(err) {}`
);

fs.writeFileSync('worker.cjs', code);
console.log("Patched worker.cjs");
