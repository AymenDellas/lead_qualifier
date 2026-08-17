const fs = require('fs');
const dbPath = '/app/data/leads_db.json';
let leads = [];
try {
    const data = fs.readFileSync(dbPath, 'utf8');
    leads = JSON.parse(data);
} catch(e) {}

leads.push({
    id: 'test_uk_1',
    linkedin_url: 'https://www.linkedin.com/in/test-uk-1',
    first_name: 'John',
    last_name: 'UK',
    company: 'UK Tech',
    location: 'UK',
    pipeline_status: 'INBOX',
    email: '',
    email_status: 'UNVERIFIED',
    hook: '',
    contacted: false,
    created_at: new Date().toISOString()
});

leads.push({
    id: 'test_uk_2',
    linkedin_url: 'https://www.linkedin.com/in/test-uk-2',
    first_name: 'Jane',
    last_name: 'UK',
    company: 'UK Startups',
    location: 'uk',
    pipeline_status: 'INBOX',
    email: '',
    email_status: 'UNVERIFIED',
    hook: '',
    contacted: false,
    created_at: new Date().toISOString()
});

fs.writeFileSync(dbPath, JSON.stringify(leads, null, 2));
console.log('Injected 2 UK leads successfully.');
