const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const mod = { exports: {} };
new Function('module', 'exports', ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '../src/lib/discovery-name.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText)(mod, mod.exports);
const { extractDiscoveryName } = mod.exports;

for (const [title, firstName, lastName] of [
    ['Kathy Sacks - Executive Coach to High-Performers', 'Kathy', 'Sacks'],
    ['Coach Joe Noonan – Business Coach | LinkedIn', 'Joe', 'Noonan'],
    ['"Coach" DENNIS MCGOUGH - Business Coach', 'DENNIS', 'MCGOUGH'],
    ['Dr. Kyle Elliott, MPA, CHES - Career Coach', 'Kyle', 'Elliott'],
    ['Jean-Luc O’Neill — Executive Coach', 'Jean-Luc', 'O’Neill'],
    ['Maëlle Fonteneau, PCC - Career Coach', 'Maëlle', 'Fonteneau'],
    ['Karen Woodin-Rodríguez, UX Career Coach - Coach', 'Karen', 'Woodin-Rodríguez'],
    ['Peggy Ratcliff McKee ♦ Career Coach ♦ Interview Coach', 'Peggy', 'Ratcliff McKee'],
    ['Christine de Largy PhD - Business Coach', 'Christine', 'de Largy'],
    ['Jas Kalra (She/Elle) M.Sc, PCC - Coach', 'Jas', 'Kalra'],
    ['Jennifer G. E. Lewis ACC, CPCC - Coach', 'Jennifer', 'G. E. Lewis'],
    ['Dany Trudel MBA l CRHA l ACC Coach - Business Coach', 'Dany', 'Trudel'],
    ['Anne Wilkinson Coach - Coaching', 'Anne', 'Wilkinson'],
    ['John Ma - Career Coach', 'John', 'Ma'],
    ['Lily - Business Coach', 'Lily', ''],
    ['  Ana&#239;s O&apos;Brien &nbsp; - Coach | LinkedIn ', 'Anaïs', "O'Brien"],
    ['✶Linda Hannett✶ - Life/Career Coach and Strategist', 'Linda', 'Hannett'],
    ['Dominique Pirolo- IBM Hiring SAP Canada Practice Mentor ...', 'Dominique', 'Pirolo'],
    ['Andy Nelson 🌱 - The Positive Career Coach', 'Andy', 'Nelson'],
    ['Jedidiah "Jedi" Alex Koh, MCC, ACTC, BYS - LinkedIn', 'Jedidiah', 'Alex Koh'],
    ['Makenzie Chilton ☕️ Career Coach - Director of Coaching', 'Makenzie', 'Chilton'],
    ['\u200fAmir Bidavisi\u200f - | Creator of MCCF', 'Amir', 'Bidavisi'],
    ['Tracie Daly. Food Business Coach', 'Tracie', 'Daly'],
    ['Michele Brant Executive Career Coach - ICF CPC', 'Michele', 'Brant'],
    ['Iris Kloth (ICF PCC, WABC) | Wingwave®& Emotions Coach | LinkedIn', 'Iris', 'Kloth'],
    ['Teri Cox-Meadows ED. D - Executive Coach', 'Teri', 'Cox-Meadows'],
    ['Paul Bowman M.Div. - Career Coach & Educator', 'Paul', 'Bowman'],
]) assert.deepEqual(extractDiscoveryName(title), { firstName, lastName }, title);

for (const title of ['', 'Unknown', 'Business Coach - LinkedIn', 'Coacial Career Coaching and Personal Branding - Coaching',
    '63 Career Coach profiles | LinkedIn', 'Person ... - Coach', 'https://linkedin.com/in/coach',
    'Your professional career coach for 🇨🇦 Engineering & IT jobs', 'Coach - LinkedIn']) {
    assert.deepEqual(extractDiscoveryName(title), { firstName: '', lastName: '' }, title);
}
console.log('Discovery names: 36 fixtures passed.');
