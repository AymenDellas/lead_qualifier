const fs = require('fs');
const html = fs.readFileSync('test-activity-dump.html', 'utf-8');

const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
console.log("Title:", titleMatch ? titleMatch[1] : "No title");

const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
console.log("H1:", h1Match ? h1Match[1].trim().replace(/\s+/g, ' ') : "No H1");

console.log("\nFirst 1000 chars:");
console.log(html.substring(0, 1000));

console.log("\nLast 500 chars:");
console.log(html.substring(html.length - 500));
