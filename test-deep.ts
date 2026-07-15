// test-deep.cjs
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load .env.local
try {
  const envFile = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...values] = trimmed.split('=');
      if (key && values.length > 0) {
        process.env[key.trim()] = values.join('=').trim().replace(/^['"]|['"]$/g, '');
      }
    }
  }
} catch (e) {
  console.log("No .env.local found");
}

import { processSingleLead } from './src/app/actions/scraper-actions.ts';

async function main() {
  const url = 'https://www.linkedin.com/in/williamhgates';
  console.log('Testing processSingleLead on:', url);
  const result = await processSingleLead(url);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
