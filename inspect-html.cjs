const fs = require('fs');
const html = fs.readFileSync('coach-jenn.html', 'utf-8');

// Find all URNs
const urns = [...new Set([...html.matchAll(/urn:li:fsd_profile:(ACoA[a-zA-Z0-9_-]+)/g)].map(m => m[1]))];
console.log('All unique URNs length:', urns.length);

console.log('\nFrequencies:');
for (const u of urns) {
    const count = html.split(u).length - 1;
    console.log(u, 'appears', count, 'times');
}

// Let's find where her public identifier is mapped to a URN
console.log('\nSearching for mapping to coach-jenn-james...');
const codeRegex = /<code[^>]*>([\s\S]*?)<\/code>/gi;
let match;
while ((match = codeRegex.exec(html)) !== null) {
    if (match[1].includes('coach-jenn-james')) {
        try {
            // Unescape HTML entities
            const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
            if (decoded.includes('urn:li:fsd_profile:')) {
                // Find all URNs in this block
                const blockUrns = [...new Set([...decoded.matchAll(/urn:li:fsd_profile:(ACoA[a-zA-Z0-9_-]+)/g)].map(m => m[1]))];
                console.log('Block mapping found these URNs:', blockUrns);
            }
        } catch (e) { }
    }
}
