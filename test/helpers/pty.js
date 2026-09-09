'use strict';

// Test-side wrapper for pty-holder.py: opens a pseudo-terminal of a given
// size, exposes its device path, and collects everything written to it.

const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HOLDER = path.join(__dirname, 'pty-holder.py');

function python() {
    for (const cmd of ['python3', 'python']) {
        const r = spawnSync(cmd, ['-c', 'import pty, fcntl, termios'], { stdio: 'ignore' });
        if (r.status === 0) return cmd;
    }
    return null;
}

const PYTHON = process.platform === 'win32' ? null : python();

// Resolves to { tty, output(), close() } or throws if no pty can be made.
function openPty(cols = 80, rows = 24) {
    if (!PYTHON) throw new Error('python3 with pty support is required to open a pseudo-terminal');
    return new Promise((resolve, reject) => {
        const child = spawn(PYTHON, [HOLDER, String(cols), String(rows)], { stdio: ['pipe', 'pipe', 'inherit'] });
        const chunks = [];
        let tty = null;
        let header = '';
        child.stdout.on('data', (d) => {
            if (tty !== null) { chunks.push(d); return; }
            header += d.toString('latin1');
            const nl = header.indexOf('\n');
            if (nl === -1) return;
            tty = header.slice(0, nl).trim();
            const rest = Buffer.from(header.slice(nl + 1), 'latin1');
            if (rest.length) chunks.push(rest);
            if (!tty) { reject(new Error('pty holder reported no device')); return; }
            resolve({
                tty,
                pid: child.pid,
                output: () => Buffer.concat(chunks).toString('utf8'),
                reset: () => { chunks.length = 0; },
                close: () => new Promise((done) => {
                    if (child.exitCode !== null) return done();
                    child.once('exit', () => done());
                    try { child.stdin.end(); } catch (e) {}
                    child.kill('SIGTERM');
                }),
            });
        });
        child.on('error', reject);
        child.on('exit', (code) => { if (tty === null) reject(new Error(`pty holder exited early (${code})`)); });
    });
}

module.exports = { openPty, PTY_AVAILABLE: !!PYTHON };
