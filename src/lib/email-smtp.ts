import net from 'node:net';
import tls from 'node:tls';

export type RejectKind = 'MAILBOX_UNKNOWN' | 'POLICY_BLOCK' | 'TRANSIENT' | 'AMBIGUOUS';
export type SmtpResult = {
    valid: boolean | null; catchAll: boolean | null; code?: number;
    message?: string; rejectKind?: RejectKind; blocked?: boolean; text?: string;
};
export type SmtpReply = { code: number; text: string };

/** Keep partial packets and consume each complete SMTP multiline reply once. */
export class SmtpReplyReader {
    private buffer = '';
    private lines: string[] = [];
    private code?: number;
    push(chunk: Buffer | string): SmtpReply[] {
        this.buffer += chunk.toString();
        if (this.buffer.length + this.lines.join('\n').length > 65536) throw new Error('SMTP reply exceeds 64 KiB');
        const replies: SmtpReply[] = [];
        let newline: number;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, newline).replace(/\r$/, '');
            this.buffer = this.buffer.slice(newline + 1);
            const match = line.match(/^(\d{3})(?:([ -])(.*))?$/);
            if (!match) throw new Error('Malformed SMTP reply');
            const code = Number(match[1]);
            if (this.code !== undefined && this.code !== code) throw new Error('Inconsistent SMTP multiline reply');
            this.code = code;
            this.lines.push(line);
            if (!match[2] || match[2] === ' ') {
                replies.push({ code, text: this.lines.join('\r\n') });
                this.lines = [];
                this.code = undefined;
            }
        }
        return replies;
    }
}

type ProbeOptions = {
    host: string; port?: number; helo: string; mailFrom: string; emails: string[];
    control: string; timeoutMs: number;
    classify: (code: number, text: string) => RejectKind;
    reject: (code: number, text: string) => SmtpResult;
    summarize: (text: string) => string;
    noteHostBlock: (code: number, text: string) => boolean;
    onReply?: (command: string, reply: SmtpReply) => void;
};

/** Diagnostic envelope only: never sends DATA or a message. */
export function runSmtpProbe(options: ProbeOptions): Promise<Map<string, SmtpResult>> {
    const { host, helo, mailFrom, emails, control, timeoutMs } = options;
    if ([helo, mailFrom, control, ...emails].some(value => /[\r\n<>]/.test(value))) {
        return Promise.reject(new Error('Invalid SMTP identity or recipient'));
    }
    if (!emails.length) return Promise.resolve(new Map());
    return new Promise(resolve => {
        const results = new Map<string, SmtpResult>();
        let socket: net.Socket = net.createConnection({ host, port: options.port ?? 25 });
        let reader = new SmtpReplyReader();
        let state: 'BANNER' | 'EHLO' | 'HELO' | 'STARTTLS' | 'TLS' | 'MAIL' | 'RCPT' | 'CONTROL' = 'BANNER';
        let encrypted = false;
        let recipientIndex = 0;
        let command = 'CONNECT';
        let settled = false;
        const finish = (failure?: SmtpResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            for (const email of emails) {
                if (!results.has(email)) results.set(email, failure ?? { valid: null, catchAll: null, message: 'SMTP conversation ended without a recipient reply' });
                else if (failure && results.get(email)!.valid === true && results.get(email)!.catchAll === null) {
                    // Preserve acceptance while exposing the failed control test.
                    results.set(email, { ...failure, ...results.get(email), text: failure.text, message: failure.message });
                }
            }
            if (!socket.destroyed && state !== 'TLS') socket.write('QUIT\r\n');
            socket.destroy();
            resolve(results);
        };
        const transportFailure = (message: string) => finish({ valid: null, catchAll: null, message, text: message });
        // Absolute deadline prevents a tarpit from keeping the probe alive forever.
        const deadline = setTimeout(() => transportFailure(`SMTP deadline exceeded during ${state}`), timeoutMs);
        const send = (value: string) => { command = value; socket.write(value + '\r\n'); };
        const attach = (connection: net.Socket) => {
            connection.setTimeout(timeoutMs);
            connection.on('timeout', () => transportFailure(`SMTP idle timeout during ${state}`));
            connection.on('error', error => transportFailure(`SMTP transport error during ${state}: ${error.message}`));
            connection.on('close', () => transportFailure(`SMTP connection closed during ${state}`));
            connection.on('data', onData);
        };
        const earlyRefusal = (code: number, text: string) => {
            const result = options.reject(code, text);
            const reputationBlocked = options.noteHostBlock(code, text);
            // An envelope/identity refusal never establishes a mailbox verdict.
            finish({ ...result, valid: null, catchAll: null, blocked: result.blocked || reputationBlocked,
                text: `${state}: ${options.summarize(text)}` });
        };
        const onReply = ({ code, text }: SmtpReply) => {
            if (settled) return;
            options.onReply?.(command, { code, text });
            if (state === 'BANNER') {
                if (code !== 220) return earlyRefusal(code, text);
                state = 'EHLO'; send(`EHLO ${helo}`);
            } else if (state === 'EHLO' || state === 'HELO') {
                if (state === 'EHLO' && [500, 502, 504].includes(code)) {
                    state = 'HELO'; send(`HELO ${helo}`); return;
                }
                if (code !== 250) return earlyRefusal(code, text);
                if (!encrypted && state === 'EHLO' && /^250[ -]STARTTLS\b/im.test(text)) {
                    state = 'STARTTLS'; send('STARTTLS');
                } else { state = 'MAIL'; send(`MAIL FROM:<${mailFrom}>`); }
            } else if (state === 'STARTTLS') {
                if (code !== 220) return earlyRefusal(code, text);
                state = 'TLS';
                socket.removeAllListeners('data'); socket.removeAllListeners('timeout');
                socket.removeAllListeners('error'); socket.removeAllListeners('close');
                socket.setTimeout(0);
                const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true });
                socket = secure; reader = new SmtpReplyReader(); attach(secure);
                secure.once('secureConnect', () => {
                    if (settled) return;
                    encrypted = true; state = 'EHLO'; send(`EHLO ${helo}`);
                });
            } else if (state === 'MAIL') {
                if (code !== 250) return earlyRefusal(code, text);
                state = 'RCPT'; send(`RCPT TO:<${emails[recipientIndex]}>`);
            } else if (state === 'RCPT') {
                const hostBlocked = options.noteHostBlock(code, text);
                const result: SmtpResult = code === 250
                    ? { valid: true, catchAll: null, code, message: 'Direct SMTP recipient accepted' }
                    : options.reject(code, text);
                results.set(emails[recipientIndex], result);
                if (hostBlocked || code === 421) return finish(result);
                recipientIndex++;
                if (recipientIndex < emails.length) send(`RCPT TO:<${emails[recipientIndex]}>`);
                else if ([...results.values()].some(result => result.valid === true)) {
                    state = 'CONTROL'; send(`RCPT TO:<${control}>`);
                } else finish();
            } else if (state === 'CONTROL') {
                const kind = options.classify(code, text);
                options.noteHostBlock(code, text);
                const catchAll = code === 250 ? true : kind === 'MAILBOX_UNKNOWN' ? false : null;
                for (const [email, result] of results) if (result.valid === true) {
                    results.set(email, { ...result, catchAll, ...(catchAll === null ? {
                        code, text: `Control: ${options.summarize(text)}`, rejectKind: kind, blocked: kind === 'POLICY_BLOCK',
                    } : {}), message: catchAll === true ? 'Server accepted the randomized recipient'
                        : catchAll === false ? 'Direct recipient accepted; randomized recipient rejected' : 'Catch-all test inconclusive' });
                }
                finish();
            }
        };
        const onData = (chunk: Buffer) => {
            if (settled) return;
            try { for (const reply of reader.push(chunk)) onReply(reply); }
            catch (error) { transportFailure(`SMTP protocol error: ${(error as Error).message}`); }
        };
        attach(socket);
    });
}
