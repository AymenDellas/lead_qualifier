const fs = require('fs');

const html = fs.readFileSync('test-profile-dump.html', 'utf-8');

// Look for urn:li:member:\d+
const memberMatch = html.match(/urn:li:member:(\d+)/);
if (memberMatch) {
    console.log("Found Member ID:", memberMatch[1]);
} else {
    console.log("No member ID found.");
}

// Look for anything related to the profile ID
const publicIdMatch = html.match(/"publicIdentifier"\s*:\s*"([^"]+)"/);
if (publicIdMatch) console.log("Public ID:", publicIdMatch[1]);
