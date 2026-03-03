// app/api/generation/route.js
import { spawn } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

let currentChild = null;
let currentStopFile = null;
let stopRequestedByApi = false;
export const runtime = 'nodejs';
const RUN_STATE_PATH = path.join('/tmp', 'walletool-generation-state.json');
const TYPE_FILE = {
    start: path.join(process.cwd(), 'novelty_wallets', 'start', 'start_wallets.jsonl'),
    end: path.join(process.cwd(), 'novelty_wallets', 'end', 'end_wallets.jsonl'),
    both: path.join(process.cwd(), 'novelty_wallets', 'both', 'both_wallets.jsonl')
};

function extractWalletType(line) {
    if (/\bBOTH\b/i.test(line)) return 'both';
    if (/\bSTART\b/i.test(line)) return 'start';
    if (/\bEND\b/i.test(line)) return 'end';
    return null;
}

function readLastJsonLine(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.size) return null;

    const fd = fs.openSync(filePath, 'r');
    try {
        const chunkSize = 64 * 1024;
        let pos = stat.size;
        let carry = '';

        while (pos > 0) {
            const readSize = Math.min(chunkSize, pos);
            pos -= readSize;
            const buf = Buffer.allocUnsafe(readSize);
            fs.readSync(fd, buf, 0, readSize, pos);
            const text = buf.toString('utf8') + carry;
            const lines = text.split('\n');
            carry = lines.shift() || '';

            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (!line) continue;
                try {
                    return JSON.parse(line);
                } catch {
                    continue;
                }
            }
        }

        const lastTry = carry.trim();
        if (!lastTry) return null;
        try {
            return JSON.parse(lastTry);
        } catch {
            return null;
        }
    } finally {
        fs.closeSync(fd);
    }
}

function readRecentJsonLines(filePath, maxRecords = 40) {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    if (!stat.size) return [];

    const fd = fs.openSync(filePath, 'r');
    try {
        const chunkSize = 64 * 1024;
        let pos = stat.size;
        let carry = '';
        const parsed = [];

        while (pos > 0 && parsed.length < maxRecords) {
            const readSize = Math.min(chunkSize, pos);
            pos -= readSize;
            const buf = Buffer.allocUnsafe(readSize);
            fs.readSync(fd, buf, 0, readSize, pos);
            const text = buf.toString('utf8') + carry;
            const lines = text.split('\n');
            carry = lines.shift() || '';

            for (let i = lines.length - 1; i >= 0 && parsed.length < maxRecords; i--) {
                const line = lines[i].trim();
                if (!line) continue;
                try {
                    parsed.push(JSON.parse(line));
                } catch { }
            }
        }

        if (carry.trim() && parsed.length < maxRecords) {
            try {
                parsed.push(JSON.parse(carry.trim()));
            } catch { }
        }

        return parsed;
    } finally {
        fs.closeSync(fd);
    }
}

function parseVanitySignatureFromLog(line, type) {
    const vanityPart = line.split('→')[1]?.trim().split(' [')[0] || '';
    if (!vanityPart.includes('...')) return null;
    const [left, right] = vanityPart.split('...');
    const sig = {
        start: (left || '').toUpperCase(),
        end: (right || '').toUpperCase()
    };

    if (type === 'start') return { start: sig.start, end: '' };
    if (type === 'end') return { start: '', end: sig.end };
    if (type === 'both') return sig;
    return null;
}

function parsePubShortFromLog(line) {
    const m = line.match(/\[([1-9A-HJ-NP-Za-km-z]{4,})\.\.\.([1-9A-HJ-NP-Za-km-z]{4,})\]/);
    if (!m) return null;
    return { prefix: m[1], suffix: m[2] };
}

function parseWalletPayloadFromLog(line) {
    // Example:
    // 🔥🔥 RARE 6 END → V9QF...GA1AXY  [V9qfYhWe...5fga1axY]
    // 🔥🔥🔥 EPIC 3+4 BOTH → 4SS...T175  [4SsoZ...3xMQT175]
    const m = line.match(/(?:ULTRA RARE|EPIC|RARE)\s+([0-9]+(?:\+[0-9]+)?)\s+(BOTH|START|END)\s+→\s+(.+?)\s+\[([^\]]+)\]/i);
    if (!m) return null;

    const lengthSpec = m[1];
    const type = m[2].toLowerCase();
    const vanityDisplay = m[3].trim();
    const pubShort = m[4].trim();
    const [leftRaw = '', rightRaw = ''] = vanityDisplay.split('...');
    const left = leftRaw.trim();
    const right = rightRaw.trim();

    let startLen = 0;
    let endLen = 0;
    if (lengthSpec.includes('+')) {
        const [a, b] = lengthSpec.split('+').map(n => parseInt(n, 10));
        startLen = Number.isFinite(a) ? a : 0;
        endLen = Number.isFinite(b) ? b : 0;
    } else {
        const single = parseInt(lengthSpec, 10);
        if (type === 'start') startLen = Number.isFinite(single) ? single : 0;
        else if (type === 'end') endLen = Number.isFinite(single) ? single : 0;
        else startLen = Number.isFinite(single) ? single : 0;
    }

    const startMatch = type === 'start' || type === 'both' ? (left || null) : null;
    const endMatch = type === 'end' || type === 'both' ? (right || null) : null;

    return {
        vanityDisplay,
        publicKey: pubShort,
        publicKeyShort: pubShort,
        isShortPubkey: true,
        startMatch,
        endMatch,
        startLen,
        endLen,
        matchLen: startLen + endLen,
        folder: type
    };
}

function buildWalletFromLog(line) {
    const vanityDisplay = line.split('→')[1]?.trim().split(' [')[0] || 'NEW VANITY';
    const publicKey = line.match(/\[([A-HJ-NP-Za-km-z1-9]{8,})\]/)?.[1] || 'unknown';
    return {
        vanityDisplay,
        publicKey,
        startMatch: null,
        endMatch: null
    };
}

function buildWalletPayload(line) {
    const type = extractWalletType(line);
    if (!type) return buildWalletFromLog(line);

    const sig = parseVanitySignatureFromLog(line, type);
    const shortPub = parsePubShortFromLog(line);
    let latest = null;

    if (sig || shortPub) {
        const recent = readRecentJsonLines(TYPE_FILE[type], 50);
        latest = recent.find((row) => {
            const pub = row.publicKey || '';
            const s = (row.startMatch || '').toUpperCase();
            const e = (row.endMatch || '').toUpperCase();
            const shortMatches = shortPub
                ? pub.startsWith(shortPub.prefix) && pub.endsWith(shortPub.suffix)
                : true;
            if (!shortMatches) return false;

            if (!sig) return true;
            if (type === 'start') return s === sig.start;
            if (type === 'end') return e === sig.end;
            return s === sig.start && e === sig.end;
        }) || null;
    }

    if (!latest) latest = readLastJsonLine(TYPE_FILE[type]);
    if (!latest || !latest.publicKey) return buildWalletFromLog(line);

    const startMatch = latest.startMatch || '';
    const endMatch = latest.endMatch || '';
    const vanityDisplay = startMatch && endMatch
        ? `${startMatch}...${endMatch}`
        : startMatch
            ? `${startMatch}...${latest.publicKey.slice(-4)}`
            : `${latest.publicKey.slice(0, 4)}...${endMatch}`;

    return {
        vanityDisplay,
        publicKey: latest.publicKey,
        startMatch: startMatch || null,
        endMatch: endMatch || null,
        generatedAt: latest.generatedAt || null,
        folder: type
    };
}

async function resolveWalletPayloadWithRetry(line, attempts = 7, delayMs = 120) {
    const parsed = parseWalletPayloadFromLog(line);
    if (parsed) return parsed;

    for (let i = 0; i < attempts; i++) {
        const payload = buildWalletPayload(line);
        if (payload.publicKey && payload.publicKey !== 'unknown') return payload;
        await new Promise((r) => setTimeout(r, delayMs));
    }
    return buildWalletFromLog(line);
}

function signalChildTree(child, signal) {
    if (!child || !child.pid) return false;
    let signaled = false;
    try {
        process.kill(-child.pid, signal);
        signaled = true;
    } catch { }
    try {
        child.kill(signal);
        signaled = true;
    } catch { }
    return signaled;
}

function writeRunState(state) {
    try {
        fs.writeFileSync(RUN_STATE_PATH, JSON.stringify(state));
    } catch { }
}

function readRunState() {
    try {
        if (!fs.existsSync(RUN_STATE_PATH)) return null;
        return JSON.parse(fs.readFileSync(RUN_STATE_PATH, 'utf8'));
    } catch {
        return null;
    }
}

function clearRunState() {
    try { fs.unlinkSync(RUN_STATE_PATH); } catch { }
}

function isPidAlive(pid) {
    if (!pid || !Number.isFinite(pid)) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function signalPidTree(pid, signal) {
    if (!pid || !Number.isFinite(pid)) return false;
    let ok = false;
    try {
        process.kill(-pid, signal);
        ok = true;
    } catch { }
    try {
        process.kill(pid, signal);
        ok = true;
    } catch { }
    return ok;
}

export async function POST(request) {
    const { minutes, repeatCycle } = await request.json();
    const useSudoRequested = process.env.WALLETOOL_USE_SUDO === '1';
    const useSudo = false; // Web-managed runs must remain stoppable by this same process user.

    if (currentChild) {
        signalChildTree(currentChild, 'SIGINT');
    }
    stopRequestedByApi = false;
    const existing = readRunState();
    if (existing?.pid && isPidAlive(existing.pid)) {
        if (existing.stopFile) {
            try { fs.writeFileSync(existing.stopFile, `${Date.now()}\n`); } catch { }
        }
        signalPidTree(existing.pid, 'SIGINT');
    }

    const args = ['generate'];
    if (minutes) args.push(minutes.toString());
    if (repeatCycle) {
        args.push('repeat');
        args.push(repeatCycle.toString());
    }

    const scriptPath = path.join(process.cwd(), 'walletool.cjs');
    currentStopFile = path.join('/tmp', `walletool-stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.flag`);
    try { fs.unlinkSync(currentStopFile); } catch { }
    const nodeBin = process.execPath;
    const cmd = useSudo ? 'sudo' : nodeBin;
    const cmdArgs = useSudo ? ['-n', nodeBin, scriptPath, ...args] : [scriptPath, ...args];

    if (useSudoRequested) {
        global.broadcastLog?.('[SYSTEM] WALLETOOL_USE_SUDO=1 detected, but web runner forces non-sudo mode so STOP works reliably.');
    }

    currentChild = spawn(cmd, cmdArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: process.cwd(),
        detached: true,
        env: {
            ...process.env,
            WALLETOOL_STOP_FILE: currentStopFile
        }
    });
    writeRunState({ pid: currentChild.pid, stopFile: currentStopFile, startedAt: Date.now() });

    currentChild.stdout.on('data', (data) => {
        const lines = data.toString().split('\n');
        lines.forEach(line => {
            if (line.trim()) {
                global.broadcastLog?.(line.trim());
                if (line.includes('🔥') || line.includes('RARE') || line.includes('EPIC')) {
                    void resolveWalletPayloadWithRetry(line.trim()).then((payload) => {
                        global.broadcastNewWallet?.(payload);
                    });
                }
            }
        });
    });

    currentChild.stderr.on('data', (data) => {
        global.broadcastLog?.(`[ERROR] ${data.toString().trim()}`);
    });

    currentChild.on('exit', (code) => {
        currentChild = null;
        if (currentStopFile) {
            try { fs.unlinkSync(currentStopFile); } catch { }
            currentStopFile = null;
        }
        clearRunState();
        stopRequestedByApi = false;
        global.broadcastLog?.('[SYSTEM] Process exited');
    });

    return Response.json({ success: true, pid: currentChild.pid });
}

export async function DELETE() {
    stopRequestedByApi = true;
    const state = readRunState();
    const pid = currentChild?.pid || state?.pid || null;
    const stopFile = currentStopFile || state?.stopFile || null;
    let stopFlagWritten = false;

    if (stopFile) {
        try {
            fs.writeFileSync(stopFile, `${Date.now()}\n`);
            global.broadcastLog?.('[SYSTEM] Stop flag written.');
            stopFlagWritten = true;
        } catch { }
    }

    let stopSignaled = false;
    if (pid && isPidAlive(pid)) {
        const signaled = signalPidTree(pid, 'SIGINT');
        stopSignaled = signaled || stopSignaled;
        global.broadcastLog?.('[SYSTEM] Stop requested (SIGINT)...');

        setTimeout(() => {
            if (isPidAlive(pid)) {
                signalPidTree(pid, 'SIGTERM');
                global.broadcastLog?.('[SYSTEM] Escalating stop (SIGTERM)...');
            }
        }, 1500);

        setTimeout(() => {
            if (isPidAlive(pid)) {
                signalPidTree(pid, 'SIGKILL');
                global.broadcastLog?.('[SYSTEM] Forced stop (SIGKILL).');
                clearRunState();
            }
        }, 4000);
        setTimeout(() => {
            if (isPidAlive(pid)) {
                global.broadcastLog?.('[ERROR] Process is still alive after SIGKILL. This usually means a permissions/ownership mismatch (e.g. root-owned process).');
            }
        }, 4700);

        if (!signaled && !stopFlagWritten) {
            return Response.json({ success: false, error: 'Unable to signal running process.' }, { status: 500 });
        }
    }

    // Fallback: kill by process pattern in case run-state PID is stale.
    try {
        execFileSync('pkill', ['-INT', '-f', 'walletool.cjs'], { timeout: 800, stdio: 'ignore' });
        stopSignaled = true;
    } catch { }
    setTimeout(() => {
        try { execFileSync('pkill', ['-TERM', '-f', 'walletool.cjs'], { timeout: 800, stdio: 'ignore' }); } catch { }
    }, 1500);
    setTimeout(() => {
        try { execFileSync('pkill', ['-KILL', '-f', 'walletool.cjs'], { timeout: 800, stdio: 'ignore' }); } catch { }
    }, 4000);

    if (!stopSignaled && !stopFlagWritten) {
        global.broadcastLog?.('[ERROR] Stop request accepted but no active generator PID was found.');
    }
    clearRunState();
    return Response.json({ success: true, stopFlagWritten });
}
