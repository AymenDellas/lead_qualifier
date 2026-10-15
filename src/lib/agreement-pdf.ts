import { CASE_STUDY_CONSENT_TEXT, type OnboardingData } from './business';

// Browser-compatible PDF rendering keeps preview and download identical.
const plain = (value: string) => String(value || '')
    .replace(/[–—−]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
    .replace(/•/g, '-').replace(/…/g, '...').replace(/[^\x20-\x7E\n]/g, '');
const escaped = (value: string) => plain(value).replace(/([\\()])/g, '\\$1');
const ink = '0.08 0.09 0.10';
const muted = '0.36 0.39 0.40';
const rule = '0.84 0.86 0.85';
const accent = '0.70 0.83 0.16';
const paper = '0.985 0.984 0.974';
const pageWidth = 595;
const pageHeight = 842;
const left = 56;
const right = pageWidth - left;
const bottom = 68;

function wrapped(value: string, maxChars = 90): string[] {
    const lines: string[] = [];
    for (const paragraph of plain(value).split('\n')) {
        if (!paragraph.trim()) { lines.push(''); continue; }
        let line = '';
        for (const token of paragraph.trim().split(/\s+/)) {
            const pieces = token.match(new RegExp(`.{1,${maxChars}}`, 'g')) || [token];
            for (const word of pieces) {
                if (line && `${line} ${word}`.length > maxChars) { lines.push(line); line = word; }
                else line = line ? `${line} ${word}` : word;
            }
        }
        lines.push(line);
    }
    return lines;
}
function textAt(value: string, x: number, y: number, size: number, color = ink, bold = false) {
    return `BT /${bold ? 'Bold' : 'Regular'} ${size} Tf ${color} rg 1 0 0 1 ${x} ${y} Tm (${escaped(value)}) Tj ET\n`;
}
function rect(x: number, y: number, width: number, height: number, fill: string) {
    return `${fill} rg ${x} ${y} ${width} ${height} re f\n`;
}
function line(x1: number, y1: number, x2: number, y2: number, color = rule, width = 0.8) {
    return `${color} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S\n`;
}
function formatAmount(data: OnboardingData) {
    if (data.payment.price === null) return 'Fee to be confirmed';
    try {
        return new Intl.NumberFormat('en-US', { style: 'currency', currency: data.payment.currency || 'USD', maximumFractionDigits: 2 }).format(data.payment.price);
    } catch { return `${data.payment.currency || 'USD'} ${data.payment.price.toLocaleString('en-US')}`; }
}

export function agreementPdf(data: OnboardingData): Blob {
    const streams: string[] = [];
    let stream = '';
    let y = 0;
    const startPage = () => {
        stream = rect(0, 0, pageWidth, pageHeight, paper);
        stream += rect(0, pageHeight - 12, pageWidth, 12, ink);
        stream += rect(left, pageHeight - 69, 25, 3, accent);
        stream += textAt('COMPEL', left, pageHeight - 56, 11, ink, true);
        stream += textAt('PROJECT AGREEMENT', right - 118, pageHeight - 56, 8, muted, true);
        stream += line(left, pageHeight - 80, right, pageHeight - 80);
        y = pageHeight - 108;
    };
    const finishPage = () => { if (stream) streams.push(stream); };
    const ensure = (height: number) => {
        if (y - height < bottom) { finishPage(); startPage(); }
    };
    const section = (number: number, heading: string, body: string) => {
        const lines = wrapped(body || 'To be confirmed.');
        const sectionHeight = 31 + lines.reduce((total, value) => total + (value ? 15 : 9), 0) + 36;
        // Keep ordinary sections intact. Very long edited clauses can still flow to the next page.
        ensure(sectionHeight <= pageHeight - 108 - bottom ? sectionHeight : 73);
        stream += rect(left, y - 3, 20, 18, ink);
        stream += textAt(String(number).padStart(2, '0'), left + 4, y + 2, 8, paper, true);
        stream += textAt(heading.toUpperCase(), left + 32, y + 1, 9, ink, true);
        y -= 31;
        for (const value of lines) {
            ensure(17);
            if (value) stream += textAt(value, left + 32, y, 9.4, muted);
            y -= value ? 15 : 9;
        }
        y -= 15;
        ensure(1);
        stream += line(left + 32, y, right, y, rule, 0.5);
        y -= 20;
    };

    startPage();
    stream += textAt('Agreement for', left, y, 9, muted);
    y -= 30;
    for (const name of wrapped(data.projectName || 'Untitled project', 36).slice(0, 2)) {
        stream += textAt(name, left, y, 22, ink, true);
        y -= 28;
    }
    stream += textAt(data.projectType === 'CASE_STUDY' ? 'FREE CASE STUDY' : 'PAID CLIENT', left, y - 3, 9, muted, true);
    y -= 30;
    ensure(93);
    stream += rect(left, y - 73, right - left, 73, '0.94 0.95 0.93');
    stream += rect(left, y - 73, 3, 73, accent);
    stream += textAt('CLIENT', left + 17, y - 18, 7.5, muted, true);
    stream += textAt('ENGAGEMENT', left + 257, y - 18, 7.5, muted, true);
    stream += textAt(wrapped(data.clientName || 'Client to be confirmed', 35)[0], left + 17, y - 36, 10, ink, true);
    stream += textAt(data.projectType === 'CASE_STUDY' ? 'No project fee' : formatAmount(data), left + 257, y - 36, 10, ink, true);
    stream += textAt(wrapped(data.businessName || data.website || '', 40)[0] || '', left + 17, y - 55, 8.5, muted);
    stream += textAt('Provider: Compel', left + 257, y - 55, 8.5, muted);
    y -= 105;

    const a = data.agreement;
    let number = 1;
    section(number++, 'Agreement', a.intro);
    section(number++, 'Project scope', a.scope);
    section(number++, 'Deliverables', data.scope.included || a.deliverables);
    if (data.scope.excluded.trim()) section(number++, 'Not included', data.scope.excluded);
    section(number++, 'Before work starts', data.scope.dependencies);
    section(number++, 'Timeline', a.timeline);
    if (data.projectType === 'PAID') {
        section(number++, 'Payment terms', [
            `Project fee: ${formatAmount(data)}.`,
            `Payment structure: ${data.payment.structure === 'DEPOSIT' ? 'Deposit plus balance' : data.payment.structure === 'FULL' ? 'Full payment' : 'Custom'}.`,
            data.payment.deposit !== null ? `Deposit: ${data.payment.currency} ${data.payment.deposit}.` : '',
            data.payment.balance !== null ? `Remaining balance: ${data.payment.currency} ${data.payment.balance}.` : '',
            data.payment.dueDate ? `Due date: ${data.payment.dueDate}.` : '',
            data.payment.notes,
        ].filter(Boolean).join('\n'));
        section(number++, 'Revisions', a.revisions);
    }
    section(number++, 'Client responsibilities', a.clientResponsibilities);
    section(number++, 'Compel responsibilities', a.compelResponsibilities);
    section(number++, 'Ownership', a.ownership);
    section(number++, 'Portfolio and case study rights', a.caseStudyRights);
    if (data.projectType === 'CASE_STUDY') {
        section(number++, 'Case study permission', CASE_STUDY_CONSENT_TEXT);
    }
    section(number++, 'Confidentiality', a.confidentiality);
    section(number++, 'Cancellation and termination', a.termination);

    ensure(133);
    stream += textAt('SIGNATURES', left, y, 10, ink, true);
    y -= 24;
    stream += textAt('By signing, both parties agree to the terms above.', left, y, 9, muted);
    y -= 49;
    stream += line(left, y, left + 205, y, ink);
    stream += line(left + 273, y, right, y, ink);
    y -= 16;
    stream += textAt('CLIENT SIGNATURE', left, y, 7.5, muted, true);
    stream += textAt('COMPEL SIGNATURE', left + 273, y, 7.5, muted, true);
    y -= 34;
    stream += line(left, y, left + 205, y);
    stream += line(left + 273, y, right, y);
    y -= 16;
    stream += textAt('DATE', left, y, 7.5, muted, true);
    stream += textAt('DATE', left + 273, y, 7.5, muted, true);
    finishPage();

    const pages = streams.map((content, index) => content
        + line(left, 49, right, 49)
        + textAt('COMPEL  /  CLIENT AGREEMENT', left, 34, 7.5, muted, true)
        + textAt(`${index + 1} / ${streams.length}`, right - 24, 34, 7.5, muted, true));
    const objects: string[] = [];
    const add = (content: string) => { objects.push(content); return objects.length; };
    const catalogId = add('');
    const pagesId = add('');
    const regularId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const boldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
    const pageIds: number[] = [];
    for (const content of pages) {
        const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
        pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /Regular ${regularId} 0 R /Bold ${boldId} 0 R >> >> /Contents ${contentId} 0 R >>`));
    }
    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    let output = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => { offsets.push(output.length); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = output.length;
    output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let index = 1; index <= objects.length; index++) output += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
    output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return new Blob([output], { type: 'application/pdf' });
}
