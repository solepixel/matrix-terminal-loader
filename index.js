#!/usr/bin/env node
'use strict';

// matrix-terminal-loader
//
// Modes:
//   --start  Hook entry point (UserPromptSubmit). Finds the terminal Claude
//            Code is running in, spawns a detached `--run` process that draws
//            on it, and exits immediately so Claude Code is never blocked.
//   --stop   Hook entry point (Stop). Kills the `--run` process and restores
//            the terminal.
//   --run    The animation loop itself.
//
// Why the indirection: Claude Code runs hooks in their own session with no
// controlling terminal and captures their stdout, so a hook cannot simply
// print escape codes. Instead --start looks up the terminal device of its
// parent (the Claude Code process) and --run opens that device by path.
//
// The rain is drawn on the terminal's alternate screen buffer, the same one
// full-screen programs like vim use. The main screen, with Claude Code's
// transcript on it, is never touched and comes back intact when the rain
// stops.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const LOCK_FILE = path.join(__dirname, '.matrix.lock');

// ---- Look and feel -------------------------------------------------------

const FRAME_MS = 50;              // 20 frames per second
const COLUMN_SPACING = 2;         // one stream every N terminal cells
const SPAWN_CHANCE = 0.03;        // chance per frame that an idle column starts a drop
const DECAY_PER_FRAME = 0.035;    // how fast a trail fades (about 1.4 s at 20 fps)
const FLICKER_CHANCE = 0.02;      // chance per frame a lit cell swaps its glyph
const FULL_REPAINT_EVERY = 40;    // frames between full repaints (cleans up stray output)
const SPEEDS = [1, 1, 2, 2, 3];   // frames per step; picked at random per drop

const chars = "ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ1234567890ABCDEF";

// Brightness levels from head to faded, as {r,g,b} and a 256-color fallback.
const LEVELS = [
    { min: 0.70, rgb: [0, 255, 65],  idx: 46 },
    { min: 0.40, rgb: [0, 190, 50],  idx: 40 },
    { min: 0.15, rgb: [0, 125, 35],  idx: 28 },
    { min: 0.00, rgb: [0, 70, 20],   idx: 22 },
];
const HEAD = { rgb: [220, 255, 220], idx: 231 };

const TRUECOLOR = /^(truecolor|24bit)$/i.test(process.env.COLORTERM || '');
function sgr(level) {
    return TRUECOLOR
        ? `\x1B[38;2;${level.rgb[0]};${level.rgb[1]};${level.rgb[2]}m`
        : `\x1B[38;5;${level.idx}m`;
}
const SGR_HEAD = '\x1B[1m' + sgr(HEAD);
const SGR_LEVELS = LEVELS.map(sgr);
const SGR_RESET = '\x1B[0m';

const ENTER = '\x1B[?1049h\x1B[?25l\x1B[2J';   // alternate screen, hide cursor, clear it
const LEAVE = '\x1B[0m\x1B[2J\x1B[?25h\x1B[?1049l'; // reset colors, clear alt screen, show cursor, back to main screen

// ---- Helpers -------------------------------------------------------------

function log(msg) {
    if (process.env.MATRIX_DEBUG) {
        try { fs.appendFileSync(process.env.MATRIX_DEBUG, `[${process.pid}] ${msg}\n`); } catch (e) {}
    }
}

function readLockPid() {
    try {
        return parseInt(fs.readFileSync(LOCK_FILE, 'utf8'), 10) || null;
    } catch (e) {
        return null;
    }
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

// Terminal device of a process, e.g. /dev/ttys005 (macOS) or /dev/pts/3 (Linux).
function ttyOfProcess(pid) {
    if (process.platform === 'win32') return null;
    try {
        const name = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        if (!name || name === '?' || name === '??' || name === '-') return null;
        return name.startsWith('/dev/') ? name : `/dev/${name}`;
    } catch (e) {
        return null;
    }
}

function resolveTty() {
    if (process.env.MATRIX_TTY) return process.env.MATRIX_TTY;
    return ttyOfProcess(process.ppid) || ttyOfProcess(process.pid);
}

// Open a terminal for writing without adopting it as our controlling terminal.
function openTty(ttyPath) {
    try {
        return fs.openSync(ttyPath, fs.constants.O_WRONLY | fs.constants.O_NOCTTY);
    } catch (e) {
        log(`open ${ttyPath} failed: ${e.code}`);
        return null;
    }
}

function writeTty(fd, data) {
    try { fs.writeSync(fd, data); return true; } catch (e) { log(`write failed: ${e.code}`); return false; }
}

// Size of the terminal at ttyPath. A process outside the terminal's session
// cannot ioctl it from Node, but stty can read it by path.
function ttySize(ttyPath) {
    const flag = process.platform === 'linux' ? '-F' : '-f';
    try {
        const out = execFileSync('stty', [flag, ttyPath, 'size'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const [rows, cols] = out.trim().split(/\s+/).map(Number);
        if (rows > 0 && cols > 0) return { width: cols, height: rows };
    } catch (e) {}
    return null;
}

// Set the terminal size by path (works from outside the terminal's session).
function setTtySize(ttyPath, width, height) {
    const flag = process.platform === 'linux' ? '-F' : '-f';
    try {
        execFileSync('stty', [flag, ttyPath, 'columns', String(width), 'rows', String(height)], { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

// Ask Claude Code to repaint its transcript. It ignores a bare SIGWINCH but
// fully re-renders on a real size change, so shrink the terminal by one
// column and put it straight back. The kernel raises SIGWINCH for both.
function nudgeRepaint(ttyPath) {
    const size = ttySize(ttyPath);
    if (!size) return false;
    if (!setTtySize(ttyPath, size.width - 1, size.height)) return false;
    return setTtySize(ttyPath, size.width, size.height);
}

function randomChar() {
    return chars[Math.floor(Math.random() * chars.length)];
}

// ---- The rain ------------------------------------------------------------

class Rain {
    constructor(width, height) {
        this.resize(width, height);
    }

    resize(width, height) {
        this.width = width;
        this.height = height;
        this.cols = Math.max(1, Math.floor(width / COLUMN_SPACING));
        // One drop state per column.
        this.drops = Array.from({ length: this.cols }, () => ({ head: -1, speed: 1, tick: 0, active: false }));
        // One cell per column and row: glyph, brightness, whether it is the head.
        this.cells = Array.from({ length: this.cols }, () =>
            Array.from({ length: height }, () => ({ ch: ' ', v: 0, head: false, drawn: '' })));
        // Seed a few drops mid-screen so it does not start empty.
        for (const d of this.drops) {
            if (Math.random() < 0.3) this.spawn(d, Math.floor(Math.random() * height));
        }
        this.frame = 0;
    }

    spawn(d, at = 0) {
        d.active = true;
        d.head = at;
        d.speed = SPEEDS[Math.floor(Math.random() * SPEEDS.length)];
        d.tick = 0;
    }

    step() {
        this.frame++;
        for (let c = 0; c < this.cols; c++) {
            const d = this.drops[c];
            const column = this.cells[c];

            // Fade every lit cell and occasionally swap its glyph.
            for (let y = 0; y < this.height; y++) {
                const cell = column[y];
                if (cell.v > 0) {
                    cell.v = Math.max(0, cell.v - DECAY_PER_FRAME);
                    if (cell.v > 0.15 && Math.random() < FLICKER_CHANCE) cell.ch = randomChar();
                }
            }

            if (!d.active) {
                if (Math.random() < SPAWN_CHANCE) this.spawn(d);
                continue;
            }

            if (++d.tick < d.speed) continue;
            d.tick = 0;

            // The old head becomes the brightest part of the trail.
            if (d.head >= 0 && d.head < this.height) column[d.head].head = false;

            d.head++;
            if (d.head >= this.height) {
                d.active = false;
                continue;
            }
            const cell = column[d.head];
            cell.ch = randomChar();
            cell.v = 1;
            cell.head = true;
        }
    }

    // Returns the escape sequence for everything that changed since last render.
    render(full = false) {
        let out = '';
        let currentSgr = null;
        for (let c = 0; c < this.cols; c++) {
            const x = c * COLUMN_SPACING + 1;
            const column = this.cells[c];
            for (let y = 0; y < this.height; y++) {
                const cell = column[y];
                let sgrCode, ch;
                if (cell.v <= 0) {
                    sgrCode = SGR_RESET;
                    ch = ' ';
                } else if (cell.head) {
                    sgrCode = SGR_HEAD;
                    ch = cell.ch;
                } else {
                    let i = 0;
                    while (i < LEVELS.length - 1 && cell.v < LEVELS[i].min) i++;
                    sgrCode = SGR_LEVELS[i];
                    ch = cell.ch;
                }
                const key = sgrCode + ch;
                if (!full && key === cell.drawn) continue;
                if (full && ch === ' ') { cell.drawn = key; continue; } // screen was just cleared
                cell.drawn = key;
                out += `\x1B[${y + 1};${x}H`;
                if (sgrCode !== currentSgr) {
                    out += SGR_RESET + (sgrCode === SGR_RESET ? '' : sgrCode);
                    currentSgr = sgrCode;
                }
                out += ch;
            }
        }
        return out;
    }
}

// ---- STOP HOOK: kills the running animation loop -------------------------

if (process.argv.includes('--stop')) {
    const pid = readLockPid();
    if (pid) {
        try { process.kill(pid, 'SIGTERM'); } catch (e) {}
        // Give the run process a moment to leave the alternate screen itself.
        const deadline = Date.now() + 500;
        while (isAlive(pid) && Date.now() < deadline) {
            try { execFileSync('sleep', ['0.02']); } catch (e) { break; }
        }
    }
    try { fs.unlinkSync(LOCK_FILE); } catch (e) {}

    const ttyPath = resolveTty();
    const fd = ttyPath ? openTty(ttyPath) : null;
    if (fd !== null) {
        // Belt and braces: if the run process could not restore the terminal,
        // do it from here (on the terminal, never on stdout).
        writeTty(fd, LEAVE);
        fs.closeSync(fd);
        // Claude Code wrote its response while the alternate screen was up,
        // so that output is gone. A resize makes it repaint everything.
        log(`stop: repaint nudge ${nudgeRepaint(ttyPath) ? 'sent' : 'failed'}`);
    }
    process.exit(0);
}

// ---- START HOOK: boots the animation in a detached background process -----

if (process.argv.includes('--start')) {
    const existing = readLockPid();
    if (existing && isAlive(existing)) process.exit(0); // already running

    const ttyPath = resolveTty();
    log(`start: tty=${ttyPath}`);
    if (!ttyPath) process.exit(0); // no terminal to draw on (CI, Windows, piped runs)

    const child = spawn(process.execPath, [__filename, '--run'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, MATRIX_TTY: ttyPath, MATRIX_PARENT_PID: String(process.ppid) },
    });
    child.unref();

    // Write PID to lockfile so the stop hook knows what process to kill
    fs.writeFileSync(LOCK_FILE, String(child.pid), 'utf8');
    process.exit(0);
}

// ---- RUN: the animation loop (normally launched by --start) ---------------

if (process.argv.includes('--run')) {
    const ttyPath = resolveTty();
    const fd = ttyPath ? openTty(ttyPath) : null;
    if (fd === null) process.exit(0);

    const parentPid = parseInt(process.env.MATRIX_PARENT_PID || '', 10) || null;

    let finished = false;
    const cleanup = () => {
        if (finished) return;
        finished = true;
        writeTty(fd, LEAVE);
        try { if (readLockPid() === process.pid) fs.unlinkSync(LOCK_FILE); } catch (e) {}
        process.exit(0);
    };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGHUP', cleanup);

    // Safety net: if the Claude Code process that started us is gone
    // (crash, Ctrl+C, Stop hook never fired), shut ourselves down.
    if (parentPid) {
        setInterval(() => { if (!isAlive(parentPid)) cleanup(); }, 1000);
    }

    const size = ttySize(ttyPath) || { width: 80, height: 24 };
    log(`run: tty=${ttyPath} size=${size.width}x${size.height} truecolor=${TRUECOLOR}`);
    const rain = new Rain(size.width, size.height);

    writeTty(fd, ENTER);

    // Handle terminal resizes. A process outside the terminal's session never
    // receives SIGWINCH, so poll the size instead.
    setInterval(() => {
        const s = ttySize(ttyPath);
        if (!s || (s.width === rain.width && s.height === rain.height)) return;
        rain.resize(s.width, s.height);
        writeTty(fd, '\x1B[2J' + rain.render(true));
    }, 500);

    setInterval(() => {
        rain.step();
        let out;
        if (rain.frame % FULL_REPAINT_EVERY === 0) {
            // Claude Code keeps writing its spinner while we run. A periodic
            // full repaint clears whatever it left behind.
            out = '\x1B[2J' + rain.render(true);
        } else {
            out = rain.render(false);
        }
        // The terminal went away (closed window, revoked device): stop quietly.
        if (out && !writeTty(fd, out)) cleanup();
    }, FRAME_MS);
}
