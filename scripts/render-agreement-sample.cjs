const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function loadTypeScript(relativePath, dependencies = {}) {
    const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const module = { exports: {} };
    new Function('module', 'exports', 'require', compiled)(
        module,
        module.exports,
        (id) => dependencies[id] || require(id),
    );
    return module.exports;
}

const business = loadTypeScript('src/lib/business.ts');
const { agreementPdf } = loadTypeScript('src/lib/agreement-pdf.ts', { './business': business });
const opportunity = {
    ...business.blankOpportunity(),
    name: 'Alex Morgan',
    email: 'alex@example.com',
    website: 'https://example.com',
    stage: 'WON',
    funnel: 'DIRECT_TO_CALL',
    mode: 'CASE_STUDY',
    audience: 'Executive coaches',
    currentOffer: 'Executive coaching program',
};
const project = business.buildProject(opportunity, business.DEFAULT_OFFER);
const data = project.onboarding;
const paid = process.argv.includes('--paid');
if (paid) {
    data.projectType = 'PAID';
    data.payment.price = 3500;
    data.payment.currency = 'USD';
    data.payment.structure = 'DEPOSIT';
    data.payment.deposit = 1750;
    data.payment.balance = 1750;
    data.payment.dueDate = '2026-10-15';
    data.agreement.intro = business.DEFAULT_ONBOARDING_TEMPLATES.paidAgreement;
    data.agreement.ownership = 'Once agreed payment is complete, the client owns the final approved deliverables created specifically for them. Compel retains its internal systems, templates, reusable frameworks, tools and processes.';
    data.agreement.caseStudyRights = 'Portfolio and case-study use requires separate written permission from the client.';
    data.agreement.revisions = 'Revision rounds follow the confirmed project scope. Work outside that scope requires separate approval.';
}
data.projectName = 'Executive Coaching Funnel';
data.businessName = 'Morgan Coaching';
data.agreement.scope = 'Rebuild the primary landing page, qualification step and booking path around one executive coaching offer.';
data.agreement.timeline = 'Approximately four weeks after the agreement, assets and required access are complete.';
data.form.caseStudyConsent = true;

const destination = paid
    ? path.join(__dirname, '..', 'tmp', 'pdfs', 'compel-paid-agreement-qa.pdf')
    : path.join(__dirname, '..', 'output', 'pdf', 'compel-agreement-sample.pdf');
fs.mkdirSync(path.dirname(destination), { recursive: true });
agreementPdf(data).arrayBuffer().then((bytes) => {
    fs.writeFileSync(destination, Buffer.from(bytes));
    console.log(destination);
});
