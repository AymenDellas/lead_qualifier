import { verifyEmailBatch } from './src/app/actions/email-verifier-actions';

const emails = [
  'david@davidpaul.com',
  'tos@substackinc.com',
  'derrick@coachderrick.com',
  'hello@dianacoaching.com',
  'dianazuluaga@dianazuluaga.co',
  'diane@dianedreizencoach.com',
  'diane@diane-robertson.com',
  'diane.wilkinson@connectingtoexcellence.com',
  'donna@syzygycoaching.com',
  'elise.r.edwards@gmail.com',
  'elivationenterprises@gmail.com',
  'ellie@ellierichpoole.com'
];

async function runTest() {
  console.log('Testing SMTP Verification...');
  const res = await verifyEmailBatch(emails);
  res.forEach(r => {
    let smtpMark = 'SMTP ?';
    if (r.checks.smtpValid === true) smtpMark = 'SMTP ✓';
    else if (r.checks.smtpValid === false) smtpMark = 'SMTP ✗';
    console.log(r.email.padEnd(45), ' | ', r.status.padEnd(8), ' | ', smtpMark, ' | ', r.reason);
  });
}

runTest().catch(console.error);
