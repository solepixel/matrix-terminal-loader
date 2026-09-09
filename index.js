#!/usr/bin/env node
'use strict';

// matrix-terminal-loader
//
// Modes:
//   --start  Hook entry point (UserPromptSubmit). Finds the terminal Claude
//            Code is running in, spawns a detached `--run` process that draws
//            on it, and exits immediately so Claude Code is never blocked.
//   --stop   Hook entry point (Stop). Tells the `--run` process to wind down,
//            waits for it, then asks Claude Code to repaint the transcript.
//   --run    The animation loop itself.
//
// Why the indirection: Claude Code runs hooks in their own session with no
// controlling terminal and captures their stdout, so a hook cannot simply
// print escape codes. Instead --start looks up the terminal device of its
// parent (the Claude Code process) and --run opens that device by path.
//
// Claude Code 2.1 runs its interface on the terminal's alternate screen
// buffer and repaints all of it when the terminal is resized. So the rain
// simply draws over that screen, clears it when done, and the stop hook
// nudges the terminal size to make Claude Code repaint everything.

const fs = require('fs');
const os = require('os');
const path = require('path');
const tty = require('tty');
const { spawn, execFileSync } = require('child_process');

const CONFIG_BASENAME = 'matrix-terminal-loader.json';

// ---- Settings --------------------------------------------------------------
//
// Defaults below can be overridden, in this order, by:
//   1. ~/.claude/matrix-terminal-loader.json           (per user)
//   2. <project>/.claude/matrix-terminal-loader.json   (per project)
//   3. plugin settings from the manifest's userConfig, which Claude Code
//      passes to hooks as CLAUDE_PLUGIN_OPTION_<KEY> environment variables
//   4. environment variables MATRIX_MESSAGES, MATRIX_STATUS, MATRIX_WIND_DOWN_MS,
//      MATRIX_KEEP_BOTTOM_ROWS
// Any subset of keys may be given in the JSON files; nested objects are merged.

const DEFAULTS = {
    frameMs: 50,                // 20 frames per second
    columnSpacing: 2,           // one stream every N terminal cells
    keepBottomRows: 6,          // rows at the bottom the rain never touches, so Claude Code's prompt box stays clean while you type
    spawnChance: 0.03,          // chance per frame that an idle column starts a drop
    decayPerFrame: 0.035,       // how fast a trail fades (about 1.4 s at 20 fps)
    flickerChance: 0.02,        // chance per frame that a lit cell swaps its glyph
    speeds: [1, 1, 2, 2, 3],    // frames per step; picked at random per drop
    windDownMaxMs: 4000,        // longest the wind-down may take once Claude is done
    maxRunMs: 15 * 60 * 1000,   // hard stop if no Stop hook ever arrives
    alternateScreen: false,     // switch to the alternate screen buffer for the rain (see README)
    chars: "ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ1234567890ABCDEF",
    colors: {
        head: [220, 255, 220],
        trail: [[0, 255, 65], [0, 190, 50], [0, 125, 35], [0, 70, 20]],
        text: [200, 200, 200],
        bullet: [0, 255, 65],
        status: [0, 190, 50],
    },
    messages: {
        enabled: false,         // opt-in: overlay Claude's progress as formatted bullets instead of letting its own text bleed through
        lines: 40,              // how many recent messages to keep; they scroll up as they arrive
        showPrompt: true,       // include your own prompt as the first line
    },
    status: {
        enabled: false,         // opt-in: show a Matrix-themed status line on the bottom row
        intervalMs: 60000,      // hold a verb this long before changing (one per cycle)
        verbs: [
            'Following the white rabbit', 'Jacking in', 'Loading the construct',
            'Bending spoons', 'Dodging bullets', 'Reading the code',
            'Consulting the Oracle', 'Calling the Operator', 'Taking the red pill',
            'Compiling the Matrix', 'Tracing the signal', 'Freeing your mind',
        ],
        windDownVerb: 'Exiting the Matrix',
    },
};

// The Stop hook blocks Claude Code while the rain drains, and its timeout in
// plugin.json is 20 s, so the wind-down is capped well inside that.
const WIND_DOWN_CAP_MS = 15000;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Deep copy of `base` with `extra` merged over it. Arrays and scalars in
// `extra` replace; nested objects merge. Never mutates or aliases either input.
function deepMerge(base, extra) {
    if (!isPlainObject(base)) return extra === undefined ? base : extra;
    const out = {};
    for (const [k, v] of Object.entries(base)) out[k] = isPlainObject(v) ? deepMerge(v, undefined) : v;
    if (!isPlainObject(extra)) return out;
    for (const [k, v] of Object.entries(extra)) {
        if (isPlainObject(v)) out[k] = deepMerge(isPlainObject(out[k]) ? out[k] : {}, v);
        else out[k] = v;
    }
    return out;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function envFlag(env, name) {
    const v = env[name];
    if (v === undefined || v === '') return undefined;
    return !/^(0|false|no|off)$/i.test(v.trim());
}

function envInt(env, name) {
    const n = parseInt(env[name] || '', 10);
    return Number.isFinite(n) ? n : undefined;
}

// `opts.env` and `opts.homeDir` exist so tests can run without touching the
// real environment; the hooks call this with no options.
function loadConfig(cwd, opts = {}) {
    const env = opts.env || process.env;
    const homeDir = opts.homeDir || os.homedir();
    let cfg = deepMerge(DEFAULTS, readJson(path.join(homeDir, '.claude', CONFIG_BASENAME)));
    if (cwd) cfg = deepMerge(cfg, readJson(path.join(cwd, '.claude', CONFIG_BASENAME)));

    // Plugin settings (userConfig in plugin.json) arrive as environment variables.
    const pm = envFlag(env, 'CLAUDE_PLUGIN_OPTION_SHOW_MESSAGES'); if (pm !== undefined) cfg.messages.enabled = pm;
    const pl = envInt(env, 'CLAUDE_PLUGIN_OPTION_MESSAGE_LINES'); if (pl !== undefined && pl > 0) cfg.messages.lines = pl;
    const ps = envFlag(env, 'CLAUDE_PLUGIN_OPTION_SHOW_STATUS'); if (ps !== undefined) cfg.status.enabled = ps;
    const pw = envInt(env, 'CLAUDE_PLUGIN_OPTION_WIND_DOWN_MS'); if (pw !== undefined && pw >= 0) cfg.windDownMaxMs = pw;
    const pk = envInt(env, 'CLAUDE_PLUGIN_OPTION_KEEP_BOTTOM_ROWS'); if (pk !== undefined && pk >= 0) cfg.keepBottomRows = pk;
    const pv = env.CLAUDE_PLUGIN_OPTION_STATUS_VERBS;
    if (pv && pv.trim()) cfg.status.verbs = pv.split('|').map((v) => v.trim()).filter(Boolean);

    // Plain environment variables win over everything.
    const m = envFlag(env, 'MATRIX_MESSAGES'); if (m !== undefined) cfg.messages.enabled = m;
    const st = envFlag(env, 'MATRIX_STATUS'); if (st !== undefined) cfg.status.enabled = st;
    const w = envInt(env, 'MATRIX_WIND_DOWN_MS'); if (w !== undefined && w >= 0) cfg.windDownMaxMs = w;
    const k = envInt(env, 'MATRIX_KEEP_BOTTOM_ROWS'); if (k !== undefined && k >= 0) cfg.keepBottomRows = k;

    // Keep a hand-edited config from producing something undrawable.
    cfg.windDownMaxMs = Math.min(WIND_DOWN_CAP_MS, Math.max(0, Number(cfg.windDownMaxMs) || 0));
    cfg.columnSpacing = Math.max(1, Math.floor(Number(cfg.columnSpacing)) || 1);
    cfg.keepBottomRows = Math.max(0, Math.floor(Number(cfg.keepBottomRows)) || 0);
    cfg.frameMs = Math.max(10, Number(cfg.frameMs) || DEFAULTS.frameMs);
    if (typeof cfg.chars !== 'string' || !cfg.chars) cfg.chars = DEFAULTS.chars;
    if (!Array.isArray(cfg.speeds) || !cfg.speeds.length) cfg.speeds = DEFAULTS.speeds.slice();
    if (!Array.isArray(cfg.colors.trail) || !cfg.colors.trail.length) cfg.colors.trail = DEFAULTS.colors.trail.map((c) => c.slice());
    if (!Array.isArray(cfg.status.verbs)) cfg.status.verbs = DEFAULTS.status.verbs.slice();
    return cfg;
}

// ---- Helpers ---------------------------------------------------------------

function log(msg) {
    if (process.env.MATRIX_DEBUG) {
        const t = new Date().toISOString().slice(11, 23);
        try { fs.appendFileSync(process.env.MATRIX_DEBUG, `${t} [${process.pid}] ${msg}\n`); } catch (e) {}
    }
}

function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Hook input arrives as JSON on stdin. Returns {} when there is none.
function readHookInput() {
    try {
        if (process.stdin.isTTY) return {};
        const raw = fs.readFileSync(0, 'utf8');
        const parsed = raw.trim() ? JSON.parse(raw) : {};
        return isPlainObject(parsed) ? parsed : {};
    } catch (e) {
        return {};
    }
}

// One lock file per terminal, so two Claude Code sessions in two windows each
// get their own rain and never stop each other's. Lives in the temp dir so
// nothing is ever written into the plugin's own directory.
function lockPath(ttyPath) {
    const name = String(ttyPath).replace(/^\/dev\//, '').replace(/[^A-Za-z0-9]+/g, '-');
    return path.join(os.tmpdir(), `matrix-terminal-loader-${name}.lock`);
}

function readLockPid(lockFile) {
    try {
        return parseInt(fs.readFileSync(lockFile, 'utf8'), 10) || null;
    } catch (e) {
        return null;
    }
}

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

// Command line of a process, or null if it cannot be read.
function commandOfProcess(pid) {
    if (process.platform === 'win32') return null;
    if (process.platform === 'linux') {
        try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim(); } catch (e) {}
    }
    try {
        return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch (e) {
        return null;
    }
}

// True when `pid` is a live `--run` process of this plugin. A stale lock
// whose PID was recycled by some unrelated process must not block the rain
// (or, worse, get that process signalled by the stop hook). If the command
// line cannot be read at all, liveness alone has to do.
function isRainProcess(pid) {
    if (!pid || !isAlive(pid)) return false;
    const cmd = commandOfProcess(pid);
    return cmd === null || (cmd.includes('--run') && cmd.includes(path.basename(__filename)));
}

// Terminal device of a process, e.g. /dev/ttys005 (macOS) or /dev/pts/3 (Linux).
// On Linux the answer is in /proc, which needs no fork and works on minimal
// images without `ps`; elsewhere `ps` reports the controlling terminal.
function ttyOfProcess(pid) {
    if (process.platform === 'win32') return null;
    if (process.platform === 'linux') {
        for (const n of [0, 1, 2]) {
            try {
                const target = fs.readlinkSync(`/proc/${pid}/fd/${n}`);
                if (/^\/dev\/(pts\/\d+|tty[A-Za-z0-9]+)$/.test(target)) return target;
            } catch (e) {}
        }
    }
    try {
        const name = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (!name || name === '?' || name === '??' || name === '-') return null;
        return name.startsWith('/dev/') ? name : `/dev/${name}`;
    } catch (e) {
        return null;
    }
}

function resolveTty(env = process.env) {
    if (env.MATRIX_TTY) return env.MATRIX_TTY;
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

// One blocking write per call, so a whole frame reaches the terminal as a
// single write() and Claude Code's concurrent output can only land between our
// frames, never inside one of our escape sequences. Returns false only when
// the terminal is genuinely gone (EIO/EBADF), which tells the caller to stop.
function writeTty(fd, data) {
    try {
        fs.writeSync(fd, Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));
        return true;
    } catch (e) {
        log(`write failed: ${e.code}`);
        return false;
    }
}

const STTY_FLAG = process.platform === 'linux' ? '-F' : '-f';

// Size of the terminal at ttyPath. A process outside the terminal's session
// can still ask the kernel for the window size (TIOCGWINSZ) through a tty
// handle on a throwaway descriptor, which costs a few syscalls and no fork.
// If that fails for any reason, stty can read it by path.
function ttySize(ttyPath) {
    let fd = null, stream = null;
    try {
        fd = fs.openSync(ttyPath, fs.constants.O_WRONLY | fs.constants.O_NOCTTY);
        stream = new tty.WriteStream(fd);
        const { columns, rows } = stream;
        if (columns > 0 && rows > 0) return { width: columns, height: rows };
    } catch (e) {
    } finally {
        if (stream) stream.destroy();
        if (fd !== null) { try { fs.closeSync(fd); } catch (e) {} }
    }
    try {
        const out = execFileSync('stty', [STTY_FLAG, ttyPath, 'size'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const [rows, cols] = out.trim().split(/\s+/).map(Number);
        if (rows > 0 && cols > 0) return { width: cols, height: rows };
    } catch (e) {}
    return null;
}

function setTtySize(ttyPath, width, height) {
    try {
        execFileSync('stty', [STTY_FLAG, ttyPath, 'columns', String(width), 'rows', String(height)], { stdio: 'ignore' });
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
    if (!size || size.width < 2) return false;
    if (!setTtySize(ttyPath, size.width - 1, size.height)) return false;
    return setTtySize(ttyPath, size.width, size.height);
}

const TRUECOLOR = /^(truecolor|24bit)$/i.test(process.env.COLORTERM || '');

// Nearest xterm-256 palette index for an RGB triple (6x6x6 cube plus grays).
// Cube levels are 0, 95, 135, 175, 215, 255; grays run 8..238 in steps of 10.
function nearest256([r, g, b]) {
    const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)));
    const cv = (n) => (n === 0 ? 0 : 55 + n * 40);
    const dist = (rr, gg, bb) => (rr - r) ** 2 + (gg - g) ** 2 + (bb - b) ** 2;
    const cube = 16 + 36 * q(r) + 6 * q(g) + q(b);
    const grayIdx = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
    const gl = 8 + grayIdx * 10;
    return dist(cv(q(r)), cv(q(g)), cv(q(b))) <= dist(gl, gl, gl) ? cube : 232 + grayIdx;
}

function sgr(rgb) {
    return TRUECOLOR ? `\x1B[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1B[38;5;${nearest256(rgb)}m`;
}

const SGR_RESET = '\x1B[0m';
const BLANK = SGR_RESET + ' '; // a cell we consider empty / left to Claude Code
const OCCUPIED = '\0';         // right half of a wide overlay glyph: leave alone
// Hide cursor; reset colors, clear and show the cursor again. With
// alternateScreen the rain also switches buffers on the way in and out, which
// is only useful when Claude Code is not full-screen itself.
function enterSeq(cfg) { return (cfg.alternateScreen ? '\x1B[?1049h' : '') + '\x1B[?25l'; }
function leaveSeq(cfg) { return '\x1B[0m\x1B[2J\x1B[H\x1B[?25h' + (cfg.alternateScreen ? '\x1B[?1049l' : ''); }

// Cell width of a code point as the terminal sees it: 0 for controls and
// combining marks, 2 for wide East Asian and emoji, otherwise 1.
function charWidth(cp) {
    if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0) || (cp >= 0x300 && cp < 0x370) || cp === 0x200B || cp === 0x200D || (cp >= 0xFE00 && cp <= 0xFE0F)) return 0;
    if (cp < 0x1100) return 1;
    return (cp <= 0x115F || (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) ||
        (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) ||
        (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
        (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1FAFF) ||
        (cp >= 0x20000 && cp <= 0x3FFFD)) ? 2 : 1;
}

function displayWidth(str) {
    let w = 0;
    for (const ch of str) w += charWidth(ch.codePointAt(0));
    return w;
}

// Fit `str` into `width` cells; a string that does not fit ends in an ellipsis.
function truncate(str, width) {
    if (width <= 0) return '';
    if (displayWidth(str) <= width) return str;
    let out = '';
    let w = 0;
    for (const ch of str) {
        const cw = charWidth(ch.codePointAt(0));
        if (w + cw > width - 1) break;
        out += ch;
        w += cw;
    }
    return out + '…';
}

// ---- Transcript tail: turns Claude's progress into one-line bullets ---------

class Transcript {
    constructor(file, maxLines) {
        this.file = file;
        this.maxLines = Math.max(1, maxLines | 0);
        this.offset = 0;
        this.partial = '';
        this.entries = [];
        this.changed = false;
        // A brand-new session has no transcript file yet; it appears after the
        // first message, so start from the beginning in that case.
        try { this.offset = fs.statSync(file).size; } catch (e) { this.offset = 0; }
    }

    push(kind, text) {
        text = String(text).replace(/\s+/g, ' ').trim();
        if (!text) return;
        this.entries.push({ kind, text });
        if (this.entries.length > this.maxLines) this.entries.splice(0, this.entries.length - this.maxLines);
        this.changed = true;
    }

    static summarizeTool(block) {
        const input = isPlainObject(block.input) ? block.input : {};
        const pick = input.description || input.command || input.file_path || input.pattern || input.url
            || input.query || input.prompt || input.skill || input.notebook_path || '';
        const detail = String(pick).split('\n')[0];
        const name = String(block.name || 'tool');
        return detail ? `${name}(${detail})` : name;
    }

    static firstLine(text) {
        const line = String(text).split('\n').map((l) => l.trim()).find((l) => l && !/^[#>`|\-*\d.\s]*$/.test(l)) || '';
        return line.replace(/^#+\s*/, '').replace(/\*\*|__|`/g, '');
    }

    // Read whatever was appended since the last poll. Only complete lines are
    // parsed; a trailing partial line waits for the rest.
    poll() {
        let stat;
        try { stat = fs.statSync(this.file); } catch (e) { return; }
        if (stat.size < this.offset) { this.offset = 0; this.partial = ''; } // file was replaced
        if (stat.size === this.offset) return;
        let buf;
        try {
            const fd = fs.openSync(this.file, 'r');
            try {
                buf = Buffer.alloc(stat.size - this.offset);
                fs.readSync(fd, buf, 0, buf.length, this.offset);
            } finally { fs.closeSync(fd); }
        } catch (e) { return; }
        this.offset = stat.size;
        const lines = (this.partial + buf.toString('utf8')).split('\n');
        this.partial = lines.pop();
        for (const line of lines) this.ingest(line);
    }

    ingest(line) {
        let obj;
        try { obj = JSON.parse(line); } catch (e) { return; }
        if (!isPlainObject(obj) || obj.type !== 'assistant' || obj.isSidechain) return;
        const content = isPlainObject(obj.message) && Array.isArray(obj.message.content) ? obj.message.content : [];
        for (const block of content) {
            if (!isPlainObject(block)) continue;
            if (block.type === 'text') this.push('text', Transcript.firstLine(block.text || ''));
            else if (block.type === 'tool_use') this.push('tool', Transcript.summarizeTool(block));
        }
    }
}

// ---- The rain --------------------------------------------------------------

const EMPTY_OVERLAY = new Map();

class Rain {
    constructor(cfg, width, height) {
        this.cfg = cfg;
        this.spacing = Math.max(1, cfg.columnSpacing);
        this.keepBottomRows = Math.max(0, cfg.keepBottomRows | 0);
        this.sgrHead = '\x1B[1m' + sgr(cfg.colors.head);
        this.sgrTrail = cfg.colors.trail.map(sgr);
        // Trail band i is used while v >= levelMins[i]; the last band catches the rest.
        this.levelMins = cfg.colors.trail.map((_, i, arr) => (arr.length - 1 - i) / arr.length);
        this.windingDown = false;
        this.overlay = EMPTY_OVERLAY;
        this.resize(width, height);
    }

    resize(width, height) {
        this.width = Math.max(1, width);
        this.height = Math.max(1, height);
        this.cols = Math.max(1, Math.floor(this.width / this.spacing));
        this.rainWidth = this.cols * this.spacing; // terminal columns that can carry rain
        // The bottom rows are left entirely to Claude Code: its prompt box,
        // borders and status line live there and must stay clean while you type.
        this.rainRows = Math.max(1, this.height - this.keepBottomRows);
        this.drops = Array.from({ length: this.cols }, () => ({ head: -1, speed: 1, tick: 0, active: false }));
        this.cells = Array.from({ length: this.cols }, () =>
            Array.from({ length: this.height }, () => ({ ch: ' ', v: 0, head: false })));
        // Full-grid cache of what is currently on the terminal, for diffing.
        this.drawn = Array.from({ length: this.height }, () => new Array(this.width).fill(BLANK));
        if (!this.windingDown) {
            // Start most columns already falling from a random height, and
            // scatter faded glyphs, so the screen is full from the first frame
            // instead of ramping up from an empty terminal.
            for (let c = 0; c < this.cols; c++) {
                const column = this.cells[c];
                for (let y = 0; y < this.rainRows; y++) {
                    if (Math.random() < 0.12) { column[y].v = Math.random(); column[y].ch = this.randomChar(); }
                }
                if (Math.random() < 0.85) {
                    const at = Math.floor(Math.random() * this.rainRows);
                    this.spawn(this.drops[c], at);
                    const head = column[at];
                    head.ch = this.randomChar(); head.v = 1; head.head = true;
                }
            }
        }
        this.frame = 0;
    }

    // Overlay: Map of (y * width + x) -> { ch, sgr } drawn on top of the rain.
    setOverlay(map) { this.overlay = map || EMPTY_OVERLAY; }

    randomChar() { const c = this.cfg.chars; return c[Math.floor(Math.random() * c.length)]; }

    spawn(d, at = 0) {
        const speeds = this.cfg.speeds;
        d.active = true;
        d.head = at;
        d.speed = speeds[Math.floor(Math.random() * speeds.length)];
        d.tick = 0;
    }

    // True once every drop has fallen off and every trail has faded.
    isDark() {
        for (let c = 0; c < this.cols; c++) {
            if (this.drops[c].active) return false;
            const column = this.cells[c];
            for (let y = 0; y < this.height; y++) if (column[y].v > 0) return false;
        }
        return true;
    }

    step() {
        const cfg = this.cfg;
        this.frame++;
        for (let c = 0; c < this.cols; c++) {
            const d = this.drops[c];
            const column = this.cells[c];

            for (let y = 0; y < this.height; y++) {
                const cell = column[y];
                if (cell.v > 0) {
                    cell.v = Math.max(0, cell.v - cfg.decayPerFrame);
                    if (cell.v > 0.15 && Math.random() < cfg.flickerChance) cell.ch = this.randomChar();
                }
            }

            if (!d.active) {
                // While winding down no new drops start; the ones in flight
                // keep their own pace, so the rain drains just as it fell.
                if (!this.windingDown && Math.random() < cfg.spawnChance) this.spawn(d);
                continue;
            }

            if (++d.tick < d.speed) continue;
            d.tick = 0;

            if (d.head >= 0 && d.head < this.rainRows) column[d.head].head = false;

            d.head++;
            if (d.head >= this.rainRows) {
                d.active = false;
                continue;
            }
            const cell = column[d.head];
            cell.ch = this.randomChar();
            cell.v = 1;
            cell.head = true;
        }
    }

    // Trail band index for a brightness value in (0, 1].
    trailLevel(v) {
        let i = 0;
        while (i < this.levelMins.length - 1 && v < this.levelMins[i]) i++;
        return i;
    }

    // Escape sequence for everything that changed since the last render.
    // Only rain cells and overlay cells are ever touched; every other cell,
    // including the whole protected band at the bottom, belongs to Claude
    // Code and is skipped without so much as a lookup. With
    // `full` the cache is reset first, for use after the screen was cleared.
    render(full = false) {
        if (full) for (let y = 0; y < this.height; y++) this.drawn[y].fill(BLANK);
        const overlay = this.overlay;
        const hasOverlay = overlay.size > 0;
        const spacing = this.spacing;
        let out = '';
        let curSgr = null;
        let curY = -1, curX = -1; // cursor position after the last glyph emitted
        for (let y = 0; y < this.height; y++) {
            const drawnRow = this.drawn[y];
            const base = y * this.width;
            for (let x = 0; x < this.width; x++) {
                const ov = hasOverlay ? overlay.get(base + x) : undefined;
                let sgrCode, ch;
                if (ov !== undefined) {
                    if (ov.ch === '') { drawnRow[x] = OCCUPIED; continue; }
                    sgrCode = ov.sgr;
                    ch = ov.ch;
                    drawnRow[x] = sgrCode + ch; // overlay always redraws, every frame
                } else {
                    const cell = (y < this.rainRows && x % spacing === 0 && x < this.rainWidth) ? this.cells[x / spacing][y] : null;
                    if (cell !== null && cell.v > 0) {
                        sgrCode = cell.head ? this.sgrHead : this.sgrTrail[this.trailLevel(cell.v)];
                        ch = cell.ch;
                    } else {
                        if (drawnRow[x] === BLANK) continue; // nothing of ours here
                        sgrCode = SGR_RESET;
                        ch = ' ';
                    }
                    const key = sgrCode + ch;
                    if (key === drawnRow[x]) continue;
                    drawnRow[x] = key;
                }
                if (!(y === curY && x === curX)) out += `\x1B[${y + 1};${x + 1}H`;
                if (sgrCode !== curSgr) {
                    out += SGR_RESET + (sgrCode === SGR_RESET ? '' : sgrCode);
                    curSgr = sgrCode;
                }
                out += ch;
                curY = y; curX = x + 1;
            }
        }
        return out;
    }
}

// ---- Overlay: Claude's messages and the status line, mixed into the rain ----

class Overlay {
    constructor(cfg, width, height, transcript, prompt, now = Date.now) {
        this.cfg = cfg;
        this.transcript = transcript;
        this.prompt = prompt;
        this.now = now;
        this.startedAt = now();
        this.windingDown = false;
        this.enabled = !!(cfg.messages.enabled || cfg.status.enabled);
        this.textSgr = sgr(cfg.colors.text);
        this.promptSgr = '\x1B[1m' + sgr(cfg.colors.text);
        this.bulletSgr = sgr(cfg.colors.bullet);
        this.statusSgr = sgr(cfg.colors.status);
        // Pick one verb at random and hold it, so it does not flicker mid-think.
        this.verbOffset = Math.floor(Math.random() * Math.max(1, cfg.status.verbs.length));
        this.resize(width, height);
    }

    resize(width, height) { this.width = width; this.height = height; }

    verb() {
        const st = this.cfg.status;
        if (this.windingDown) return st.windDownVerb;
        if (!st.verbs.length) return '';
        const step = Math.floor((this.now() - this.startedAt) / Math.max(1000, st.intervalMs));
        return st.verbs[(this.verbOffset + step) % st.verbs.length];
    }

    // Lay styled segments across a row from column 0, protecting only the
    // cells the text occupies so the rain still falls in the gaps around it.
    place(map, row, segments) {
        if (row < 0 || row >= this.height) return;
        let x = 0;
        for (const seg of segments) {
            for (const ch of seg.text) {
                const w = charWidth(ch.codePointAt(0));
                if (w === 0) continue;
                if (x + w > this.width) return;
                map.set(row * this.width + x, { ch, sgr: seg.sgr });
                if (w === 2) map.set(row * this.width + x + 1, { ch: '', sgr: seg.sgr });
                x += w;
            }
        }
    }

    // The overlay cell map for this frame. Messages flow from the top of the
    // screen downward, one blank line between each, and scroll up off the top
    // once they fill the space, the way Claude Code's own transcript does.
    // The status line is pinned to the last row.
    cells() {
        const cfg = this.cfg;
        if (!this.enabled || this.height < 8 || this.width < 12) return EMPTY_OVERLAY; // off, or too small to share
        const map = new Map();

        const statusRows = cfg.status.enabled ? 1 : 0;
        const avail = this.height - statusRows; // rows available to messages

        if (cfg.messages.enabled) {
            const blocks = [];
            if (cfg.messages.showPrompt && this.prompt) blocks.push({ kind: 'prompt', text: this.prompt });
            if (this.transcript) blocks.push(...this.transcript.entries.slice(-cfg.messages.lines));

            // Each block is one text line followed by a blank line. Anchor the
            // stack to the top until it overflows, then to the bottom (scroll).
            const totalRows = Math.max(0, blocks.length * 2 - 1);
            const startRow = totalRows <= avail ? 0 : avail - totalRows;

            blocks.forEach((e, i) => {
                const row = startRow + i * 2;
                if (row < 0 || row >= avail) return; // scrolled off the top or below
                const isPrompt = e.kind === 'prompt';
                const text = truncate(e.text, this.width - 2);
                this.place(map, row, [
                    { text: isPrompt ? '❯ ' : '⏺ ', sgr: isPrompt ? this.promptSgr : this.bulletSgr },
                    { text, sgr: isPrompt ? this.promptSgr : this.textSgr },
                ]);
            });
        }

        if (statusRows) {
            const secs = Math.floor((this.now() - this.startedAt) / 1000);
            this.place(map, this.height - 1, [
                { text: '✻ ', sgr: this.statusSgr },
                { text: this.verb() + '… ', sgr: this.bulletSgr },
                { text: `(${secs}s)`, sgr: this.statusSgr },
            ]);
        }
        return map;
    }
}

// ---- STOP HOOK -------------------------------------------------------------

function stopHook() {
    const input = readHookInput();
    const cfg = loadConfig(input.cwd);
    const ttyPath = resolveTty();
    if (!ttyPath) { log('stop: no tty'); process.exit(0); }

    const lockFile = lockPath(ttyPath);
    const pid = readLockPid(lockFile);
    if (pid && isRainProcess(pid)) {
        // Ask the run process to wind down: no new drops, let the rest fall.
        try { process.kill(pid, 'SIGUSR1'); } catch (e) {}
        const deadline = Date.now() + cfg.windDownMaxMs + 1500;
        while (isAlive(pid) && Date.now() < deadline) sleepMs(50);
        if (isAlive(pid)) {
            log('stop: wind-down timed out, killing');
            try { process.kill(pid, 'SIGTERM'); } catch (e) {}
            sleepMs(200);
        }
    }
    try { fs.unlinkSync(lockFile); } catch (e) {}

    // Belt and braces: if the run process could not restore the terminal,
    // do it from here (on the terminal, never on stdout).
    const fd = openTty(ttyPath);
    if (fd !== null) {
        writeTty(fd, leaveSeq(cfg));
        fs.closeSync(fd);
    }
    // The rain painted over Claude Code's screen. A resize makes it
    // repaint everything, response included.
    log(`stop: repaint nudge ${nudgeRepaint(ttyPath) ? 'sent' : 'failed'}`);
    process.exit(0);
}

// ---- START HOOK ------------------------------------------------------------

function startHook() {
    const input = readHookInput();
    const ttyPath = resolveTty();
    log(`start: tty=${ttyPath} parent=${process.ppid}${process.env.MATRIX_DEBUG ? ` (${commandOfProcess(process.ppid)})` : ''} transcript=${input.transcript_path || ''}`);
    if (!ttyPath) process.exit(0); // no terminal to draw on (CI, Windows, piped runs)

    const lockFile = lockPath(ttyPath);
    if (isRainProcess(readLockPid(lockFile))) process.exit(0); // already running on this terminal

    const child = spawn(process.execPath, [__filename, '--run'], {
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            MATRIX_TTY: ttyPath,
            MATRIX_PARENT_PID: String(process.ppid),
            MATRIX_TRANSCRIPT: typeof input.transcript_path === 'string' ? input.transcript_path : '',
            MATRIX_PROMPT: [input.prompt, input.user_prompt].find((v) => typeof v === 'string') || '',
            MATRIX_CWD: typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd(),
        },
    });
    child.unref();

    // Write PID to the lock file so the stop hook knows what process to signal.
    try { fs.writeFileSync(lockFile, String(child.pid), 'utf8'); } catch (e) { log(`start: lock write failed: ${e.code}`); }
    process.exit(0);
}

// ---- RUN: the animation loop (normally launched by --start) ----------------

function run() {
    const cfg = loadConfig(process.env.MATRIX_CWD || process.cwd());
    const ttyPath = resolveTty();
    const fd = ttyPath ? openTty(ttyPath) : null;
    if (fd === null) process.exit(0);
    const lockFile = lockPath(ttyPath);

    const parentPid = parseInt(process.env.MATRIX_PARENT_PID || '', 10) || null;
    const transcriptFile = process.env.MATRIX_TRANSCRIPT || '';
    const transcript = cfg.messages.enabled && transcriptFile ? new Transcript(transcriptFile, cfg.messages.lines) : null;
    const prompt = process.env.MATRIX_PROMPT || '';

    // Every timer is tracked so teardown can stop all of them; a lingering
    // interval is what would otherwise keep this detached process alive.
    const timers = new Set();
    const every = (ms, fn) => { const id = setInterval(fn, ms); timers.add(id); return id; };

    // Single teardown path, safe to call from any exit route (signal, error,
    // parent death, write failure, normal finish). It restores the terminal,
    // removes our lock file, and stops every timer. restoreTty() is also wired
    // to process 'exit' so even an unforeseen exit leaves the terminal usable.
    let finished = false;
    const restoreTty = () => { writeTty(fd, leaveSeq(cfg)); };
    const releaseLock = () => {
        try { if (readLockPid(lockFile) === process.pid) fs.unlinkSync(lockFile); } catch (e) {}
    };
    const finish = (why) => {
        if (finished) return;
        finished = true;
        if (why) log(`run: finishing (${why})`);
        for (const id of timers) clearInterval(id);
        timers.clear();
        restoreTty();
        releaseLock();
        try { fs.closeSync(fd); } catch (e) {}
        process.exit(0);
    };

    // Last-ditch restore: 'exit' fires no matter how we leave, and only sync
    // work runs here, so keep it to the terminal reset and the lock file.
    process.on('exit', () => { if (!finished) { restoreTty(); releaseLock(); } });
    process.on('SIGTERM', () => finish('SIGTERM'));
    process.on('SIGINT', () => finish('SIGINT'));
    process.on('SIGHUP', () => finish('SIGHUP'));    // terminal/session closed
    // A rendering bug must never leave the terminal with the cursor hidden,
    // or leave this process spinning in the background.
    process.on('uncaughtException', (e) => { log(`run: uncaught ${e && e.stack || e}`); finish('uncaughtException'); });
    process.on('unhandledRejection', (e) => { log(`run: rejection ${e}`); finish('unhandledRejection'); });

    const size = ttySize(ttyPath) || { width: 80, height: 24 };
    log(`run: tty=${ttyPath} size=${size.width}x${size.height} truecolor=${TRUECOLOR} messages=${!!transcript} status=${cfg.status.enabled}`);

    const overlay = new Overlay(cfg, size.width, size.height, transcript, prompt);
    const rain = new Rain(cfg, size.width, size.height);
    const startedAt = Date.now();
    let windDownStartedAt = null;

    // The Stop hook asks for a graceful wind-down with SIGUSR1.
    const windDown = () => {
        if (windDownStartedAt) return;
        windDownStartedAt = Date.now();
        rain.windingDown = true;
        overlay.windingDown = true;
        log('run: winding down');
    };
    process.on('SIGUSR1', windDown);

    // Park the cursor top-left so Claude Code's own spinner output, which
    // positions itself relative to the cursor, lands where the next repaint
    // sweeps it away instead of scrolling the screen.
    const PARK = '\x1B[1;1H';

    rain.setOverlay(overlay.cells());
    // If we cannot even paint the first frame, there is no usable terminal;
    // stop now rather than spin invisibly in the background.
    if (!writeTty(fd, enterSeq(cfg) + rain.render(true) + PARK)) finish('first write failed');

    // Safety nets, checked twice a second so an unexpected end is cleaned up
    // promptly: the Claude Code process that started us is gone (crash, Ctrl+C,
    // kill, or a Stop hook that never ran), or we have simply run far too long.
    every(500, () => {
        if (parentPid && !isAlive(parentPid)) finish('parent gone');
        else if (Date.now() - startedAt > cfg.maxRunMs) windDown();
    });

    // Handle terminal resizes. A process outside the terminal's session never
    // receives SIGWINCH, so poll the size instead.
    every(500, () => {
        const s = ttySize(ttyPath);
        if (!s || (s.width === overlay.width && s.height === overlay.height)) return;
        overlay.resize(s.width, s.height);
        rain.resize(s.width, s.height);
        rain.setOverlay(overlay.cells());
        if (!writeTty(fd, '\x1B[2J' + rain.render(true) + PARK)) finish('resize write failed');
    });

    if (transcript) every(250, () => transcript.poll());

    every(cfg.frameMs, () => {
        rain.step();
        rain.setOverlay(overlay.cells());
        // Incremental only: draw new rain glyphs and erase our own faded trails,
        // and leave every other cell to Claude Code. No full-screen repaint, so
        // Claude Code's messages and spinner show through without flicker.
        let out = rain.render(false);
        if (out) out += PARK;
        // The terminal went away (closed window, revoked device): stop quietly.
        if (out && !writeTty(fd, out)) { finish('write failed'); return; }

        if (windDownStartedAt && (rain.isDark() || Date.now() - windDownStartedAt > cfg.windDownMaxMs)) finish('drained');
    });
}

// ---- Entry point -----------------------------------------------------------

module.exports = {
    DEFAULTS, WIND_DOWN_CAP_MS, CONFIG_BASENAME, SGR_RESET, BLANK, OCCUPIED, TRUECOLOR,
    deepMerge, envFlag, envInt, loadConfig, lockPath, readLockPid, isAlive, isRainProcess,
    commandOfProcess, ttyOfProcess, resolveTty, ttySize, setTtySize, nudgeRepaint,
    nearest256, sgr, enterSeq, leaveSeq, charWidth, displayWidth, truncate,
    Transcript, Rain, Overlay,
};

if (require.main === module) {
    const mode = process.argv.slice(2).find((a) => a === '--start' || a === '--stop' || a === '--run');
    if (mode === '--start') startHook();
    else if (mode === '--stop') stopHook();
    else if (mode === '--run') run();
    else {
        process.stderr.write('usage: node index.js --run | --start | --stop\n'
            + '  --run    draw the rain on this terminal until Ctrl+C\n'
            + '  --start  UserPromptSubmit hook: launch the rain in the background\n'
            + '  --stop   Stop hook: wind the rain down and restore the screen\n');
        process.exit(2);
    }
}
