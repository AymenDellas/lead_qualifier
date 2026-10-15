#!/usr/bin/env node
/**
 * Compares the environment files against each other and against the examples.
 *
 * Two runtimes read two different files: `next dev`/`next start` load `.env.local`,
 * while Compose hands the containers `.env.docker` plus the optional ignored
 * `.env.docker.local` overlay. Nothing connects them automatically, so
 * a key added to one silently never reaches the other — and the failure surfaces
 * far from the cause. GMAIL_ACCOUNTS was configured in `.env.local` and the Sync
 * Gmail button reported "no accounts configured" from inside the container;
 * EMAIL_VERIFY_HELO was set locally, so the container fell back to a domain the
 * deployment doesn't own and recipient servers refused every probe on policy
 * grounds — which is indistinguishable from "the address is dead" unless you know
 * to look.
 *
 * Values are never printed: this reports key names only.
 *
 *   npm run check-env
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Keys whose absence only disables an optional feature. */
const OPTIONAL = new Set([
    'GOOGLE_SHEETS_CREDENTIALS_BASE64',
    'GOOGLE_SHEETS_SPREADSHEET_ID',
]);
const ALLOW_EMPTY = new Set(['AGENTROUTER_FALLBACK_MODELS']);

/** Keys the Dockerfile sets as ENV, so they need not appear in .env.docker. */
const SET_BY_DOCKERFILE = new Set([
    'PUPPETEER_SKIP_CHROMIUM_DOWNLOAD',
    'PUPPETEER_EXECUTABLE_PATH',
]);

/** Reads key names (and whether each has a non-empty value). Values are discarded. */
function readKeys(file) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) return null;
    const keys = new Map();
    for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
        // Commented lines count for *.example files (they document the key) but
        // not for real env files, where a commented key is simply not set.
        const match = line.match(/^\s*(#\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
        if (!match) continue;
        const [, commented, key, rawValue] = match;
        const isExample = file.endsWith('.example');
        if (commented && !isExample) continue;
        const value = rawValue.trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
        if (!keys.has(key) || value) keys.set(key, Boolean(value));
    }
    return keys;
}

const local = readKeys('.env.local');
const dockerBase = readKeys('.env.docker');
const dockerLocal = readKeys('.env.docker.local');
const docker = dockerBase || dockerLocal
    ? new Map([...(dockerBase || []), ...(dockerLocal || [])])
    : null;
const dockerExample = readKeys('.env.docker.example');

const problems = [];
const notes = [];

if (!local) notes.push('.env.local is missing — `next dev` will have no configuration.');
if (!dockerBase) notes.push('.env.docker is missing — the containers will start with no base configuration.');

// The drift that actually bites: configured locally, invisible in the container.
if (local && docker) {
    const drift = [...local.keys()].filter(k =>
        !docker.has(k) && !SET_BY_DOCKERFILE.has(k) && !OPTIONAL.has(k));
    if (drift.length) {
        problems.push(
            `Set in .env.local but NOT in the Docker env files — the containers cannot see these:\n` +
            drift.map(k => `    ${k}`).join('\n')
        );
    }

    const reverse = [...docker.keys()].filter(k =>
        !local.has(k) && !SET_BY_DOCKERFILE.has(k) && !OPTIONAL.has(k));
    if (reverse.length) {
        notes.push(
            `Set in the Docker env files but not .env.local — these work in Docker only:\n` +
            reverse.map(k => `    ${k}`).join('\n')
        );
    }
}

// Keys present but empty are a common silent failure: the code sees "" and uses a default.
for (const [file, keys] of [['.env.local', local], ['Docker env files', docker]]) {
    if (!keys) continue;
    const empty = [...keys.entries()].filter(([key, hasValue]) => !hasValue && !ALLOW_EMPTY.has(key)).map(([k]) => k);
    if (empty.length) problems.push(`Present but empty in ${file}:\n` + empty.map(k => `    ${k}`).join('\n'));
}

// Documented but never configured anywhere.
if (dockerExample && docker) {
    const undocumented = [...dockerExample.keys()].filter(k =>
        !docker.has(k) && !SET_BY_DOCKERFILE.has(k) && !OPTIONAL.has(k) && !(local && local.has(k)));
    if (undocumented.length) {
        notes.push(
            `In .env.docker.example but configured nowhere (code defaults apply):\n` +
            undocumented.map(k => `    ${k}`).join('\n')
        );
    }
}

for (const note of notes) console.log(`note:  ${note}`);
if (notes.length && problems.length) console.log('');
for (const problem of problems) console.log(`ISSUE: ${problem}`);

if (!problems.length) {
    console.log('Environment files agree. No drift between .env.local and the Docker env files.');
    process.exit(0);
}
console.log('\nAfter editing .env.docker: docker compose up -d --force-recreate');
process.exit(1);
