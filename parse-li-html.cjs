const fs = require('fs');

const html = fs.readFileSync('test-activity-dump.html', 'utf-8');

// The posts are usually inside <code> tags that have id="bpr-guid-..." or similar.
const codeRegex = /<code[^>]*>([\s\S]*?)<\/code>/gi;
let match;
let count = 0;
while ((match = codeRegex.exec(html)) !== null) {
    let block = match[1];
    // Decoded entities if needed
    block = block.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

    // Look for anything resembling a date or post
    if (block.includes('urn:li:activity:') || block.includes('urn:li:share:') || block.includes('actor') || block.includes('time')) {
        // Let's print out snippets
        const snippets = [];
        const pattern = /"([^"]*(?:time|date|At|Time|Date)[^"]*)"\s*:\s*([^,}]+)/g;
        let pMatch;
        while ((pMatch = pattern.exec(block)) !== null) {
            snippets.push(`${pMatch[1]}: ${pMatch[2]}`);
        }
        if (snippets.length > 0) {
            console.log(`--- Block ${count} ---`);
            console.log(snippets.slice(0, 50).join('\n'));
            count++;
        }
    }
}
console.log(`Total blocks evaluated: ${count}`);

// Check for "no activity" signals
const lowerHtml = html.toLowerCase();
console.log("hasn't posted yet:", lowerHtml.includes("hasn't posted yet"));
console.log("hasn&#39;t posted yet:", lowerHtml.includes("hasn&#39;t posted"));
console.log("no activity:", lowerHtml.includes("no activity"));

// Look for what text is actually visible to users
const visibleText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 5000);
// console.log("Visible text sample:", visibleText);

// Look for time tags
const timeRegex = /<time[^>]*>([^<]*)<\/time>/g;
let tMatch;
let tCount = 0;
while ((tMatch = timeRegex.exec(html)) !== null) {
    console.log(`TIME TAG: match="${tMatch[0]}" text="${tMatch[1]}"`);
    tCount++;
}
console.log(`Total time tags: ${tCount}`);

// Look for span visibly showing relative time
const spanTimeRegex = /<span [^>]*visually-hidden[^>]*>([^<]*(?:mo|yr|d|w|h|m))<\/span>/gi;
let sMatch;
while ((sMatch = spanTimeRegex.exec(html)) !== null) {
    console.log(`VISUALLY HIDDEN TIME TEXT: ${sMatch[1]}`);
}
