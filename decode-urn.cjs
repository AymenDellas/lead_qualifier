// Decode LinkedIn Activity URN to Timestamp
// LinkedIn uses a variation of Twitter Snowflake IDs for activities.
// The first 41 bits represent the timestamp in milliseconds since their custom epoch.

function decodeUrnDate(urnString) {
    const match = urnString.match(/urn:li:activity:(\d+)/);
    if (!match) return null;

    // Convert string ID to BigInt to avoid precision loss
    const id = BigInt(match[1]);

    // Shift right by 22 bits
    const binaryPrefix = id >> 22n;

    // LinkedIn's custom epoch is theoretically ~2009. But actually, 
    // we don't even need the epoch if we just look at the raw binary prefix?
    // Let's test standard Twitter epoch or LinkedIn epoch.
    // Let's just output the binary prefix to see.
    return Number(binaryPrefix);
}

const fs = require('fs');
const data = JSON.parse(fs.readFileSync('test-voyager-axios-success.json'));

const urns = data.data['*elements'] || [];
console.log(`Found ${urns.length} activity URNs`);

for (const urn of urns) {
    const shifted = decodeUrnDate(urn);
    if (shifted) {
        // LinkedIn Epoch is seemingly 0 or doesn't need addition for some new IDs?
        // Wait, standard Unix epoch 1773064605841 is currently March 2026.
        // Let's print the shifted value.
        console.log(`URN: ${urn}`);
        console.log(`Shifted Bits (Base 10): ${shifted}`);
        // Can it just be the unix timestamp directly?
        console.log(`Date if direct TS: ${new Date(shifted).toISOString()}`);
    }
}
