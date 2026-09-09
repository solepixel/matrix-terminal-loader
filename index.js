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
const { spawn, execFileSync } = require('child_process');

const LOCK_FILE = path.join(__dirname, '.matrix.lock');
const CONFIG_BASENAME = 'matrix-terminal-loader.json';

// ---- Settings --------------------------------------------------------------
//
// Defaults below can be overridden, in this order, by:
//   1. ~/.claude/matrix-terminal-loader.json           (per user)
//   2. <project>/.claude/matrix-terminal-loader.json   (per project)
//   3. plugin settings from the manifest's userConfig, which Claude Code
//      passes to hooks as CLAUDE_PLUGIN_OPTION_<KEY> environment variables
//   4. environment variables MATRIX_MESSAGES, MATRIX_STATUS, MATRIX_WIND_DOWN_MS
// Any subset of keys may be given in the JSON files; nested objects are merged.

const DEFAULTS = {
    frameMs: 50,                // 20 frames per second
    columnSpacing: 2,           // one stream every N terminal cells
    spawnChance: 0.03,          // chance per frame that an idle column starts a drop
    decayPerFrame: 0.035,       // how fast a trail fades (about 1.4 s at 20 fps)
    flickerChance: 0.02,        // chance per frame that a lit cell swaps its glyph
    speeds: [1, 1, 2, 2, 3],    // frames per step; picked at random per drop
    windDownMaxMs: 5000,        // longest the wind-down may take once Claude is done
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

function deepMerge(base, extra) {
    if (extra === undefined || extra === null) return base;
    if (typeof extra !== 'object' || Array.isArray(extra)) return extra;
    const out = { ...base };
    for (const [k, v] of Object.entries(extra)) {
        out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object')
            ? deepMerge(base[k], v) : v;
    }
    return out;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function envFlag(name) {
    const v = process.env[name];
    if (v === undefined || v === '') return undefined;
    return !/^(0|false|no|off)$/i.test(v);
}

function loadConfig(cwd) {
    let cfg = DEFAULTS;
    cfg = deepMerge(cfg, readJson(path.join(os.homedir(), '.claude', CONFIG_BASENAME)));
    if (cwd) cfg = deepMerge(cfg, readJson(path.join(cwd, '.claude', CONFIG_BASENAME)));
    // Plugin settings (userConfig in plugin.json) arrive as environment variables.
    const optFlag = (key) => envFlag(`CLAUDE_PLUGIN_OPTION_${key}`);
    const optInt = (key) => { const n = parseInt(process.env[`CLAUDE_PLUGIN_OPTION_${key}`] || '', 10); return Number.isFinite(n) ? n : undefined; };
    const pm = optFlag('SHOW_MESSAGES'); if (pm !== undefined) cfg.messages.enabled = pm;
    const pl = optInt('MESSAGE_LINES'); if (pl !== undefined && pl > 0) cfg.messages.lines = pl;
    const ps = optFlag('SHOW_STATUS'); if (ps !== undefined) cfg.status.enabled = ps;
    const pw = optInt('WIND_DOWN_MS'); if (pw !== undefined && pw >= 0) cfg.windDownMaxMs = pw;
    const pv = process.env.CLAUDE_PLUGIN_OPTION_STATUS_VERBS;
    if (pv && pv.trim()) cfg.status.verbs = pv.split('|').map((v) => v.trim()).filter(Boolean);
    // Plain environment variables win over everything.
    const m = envFlag('MATRIX_MESSAGES'); if (m !== undefined) cfg.messages.enabled = m;
    const st = envFlag('MATRIX_STATUS'); if (st !== undefined) cfg.status.enabled = st;
    const w = parseInt(process.env.MATRIX_WIND_DOWN_MS || '', 10); if (w >= 0) cfg.windDownMaxMs = w;
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
        return raw.trim() ? JSON.parse(raw) : {};
    } catch (e) {
        return {};
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
// cannot ioctl it from Node, but stty can read it by path.
function ttySize(ttyPath) {
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
    if (!size) return false;
    if (!setTtySize(ttyPath, size.width - 1, size.height)) return false;
    return setTtySize(ttyPath, size.width, size.height);
}

const TRUECOLOR = /^(truecolor|24bit)$/i.test(process.env.COLORTERM || '');

// Nearest xterm-256 palette index for an RGB triple (6x6x6 cube plus grays).
function nearest256([r, g, b]) {
    const q = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.round((v - 35) / 40));
    const cube = 16 + 36 * q(r) + 6 * q(g) + q(b);
    const avg = (r + g + b) / 3;
    const gray = 232 + Math.round(Math.max(0, Math.min(23, (avg - 8) / 10)));
    const dist = (i, rr, gg, bb) => (rr - r) ** 2 + (gg - g) ** 2 + (bb - b) ** 2;
    const cv = (n) => (n === 0 ? 0 : 55 + n * 40);
    const dc = dist(cube, cv(q(r)), cv(q(g)), cv(q(b)));
    const gl = 8 + (gray - 232) * 10;
    return dc <= dist(gray, gl, gl, gl) ? cube : gray;
}

function sgr(rgb) {
    return TRUECOLOR ? `\x1B[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\x1B[38;5;${nearest256(rgb)}m`;
}

const SGR_RESET = '\x1B[0m';
const BLANK = SGR_RESET + ' '; // a cell we consider empty / left to Claude Code
// Hide cursor and clear the screen; reset colors, clear and show the cursor
// again. With alternateScreen the rain also switches buffers on the way in
// and out, which is only useful when Claude Code is not full-screen itself.
function enterSeq(cfg) { return (cfg.alternateScreen ? '\x1B[?1049h' : '') + '\x1B[?25l'; }
function leaveSeq(cfg) { return '\x1B[0m\x1B[2J\x1B[H\x1B[?25h' + (cfg.alternateScreen ? '\x1B[?1049l' : ''); }

// Cell width of a string as the terminal sees it (wide CJK counts double).
function displayWidth(str) {
    let w = 0;
    for (const ch of str) {
        const cp = ch.codePointAt(0);
        if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0) || (cp >= 0x300 && cp < 0x370)) continue;
        w += (cp >= 0x1100 && (
            cp <= 0x115F || (cp >= 0x2E80 && cp <= 0xA4CF && cp !== 0x303F) ||
            (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) ||
            (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
            (cp >= 0xFFE0 && cp <= 0xFFE6) || (cp >= 0x1F300 && cp <= 0x1FAFF) ||
            (cp >= 0x20000 && cp <= 0x3FFFD))) ? 2 : 1;
    }
    return w;
}

function truncate(str, width) {
    let out = '';
    let w = 0;
    for (const ch of str) {
        const cw = displayWidth(ch);
        if (w + cw > width - 1) return out + '…';
        out += ch;
        w += cw;
    }
    return out;
}

// ---- Transcript tail: turns Claude's progress into one-line bullets ---------

class Transcript {
    constructor(file, maxLines) {
        this.file = file;
        this.maxLines = maxLines;
        this.offset = 0;
        this.partial = '';
        this.entries = [];
        this.changed = false;
        // A brand-new session has no transcript file yet; it appears after the
        // first message, so start from the beginning in that case.
        try { this.offset = fs.statSync(file).size; } catch (e) { this.offset = 0; }
    }

    push(kind, text) {
        text = text.replace(/\s+/g, ' ').trim();
        if (!text) return;
        this.entries.push({ kind, text });
        if (this.entries.length > this.maxLines) this.entries.splice(0, this.entries.length - this.maxLines);
        this.changed = true;
    }

    static summarizeTool(block) {
        const input = block.input || {};
        const pick = input.description || input.command || input.file_path || input.pattern || input.url
            || input.query || input.prompt || input.skill || input.notebook_path || '';
        const detail = String(pick).split('\n')[0];
        return detail ? `${block.name}(${detail})` : block.name;
    }

    static firstLine(text) {
        const line = text.split('\n').map((l) => l.trim()).find((l) => l && !/^[#>`|\-*\d.\s]*$/.test(l)) || '';
        return line.replace(/^#+\s*/, '').replace(/\*\*|__|`/g, '');
    }

    poll() {
        let stat;
        try { stat = fs.statSync(this.file); } catch (e) { return; }
        if (stat.size < this.offset) this.offset = 0; // file was replaced
        if (stat.size === this.offset) return;
        const fd = fs.openSync(this.file, 'r');
        const buf = Buffer.alloc(stat.size - this.offset);
        fs.readSync(fd, buf, 0, buf.length, this.offset);
        fs.closeSync(fd);
        this.offset = stat.size;
        const chunk = this.partial + buf.toString('utf8');
        const lines = chunk.split('\n');
        this.partial = lines.pop();
        for (const line of lines) {
            let obj;
            try { obj = JSON.parse(line); } catch (e) { continue; }
            if (obj.type !== 'assistant' || obj.isSidechain) continue;
            for (const block of obj.message && Array.isArray(obj.message.content) ? obj.message.content : []) {
                if (block.type === 'text') this.push('text', Transcript.firstLine(block.text || ''));
                else if (block.type === 'tool_use') this.push('tool', Transcript.summarizeTool(block));
            }
        }
    }
}

// ---- The rain --------------------------------------------------------------

class Rain {
    constructor(cfg, width, height) {
        this.cfg = cfg;
        this.spacing = Math.max(1, cfg.columnSpacing);
        this.sgrHead = '\x1B[1m' + sgr(cfg.colors.head);
        this.sgrTrail = cfg.colors.trail.map(sgr);
        this.levelMins = cfg.colors.trail.map((_, i, arr) => (arr.length - 1 - i) / arr.length);
        this.windingDown = false;
        this.overlay = new Map();
        this.resize(width, height);
    }

    resize(width, height) {
        this.width = Math.max(1, width);
        this.height = Math.max(1, height);
        this.cols = Math.max(1, Math.floor(this.width / this.spacing));
        this.drops = Array.from({ length: this.cols }, () => ({ head: -1, speed: 1, tick: 0, active: false }));
        this.cells = Array.from({ length: this.cols }, () =>
            Array.from({ length: this.height }, () => ({ ch: ' ', v: 0, head: false })));
        // Full-grid cache of what is currently on the terminal, for diffing.
        this.drawn = Array.from({ length: this.height }, () => new Array(this.width).fill(BLANK));
        if (!this.windingDown) {
            // Start most columns already falling from a random height, and
            // scatter faded glyphs, so the screen is full from the first frame
            // instead of ramping up from an empty terminal.
            for (const d of this.drops) {
                if (Math.random() < 0.85) this.spawn(d, Math.floor(Math.random() * this.height));
            }
            for (let c = 0; c < this.cols; c++) {
                const column = this.cells[c];
                for (let y = 0; y < this.height; y++) {
                    if (Math.random() < 0.12) { column[y].v = Math.random(); column[y].ch = this.randomChar(); }
                }
            }
        }
        this.frame = 0;
    }

    // Overlay: Map of (y * width + x) -> { ch, sgr } drawn on top of the rain.
    setOverlay(map) { this.overlay = map; }

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

            if (d.head >= 0 && d.head < this.height) column[d.head].head = false;

            d.head++;
            if (d.head >= this.height) {
                d.active = false;
                continue;
            }
            const cell = column[d.head];
            cell.ch = this.randomChar();
            cell.v = 1;
            cell.head = true;
        }
    }

    // Desired rain glyph at rain column c, row y; null when that cell is dark.
    rainGlyph(c, y) {
        const cell = this.cells[c][y];
        if (cell.v <= 0) return null;
        if (cell.head) return { sgr: this.sgrHead, ch: cell.ch };
        let i = 0;
        while (i < this.levelMins.length - 1 && cell.v < this.levelMins[i]) i++;
        return { sgr: this.sgrTrail[i], ch: cell.ch };
    }

    // Escape sequence for everything that changed since the last render.
    // A full render erases anything Claude Code drew underneath by emitting a
    // space for every blank cell, without a screen clear, so there is no flash.
    // Overlay cells (messages, status) sit on top and are redrawn every frame.
    render(full = false) {
        const OCCUPIED = '\0'; // right half of a wide overlay glyph: leave alone
        if (full) for (let y = 0; y < this.height; y++) this.drawn[y].fill(BLANK); // screen was cleared
        let out = '';
        let curSgr = null;
        let curY = -1, curX = -1; // cursor position after the last glyph emitted
        for (let y = 0; y < this.height; y++) {
            const drawnRow = this.drawn[y];
            const base = y * this.width;
            for (let x = 0; x < this.width; x++) {
                const ov = this.overlay.get(base + x);
                let sgrCode, ch, always = false;
                if (ov) {
                    if (ov.ch === '') { drawnRow[x] = OCCUPIED; curX = -1; continue; }
                    sgrCode = ov.sgr;
                    ch = ov.ch;
                    always = true; // overlay always wins, every frame
                } else {
                    const g = (x % this.spacing === 0 && x / this.spacing < this.cols)
                        ? this.rainGlyph(x / this.spacing, y) : null;
                    if (g) { sgrCode = g.sgr; ch = g.ch; }
                    else { sgrCode = SGR_RESET; ch = ' '; }
                }
                const key = sgrCode + ch;
                if (!always && key === drawnRow[x]) { curX = -1; continue; }
                drawnRow[x] = key;
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
    constructor(cfg, width, height, transcript, prompt) {
        this.cfg = cfg;
        this.transcript = transcript;
        this.prompt = prompt;
        this.startedAt = Date.now();
        this.windingDown = false;
        // Pick one verb at random and hold it, so it does not flicker mid-think.
        this.verbOffset = Math.floor(Math.random() * Math.max(1, cfg.status.verbs.length));
        this.resize(width, height);
    }

    resize(width, height) { this.width = width; this.height = height; }

    verb() {
        const st = this.cfg.status;
        if (this.windingDown) return st.windDownVerb;
        if (!st.verbs.length) return '';
        const step = Math.floor((Date.now() - this.startedAt) / Math.max(1000, st.intervalMs));
        return st.verbs[(this.verbOffset + step) % st.verbs.length];
    }

    // Lay styled segments across a row from column 0, protecting only the
    // cells the text occupies so the rain still falls in the gaps around it.
    place(map, row, segments) {
        if (row < 0 || row >= this.height) return;
        let x = 0;
        for (const seg of segments) {
            for (const ch of seg.text) {
                const w = displayWidth(ch);
                if (w === 0) continue;
                if (x >= this.width) return;
                map.set(row * this.width + x, { ch, sgr: seg.sgr });
                if (w === 2 && x + 1 < this.width) map.set(row * this.width + x + 1, { ch: '', sgr: seg.sgr });
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
        const map = new Map();
        if (this.height < 8 || this.width < 12) return map; // too small to share

        const statusRows = cfg.status.enabled ? 1 : 0;
        const avail = this.height - statusRows; // rows available to messages

        if (cfg.messages.enabled) {
            const textSgr = sgr(cfg.colors.text);
            const promptSgr = '\x1B[1m' + sgr(cfg.colors.text);
            const bulletSgr = sgr(cfg.colors.bullet);

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
                const marker = isPrompt ? '❯ ' : '⏺ ';
                const text = truncate(e.text, this.width - 2);
                this.place(map, row, [
                    { text: marker, sgr: isPrompt ? promptSgr : bulletSgr },
                    { text, sgr: isPrompt ? promptSgr : textSgr },
                ]);
            });
        }

        if (statusRows) {
            const secs = Math.floor((Date.now() - this.startedAt) / 1000);
            const stColor = sgr(cfg.colors.status);
            const vbColor = sgr(cfg.colors.bullet);
            this.place(map, this.height - 1, [
                { text: '✻ ', sgr: stColor },
                { text: this.verb() + '… ', sgr: vbColor },
                { text: `(${secs}s)`, sgr: stColor },
            ]);
        }
        return map;
    }
}

// ---- STOP HOOK -------------------------------------------------------------

if (process.argv.includes('--stop')) {
    const input = readHookInput();
    const cfg = loadConfig(input.cwd);
    const pid = readLockPid();
    const ttyPath = resolveTty();

    if (pid && isAlive(pid)) {
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
    try { fs.unlinkSync(LOCK_FILE); } catch (e) {}

    if (ttyPath) {
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
    }
    process.exit(0);
}

// ---- START HOOK ------------------------------------------------------------

if (process.argv.includes('--start')) {
    const input = readHookInput();
    const existing = readLockPid();
    if (existing && isAlive(existing)) process.exit(0); // already running

    const ttyPath = resolveTty();
    log(`start: tty=${ttyPath} transcript=${input.transcript_path || ''}`);
    if (!ttyPath) process.exit(0); // no terminal to draw on (CI, Windows, piped runs)

    const child = spawn(process.execPath, [__filename, '--run'], {
        detached: true,
        stdio: 'ignore',
        env: {
            ...process.env,
            MATRIX_TTY: ttyPath,
            MATRIX_PARENT_PID: String(process.ppid),
            MATRIX_TRANSCRIPT: input.transcript_path || '',
            MATRIX_PROMPT: [input.user_prompt, input.prompt].find((v) => typeof v === 'string') || '',
            MATRIX_CWD: input.cwd || process.cwd(),
        },
    });
    child.unref();

    // Write PID to lockfile so the stop hook knows what process to signal
    fs.writeFileSync(LOCK_FILE, String(child.pid), 'utf8');
    process.exit(0);
}

// ---- RUN: the animation loop (normally launched by --start) ----------------

if (process.argv.includes('--run')) {
    const cfg = loadConfig(process.env.MATRIX_CWD || process.cwd());
    const ttyPath = resolveTty();
    const fd = ttyPath ? openTty(ttyPath) : null;
    if (fd === null) process.exit(0);

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
    const restoreTty = () => {
        writeTty(fd, leaveSeq(cfg)); // non-blocking; a wedged terminal drops it
    };
    const releaseLock = () => {
        try { if (readLockPid() === process.pid) fs.unlinkSync(LOCK_FILE); } catch (e) {}
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
    // A rendering bug must never leave the terminal in the alternate screen
    // with the cursor hidden, or leave this process spinning in the background.
    process.on('uncaughtException', (e) => { log(`run: uncaught ${e && e.stack || e}`); finish('uncaughtException'); });
    process.on('unhandledRejection', (e) => { log(`run: rejection ${e}`); finish('unhandledRejection'); });

    const size = ttySize(ttyPath) || { width: 80, height: 24 };
    log(`run: tty=${ttyPath} size=${size.width}x${size.height} truecolor=${TRUECOLOR} messages=${!!transcript}`);

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
    if (!writeTty(fd, enterSeq(cfg) + rain.render(true) + PARK)) { finish('first write failed'); }

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
