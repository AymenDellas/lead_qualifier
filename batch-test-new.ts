import { processSingleLead } from './src/app/actions/scraper-actions';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

async function testMultiple() {
    const urls = [
        'https://www.linkedin.com/in/-kylie-watson-/',
        'https://www.linkedin.com/in/3gt/',
        'https://www.linkedin.com/in/abalmer/'
    ];

    console.log(`Starting test for ${urls.length} URLs with refreshed cookies...`);
    
    for (const url of urls) {
        console.log(`\n--- Testing: ${url} ---`);
        try {
            const result = await processSingleLead(url, 'test_batch_' + Date.now());
            console.log('Result Status:', result.status);
            console.log('First Name:', result.firstName);
            console.log('Emails:', result.emails);
            console.log('Websites:', result.websites);
            console.log('Logs (last 5 lines):', result.logs?.slice(-5));
        } catch (e) {
            console.error('Processing failed:', e);
        }
    }
}

testMultiple();
