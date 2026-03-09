const fs = require('fs');
const data = JSON.parse(fs.readFileSync('test-voyager-axios-success.json'));
const found = new Set();
function walk(obj, path) {
    if (!obj) return;
    if (typeof obj === 'object') {
        for (let k in obj) {
            if (typeof obj[k] === 'number' && String(obj[k]).length === 13) {
                found.add(`${k}: ${new Date(obj[k]).toISOString()} (at ${path}.${k})`);
            }
            walk(obj[k], path + '.' + k);
        }
    }
}
walk(data, 'root');
console.log(Array.from(found).slice(0, 30).join('\n'));
