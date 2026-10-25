'use strict';

const path = require('node:path');
const profileOwners = new Map();

function browserError(code, message) {
    return Object.assign(new Error(message), { code });
}

function bounded(task, milliseconds) {
    let timer;
    return Promise.race([
        Promise.resolve().then(task).then(() => true, () => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); }),
    ]).finally(() => clearTimeout(timer));
}

function exited(child) {
    return child && (child.exitCode != null || child.signalCode != null);
}

function waitForExit(child, milliseconds) {
    if (exited(child)) return Promise.resolve(true);
    return new Promise(resolve => {
        let timer;
        const done = () => {
            clearTimeout(timer);
            child.removeListener('exit', done);
            resolve(exited(child));
        };
        child.once('exit', done);
        timer = setTimeout(done, milliseconds);
    });
}

// Existing profiles always retain their original cookie directory. A different
// root is an opt-in location for new profiles, never an implicit migration.
function profilePath(root, account, fs, profileRoot) {
    if (typeof root !== 'string' || !root || !/^[a-z0-9_-]+$/i.test(account?.profile_key || '')) {
        throw browserError('BROWSER_PROFILE_INVALID', 'A workspace root and valid account profile key are required.');
    }
    const legacy = path.resolve(root, '.browser-profiles', account.profile_key);
    return !profileRoot || fs.existsSync(legacy) ? legacy : path.resolve(profileRoot, account.profile_key);
}

/**
 * Owns one visible saved account browser. Opening is always explicit; navigation,
 * authentication and processing decisions belong to the account runtime.
 * The runtime owns its cross-process lease/PID lock; Chrome retains its own
 * profile lock. This map additionally prevents competing owners in one process.
 */
function createAccountBrowser({ root, account, onDisconnect, puppeteer, fs = require('node:fs'), profileRoot, closeTimeoutMs = 2000 }) {
    if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs < 1) throw new TypeError('closeTimeoutMs must be positive.');
    const directory = profilePath(root, account, fs, profileRoot);
    const profileKey = process.platform === 'win32' ? directory.toLowerCase() : directory;
    let entry = null, opening = null, closing = null, windowTask = Promise.resolve();

    function release(value) {
        if (profileOwners.get(profileKey) === value) profileOwners.delete(profileKey);
        if (entry === value) entry = null;
    }

    function isOpen() {
        return Boolean(entry?.surface && !entry.closing && !entry.disconnected &&
            entry.browser.isConnected() && !entry.surface.page.isClosed());
    }

    async function dispose(value) {
        value.closing = true;
        if (value.disposal) return value.disposal;
        if (!value.browser) return;
        value.disposal = (async () => {
            await bounded(() => value.browser.close(), closeTimeoutMs);
            const child = value.child;
            if (child && !exited(child)) {
                // Use only the ChildProcess returned by this launch. Never kill
                // by executable name, scan other PIDs, or remove Chrome locks.
                try { child.kill('SIGKILL'); } catch { /* Verify exit below. */ }
                if (!await waitForExit(child, closeTimeoutMs)) {
                    throw browserError('BROWSER_CLOSE_FAILED', 'The owned Chrome process did not exit; close its window before reopening.');
                }
            } else if (!child && value.browser.isConnected()) {
                throw browserError('BROWSER_CLOSE_FAILED', 'Chrome did not close and no owned process is available.');
            }
            value.browser.off('disconnected', value.onDisconnected);
            release(value);
        })();
        try { await value.disposal; } catch (error) { value.disposal = null; throw error; }
    }

    async function preparePage(value, acceptPages) {
        // Avoid initializing every restored page's session. Only about:blank is
        // created here; account URLs are opened by the caller after open().
        const session = await value.browser.target().createCDPSession();
        try {
            const { targetInfos } = await session.send('Target.getTargets');
            const keeper = await session.send('Target.createTarget', { url: 'about:blank' });
            for (const target of targetInfos.filter(target => target.type === 'page')) {
                const result = await session.send('Target.closeTarget', { targetId: target.targetId });
                if (!result.success) throw browserError('BROWSER_TAB_CLOSE_FAILED', 'Could not close a restored browser tab.');
            }
            if (value.closing) throw browserError('BROWSER_OPEN_CANCELLED', 'Browser opening was cancelled.');
            acceptPages();
            const page = await value.browser.newPage();
            const result = await session.send('Target.closeTarget', { targetId: keeper.targetId });
            if (!result.success) throw browserError('BROWSER_TAB_CLOSE_FAILED', 'Could not close the temporary browser tab.');
            return page;
        } finally {
            await bounded(() => session.detach(), closeTimeoutMs);
        }
    }

    function open() {
        if (closing) return Promise.reject(browserError('BROWSER_CLOSING', 'The account browser is closing.'));
        if (opening) return opening;
        if (isOpen()) return Promise.resolve(entry.surface);
        if (entry) return Promise.reject(browserError('BROWSER_DISCONNECTED', 'The account browser was disconnected or its page closed. Close it before explicitly reopening.'));
        if (profileOwners.has(profileKey)) return Promise.reject(browserError('BROWSER_PROFILE_IN_USE', 'This account profile already has a browser owner.'));

        const value = { browser: null, child: null, surface: null, closing: false, disconnected: false };
        entry = value;
        profileOwners.set(profileKey, value);
        opening = (async () => {
            try {
                fs.mkdirSync(directory, { recursive: true });
                const driver = puppeteer || require('puppeteer');
                const executablePath = driver.configuration?.executablePath || driver.default?.configuration?.executablePath;
                let pagesAllowed = false;
                value.controller = new AbortController();
                value.browser = await driver.launch({
                    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
                    headless: false,
                    userDataDir: directory,
                    defaultViewport: null,
                    timeout: 30000,
                    protocolTimeout: 30000,
                    waitForInitialPage: false,
                    targetFilter: target => target.type() !== 'page' || pagesAllowed,
                    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
                    signal: value.controller.signal,
                    args: ['--window-size=1366,768'],
                });
                value.child = value.browser.process();
                value.onDisconnected = () => {
                    if (value.closing || value.disconnected) return;
                    value.disconnected = true;
                    try {
                        Promise.resolve(onDisconnect?.(browserError('BROWSER_DISCONNECTED', 'The account browser disconnected. Explicit recovery is required.'))).catch(() => {});
                    } catch { /* A notification must not start browser recovery. */ }
                };
                value.browser.on('disconnected', value.onDisconnected);
                if (value.closing) throw browserError('BROWSER_OPEN_CANCELLED', 'Browser opening was cancelled.');
                const page = await preparePage(value, () => { pagesAllowed = true; });
                if (value.closing || value.disconnected || !value.browser.isConnected() || page.isClosed()) {
                    throw browserError('BROWSER_OPEN_CANCELLED', 'Browser closed before opening completed.');
                }
                value.surface = { browser: value.browser, page };
                return value.surface;
            } catch (error) {
                if (value.browser) {
                    try { await dispose(value); } catch (cleanupError) { error.cleanupError = cleanupError; }
                } else release(value);
                throw error;
            }
        })();
        const task = opening;
        task.then(() => { if (opening === task) opening = null; }, () => { if (opening === task) opening = null; });
        return task;
    }

    function close() {
        if (closing) return closing;
        const value = entry;
        if (!value) return Promise.resolve();
        value.closing = true;
        closing = (async () => {
            if (!value.browser) {
                value.controller?.abort();
                if (opening) await bounded(() => opening, closeTimeoutMs);
            }
            // A launch that ignores abort is still reserved. Its eventual
            // result is disposed by open(), even after this bounded wait ends.
            if (value.browser) await dispose(value);
        })();
        const task = closing;
        task.then(() => { if (closing === task) closing = null; }, () => { if (closing === task) closing = null; });
        return task;
    }

    function windowState(state) {
        // Serialize Hide/Show so an account warning cannot be hidden by an
        // older minimize request that finishes late. No navigation or relaunch.
        const task = windowTask.catch(() => {}).then(async () => {
            if (!isOpen()) return false;
            const value = entry;
            if (state === 'background' && value.backgrounded) return true;
            const session = await value.surface.page.target().createCDPSession();
            try {
                const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
                if (state === 'background') {
                    value.restoreBounds = { ...bounds, windowState: bounds?.windowState === 'minimized' ? 'normal' : bounds?.windowState || 'normal' };
                    // Minimization suspends scroll/lazy-loading frames and can
                    // stall mouse input. Keep ordinary Chrome rendering, with
                    // its owned window outside the desktop instead.
                    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
                    await session.send('Browser.setWindowBounds', { windowId, bounds: { left: -30000, top: 0, width: bounds?.width || 1366, height: bounds?.height || 768 } });
                    value.backgrounded = true;
                } else {
                    const restore = value.restoreBounds;
                    if (restore) {
                        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
                        const rectangle = Object.fromEntries(['left','top','width','height'].filter(key => Number.isFinite(restore[key])).map(key => [key,restore[key]]));
                        if (Object.keys(rectangle).length) await session.send('Browser.setWindowBounds', { windowId, bounds: rectangle });
                        if (restore.windowState !== 'normal') await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: restore.windowState } });
                    } else if (bounds?.windowState === 'minimized') {
                        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
                    }
                    value.backgrounded = false;
                    await value.surface.page.bringToFront();
                }
                return true;
            } finally { await session.detach().catch(() => {}); }
        });
        windowTask = task;
        return task;
    }

    return { open, close, isOpen, background: () => windowState('background'), minimize: () => windowState('background'), reveal: () => windowState('normal'), get: () => isOpen() ? entry.surface : null };
}

module.exports = { createAccountBrowser };
