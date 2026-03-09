const fs = require('fs');
const html = fs.readFileSync('test-activity-dump.html', 'utf-8');

// Look for any <code> tag containing "activity" or "update" or "share"
const codeRegex = /<code[^>]*>([\s\S]*?)<\/code>/gi;
let match;
while ((match = codeRegex.exec(html)) !== null) {
    let block = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');

    // Check if the block has feed data
    if (block.includes('urn:li:activity:') || block.includes('urn:li:share:') || block.includes('timeline')) {
        console.log("---- FOUND POTENTIAL FEED BLOCK ----");
        console.log("Length:", block.length);
        console.log("Sample:", block.substring(0, 1000));

        // Try parsing epoch dates
        const epochRegex = /"(?:createdAt|postedAt|publishedAt|time|date|lastModifiedAt)"\s*:\s*(\d{13})/g;
        let eMatch;
        let foundDates = 0;
        while ((eMatch = epochRegex.exec(block)) !== null) {
            console.log("Found date:", new Date(parseInt(eMatch[1])).toISOString());
            foundDates++;
        }
        console.log("Total dates in this block:", foundDates);
    }
}
