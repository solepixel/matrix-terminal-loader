'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const m = require('../index.js');

const ESC = '\x1B';
const CSI_MOVE = /\x1B\[(\d+);(\d+)H/g;

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `mtl-${prefix}-`));
}

// Deterministic Math.random for the duration of fn(); restored afterwards.
// `values` is either an array cycled through, or a numeric seed for a PRNG.
function withRandom(values, fn) {
    const orig = Math.random;
    if (typeof values === 'number') {
        let s = values >>> 0;
        Math.random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    } else {
        let i = 0;
        Math.random = () => values[i++ % values.length];
    }
    try { return fn(); } finally { Math.random = orig; }
}

// ---- settings ---------------------------------------------------------------

test('deepMerge copies nested objects and never aliases or mutates its inputs', () => {
    const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] };
    const out = m.deepMerge(base, { nested: { y: 3 }, list: [9], extra: { z: 1 } });
    assert.deepEqual(out, { a: 1, nested: { x: 1, y: 3 }, list: [9], extra: { z: 1 } });
    assert.notEqual(out.nested, base.nested);
    assert.deepEqual(base, { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] });
    // null / undefined extras still yield an independent deep copy
    const copy = m.deepMerge(base, null);
    assert.deepEqual(copy, base);
    assert.notEqual(copy.nested, base.nested);
});

test('envFlag and envInt parse hook environment values', () => {
    const env = { A: '1', B: 'false', C: 'off', D: '', E: ' yes ', N: '42', X: 'abc' };
    assert.equal(m.envFlag(env, 'A'), true);
    assert.equal(m.envFlag(env, 'B'), false);
    assert.equal(m.envFlag(env, 'C'), false);
    assert.equal(m.envFlag(env, 'D'), undefined);
    assert.equal(m.envFlag(env, 'E'), true);
    assert.equal(m.envFlag(env, 'MISSING'), undefined);
    assert.equal(m.envInt(env, 'N'), 42);
    assert.equal(m.envInt(env, 'X'), undefined);
});

test('loadConfig returns the defaults without mutating DEFAULTS', () => {
    const before = JSON.stringify(m.DEFAULTS);
    const cfg = m.loadConfig(null, { env: { MATRIX_MESSAGES: '1', MATRIX_STATUS: '1' }, homeDir: path.join(os.tmpdir(), 'no-such-home') });
    assert.equal(cfg.messages.enabled, true);
    assert.equal(cfg.status.enabled, true);
    assert.equal(JSON.stringify(m.DEFAULTS), before);
    assert.equal(m.DEFAULTS.messages.enabled, false);
});

test('loadConfig precedence: defaults < user file < project file < plugin options < env vars', () => {
    const home = tmpDir('home');
    const project = tmpDir('proj');
    fs.mkdirSync(path.join(home, '.claude'));
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', m.CONFIG_BASENAME), JSON.stringify({
        frameMs: 100, windDownMaxMs: 1000, messages: { lines: 5 }, status: { enabled: true },
    }));
    fs.writeFileSync(path.join(project, '.claude', m.CONFIG_BASENAME), JSON.stringify({
        frameMs: 75, colors: { head: [1, 2, 3] },
    }));

    let cfg = m.loadConfig(project, { env: {}, homeDir: home });
    assert.equal(cfg.frameMs, 75, 'project file beats user file');
    assert.equal(cfg.windDownMaxMs, 1000, 'user file beats defaults');
    assert.equal(cfg.messages.lines, 5);
    assert.equal(cfg.messages.enabled, false, 'untouched nested keys keep their defaults');
    assert.equal(cfg.status.enabled, true);
    assert.deepEqual(cfg.colors.head, [1, 2, 3]);
    assert.deepEqual(cfg.colors.trail, m.DEFAULTS.colors.trail, 'sibling keys survive a partial nested override');

    cfg = m.loadConfig(project, {
        homeDir: home,
        env: {
            CLAUDE_PLUGIN_OPTION_SHOW_MESSAGES: 'true',
            CLAUDE_PLUGIN_OPTION_MESSAGE_LINES: '7',
            CLAUDE_PLUGIN_OPTION_SHOW_STATUS: 'false',
            CLAUDE_PLUGIN_OPTION_WIND_DOWN_MS: '2500',
            CLAUDE_PLUGIN_OPTION_STATUS_VERBS: ' Jacking in | Bending spoons ||',
        },
    });
    assert.equal(cfg.messages.enabled, true, 'plugin option beats files');
    assert.equal(cfg.messages.lines, 7);
    assert.equal(cfg.status.enabled, false);
    assert.equal(cfg.windDownMaxMs, 2500);
    assert.deepEqual(cfg.status.verbs, ['Jacking in', 'Bending spoons']);

    cfg = m.loadConfig(project, {
        homeDir: home,
        env: {
            CLAUDE_PLUGIN_OPTION_SHOW_MESSAGES: 'true',
            CLAUDE_PLUGIN_OPTION_WIND_DOWN_MS: '2500',
            MATRIX_MESSAGES: '0', MATRIX_STATUS: 'on', MATRIX_WIND_DOWN_MS: '0',
        },
    });
    assert.equal(cfg.messages.enabled, false, 'env var beats plugin option');
    assert.equal(cfg.status.enabled, true);
    assert.equal(cfg.windDownMaxMs, 0, 'MATRIX_WIND_DOWN_MS=0 makes the stop instant');
});

test('loadConfig clamps unusable values', () => {
    const home = tmpDir('home2');
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', m.CONFIG_BASENAME), JSON.stringify({
        windDownMaxMs: 999999, columnSpacing: 0, frameMs: 1, chars: '', speeds: [], status: { verbs: 'nope' },
    }));
    const cfg = m.loadConfig(null, { env: {}, homeDir: home });
    assert.equal(cfg.windDownMaxMs, m.WIND_DOWN_CAP_MS);
    assert.equal(cfg.columnSpacing, 1);
    assert.equal(cfg.frameMs, 10);
    assert.equal(cfg.chars, m.DEFAULTS.chars);
    assert.deepEqual(cfg.speeds, m.DEFAULTS.speeds);
    assert.deepEqual(cfg.status.verbs, m.DEFAULTS.status.verbs);
    // a malformed JSON file is ignored, not fatal
    fs.writeFileSync(path.join(home, '.claude', m.CONFIG_BASENAME), '{ not json');
    assert.equal(m.loadConfig(null, { env: {}, homeDir: home }).frameMs, m.DEFAULTS.frameMs);
});

test('lockPath is per terminal and lives in the temp dir', () => {
    const a = m.lockPath('/dev/ttys005');
    const b = m.lockPath('/dev/pts/3');
    assert.notEqual(a, b);
    assert.equal(path.dirname(a), os.tmpdir());
    assert.match(path.basename(a), /^matrix-terminal-loader-ttys005\.lock$/);
    assert.match(path.basename(b), /^matrix-terminal-loader-pts-3\.lock$/);
});

test('isAlive and isRainProcess', () => {
    assert.equal(m.isAlive(process.pid), true);
    assert.equal(m.isAlive(2147483646), false);
    assert.equal(m.isRainProcess(null), false);
    assert.equal(m.isRainProcess(2147483646), false);
    // A live process that is not the rain (this test runner) must not count.
    assert.equal(m.isRainProcess(process.pid), false);
});

// ---- colors ---------------------------------------------------------------

test('nearest256 maps the palette onto valid xterm-256 indices', () => {
    for (const rgb of [[0, 255, 65], [0, 190, 50], [0, 125, 35], [0, 70, 20], [220, 255, 220], [200, 200, 200], [0, 0, 0], [255, 255, 255]]) {
        const idx = m.nearest256(rgb);
        assert.ok(Number.isInteger(idx) && idx >= 16 && idx <= 255, `${rgb} -> ${idx}`);
    }
    assert.equal(m.nearest256([0, 255, 0]), 46, 'pure green is cube index 46');
    assert.equal(m.nearest256([255, 255, 255]), 231, 'white lands on the cube corner');
    assert.equal(m.nearest256([0, 0, 0]), 16);
    assert.equal(m.nearest256([128, 128, 128]), 244, 'mid gray uses the gray ramp');
    // Regression: 255 on any channel used to round to cube level 6 and spill
    // into the next red step (index 53, a purple, for Matrix green).
    assert.equal(m.nearest256([0, 255, 65]), 47);
});

test('sgr emits a 24-bit or 256-color sequence depending on COLORTERM', () => {
    const s = m.sgr([0, 255, 65]);
    assert.ok(s === `${ESC}[38;2;0;255;65m` || s === `${ESC}[38;5;47m`, s);
    assert.equal(s.startsWith(`${ESC}[38;2;`), m.TRUECOLOR);
});

test('enter and leave sequences hide/show the cursor and optionally switch buffers', () => {
    assert.equal(m.enterSeq({ alternateScreen: false }), `${ESC}[?25l`);
    assert.equal(m.leaveSeq({ alternateScreen: false }), `${ESC}[0m${ESC}[2J${ESC}[H${ESC}[?25h`);
    assert.equal(m.enterSeq({ alternateScreen: true }), `${ESC}[?1049h${ESC}[?25l`);
    assert.ok(m.leaveSeq({ alternateScreen: true }).endsWith(`${ESC}[?1049l`));
});

// ---- text measurement -------------------------------------------------------

test('displayWidth counts terminal cells', () => {
    assert.equal(m.displayWidth('abc'), 3);
    assert.equal(m.displayWidth('ｱｲｳ'), 3, 'half-width katakana are one cell');
    assert.equal(m.displayWidth('日本'), 4, 'CJK ideographs are two cells');
    assert.equal(m.displayWidth('é'), 1, 'combining marks are zero width');
    assert.equal(m.displayWidth('a​b'), 2, 'zero-width space');
    assert.equal(m.displayWidth('❯ ⏺ ✻'), 5);
    assert.equal(m.displayWidth('🌧'), 2);
    assert.equal(m.displayWidth(''), 0);
});

test('truncate keeps strings that fit and ends longer ones with an ellipsis', () => {
    assert.equal(m.truncate('abcde', 5), 'abcde', 'exact fit is not truncated');
    assert.equal(m.truncate('abcdef', 5), 'abcd…');
    assert.equal(m.truncate('日本語', 4), '日…', 'wide glyph that would straddle the edge is dropped');
    assert.equal(m.truncate('日本', 4), '日本');
    assert.equal(m.truncate('abc', 0), '');
    assert.equal(m.truncate('', 10), '');
    for (const w of [1, 2, 3, 8, 20]) assert.ok(m.displayWidth(m.truncate('the quick brown fox 日本語', w)) <= w, `width ${w}`);
});

// ---- transcript -----------------------------------------------------------

function line(obj) { return JSON.stringify(obj) + '\n'; }
const assistant = (content, extra = {}) => line({ type: 'assistant', message: { content }, ...extra });

test('Transcript turns assistant text and tool calls into one-line entries', () => {
    const dir = tmpDir('tr');
    const file = path.join(dir, 't.jsonl');
    const t = new m.Transcript(file, 3);
    assert.deepEqual(t.entries, []);
    t.poll(); // file does not exist yet: fine

    fs.writeFileSync(file, [
        line({ type: 'user', message: { content: 'hi' } }),
        assistant([{ type: 'text', text: '## Heading\n\nI will **read** the `file` now.\nmore' }]),
        assistant([{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/x.js' } }]),
        assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la\nrm x', description: 'List files' } }]),
        assistant([{ type: 'text', text: 'ignored' }], { isSidechain: true }),
        'not json at all\n',
        line({ type: 'assistant', message: { content: 'a string, not blocks' } }),
    ].join(''));
    t.poll();
    assert.deepEqual(t.entries, [
        { kind: 'text', text: 'Heading' },
        { kind: 'tool', text: 'Read(/tmp/x.js)' },
        { kind: 'tool', text: 'Bash(List files)' },
    ], 'capped to maxLines, oldest dropped, sidechain and garbage ignored');
    assert.equal(t.changed, true);

    // A partial trailing line waits for the rest of it.
    const chunk = assistant([{ type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } }]);
    fs.appendFileSync(file, chunk.slice(0, 20));
    t.poll();
    assert.equal(t.entries.length, 3);
    assert.equal(t.entries[2].text, 'Bash(List files)');
    fs.appendFileSync(file, chunk.slice(20));
    t.poll();
    assert.equal(t.entries[2].text, 'Grep(TODO)');

    // A replaced (shorter) file is read from the start again.
    fs.writeFileSync(file, assistant([{ type: 'tool_use', name: 'Edit', input: {} }]));
    t.poll();
    assert.equal(t.entries[2].text, 'Edit');
});

test('Transcript starts at the end of an existing file', () => {
    const dir = tmpDir('tr2');
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, assistant([{ type: 'text', text: 'old news' }]));
    const t = new m.Transcript(file, 10);
    t.poll();
    assert.deepEqual(t.entries, []);
    fs.appendFileSync(file, assistant([{ type: 'text', text: 'fresh' }]));
    t.poll();
    assert.deepEqual(t.entries, [{ kind: 'text', text: 'fresh' }]);
});

test('Transcript.firstLine skips markup-only lines and strips formatting', () => {
    assert.equal(m.Transcript.firstLine('---\n\n- \n### Done: **it** `works`'), 'Done: it works');
    assert.equal(m.Transcript.firstLine(''), '');
    assert.equal(m.Transcript.summarizeTool({ name: 'Skill', input: { skill: 'commit' } }), 'Skill(commit)');
    assert.equal(m.Transcript.summarizeTool({ name: 'X', input: 'bad' }), 'X');
    assert.equal(m.Transcript.summarizeTool({}), 'tool');
});

// ---- rain -------------------------------------------------------------------

function baseCfg(over = {}) {
    return m.deepMerge(m.loadConfig(null, { env: {}, homeDir: path.join(os.tmpdir(), 'no-such-home') }), over);
}

// Parse the cursor moves out of a render and return every (row, col) written.
function writtenCells(out) {
    const cells = [];
    let y = 0, x = 0;
    const re = /\x1B\[(\d+);(\d+)H|\x1B\[[0-9;]*m|([^\x1B])/g;
    let mm;
    while ((mm = re.exec(out)) !== null) {
        if (mm[1] !== undefined) { y = +mm[1] - 1; x = +mm[2] - 1; }
        else if (mm[3] !== undefined) { cells.push({ y, x, ch: mm[3] }); x += m.charWidth(mm[3].codePointAt(0)); }
    }
    return cells;
}

test('Rain only ever writes rain columns and its first frame is dense', () => {
    const cfg = baseCfg({ columnSpacing: 2, keepBottomRows: 0 });
    const rain = withRandom(12345, () => new m.Rain(cfg, 41, 12));
    assert.equal(rain.cols, 20);
    const out = rain.render(true);
    const cells = writtenCells(out);
    // 20 columns: ~85% carry a lit head and ~12% of cells carry a faded glyph.
    assert.ok(cells.length >= 30, `expected a dense first frame, got ${cells.length} cells`);
    assert.ok(rain.drops.filter((d) => d.active).length >= 12, 'most columns start mid-fall');
    for (const c of cells) {
        assert.equal(c.x % 2, 0, `column ${c.x} is not a rain column`);
        assert.ok(c.x < 40 && c.y < 12);
        assert.ok(cfg.chars.includes(c.ch) || c.ch === ' ', `unexpected glyph ${JSON.stringify(c.ch)}`);
    }
    assert.ok(out.includes(`${ESC}[1m`), 'a bright head is drawn in bold');
    assert.equal(rain.render(false), '', 'nothing changed: incremental render is empty');
});

test('Rain steps drops downward, fades trails, and drains when winding down', () => {
    const cfg = baseCfg({ columnSpacing: 1, keepBottomRows: 0, speeds: [1], spawnChance: 0, flickerChance: 0 });
    const rain = withRandom([0.99], () => new m.Rain(cfg, 3, 6)); // nothing seeded
    assert.equal(rain.isDark(), true);
    rain.render(true);
    withRandom([0], () => rain.spawn(rain.drops[1], 0));
    let out = withRandom([0], () => { rain.step(); return rain.render(false); });
    let cells = writtenCells(out);
    assert.deepEqual(cells.map((c) => [c.y, c.x]), [[1, 1]], 'head moved to row 1 of column 1');
    out = withRandom([0], () => { rain.step(); return rain.render(false); });
    cells = writtenCells(out);
    assert.deepEqual(cells.map((c) => [c.y, c.x]).sort(), [[1, 1], [2, 1]], 'old head redrawn as trail, new head below');

    rain.windingDown = true;
    let frames = 0;
    while (!rain.isDark() && frames < 200) { withRandom([0.99], () => rain.step()); rain.render(false); frames++; }
    assert.equal(rain.isDark(), true, 'the rain drains on its own while winding down');
    assert.ok(frames > 5 && frames < 200, `drained in ${frames} frames`);
    // Everything the rain drew has been erased with spaces by now.
    const drawn = rain.drawn.flat();
    assert.ok(drawn.every((k) => k === m.BLANK), 'screen cache is all blank after draining');
});

test('Rain never touches the protected rows at the bottom', () => {
    const cfg = baseCfg({ columnSpacing: 1, keepBottomRows: 4, speeds: [1], spawnChance: 1, flickerChance: 0 });
    const rain = withRandom(777, () => new m.Rain(cfg, 6, 10));
    assert.equal(rain.rainRows, 6);
    const rows = new Set();
    for (const c of writtenCells(rain.render(true))) rows.add(c.y);
    for (let i = 0; i < 60; i++) {
        withRandom(i, () => rain.step());
        for (const c of writtenCells(rain.render(false))) rows.add(c.y);
    }
    assert.ok(rows.size > 0);
    assert.ok([...rows].every((y) => y < 6), `rows written: ${[...rows].sort()}`);
    assert.ok(rows.has(5), 'the last rain row is used');
    // Overlay cells are still allowed anywhere (they are opt-in and explicit).
    rain.setOverlay(new Map([[9 * 6 + 0, { ch: 'S', sgr: m.SGR_RESET }]]));
    assert.deepEqual(writtenCells(rain.render(false)).map((c) => [c.y, c.x, c.ch]), [[9, 0, 'S']]);
    // A terminal shorter than the band still gets one row of rain.
    const tiny = withRandom(1, () => new m.Rain(cfg, 6, 3));
    assert.equal(tiny.rainRows, 1);
    const cfg0 = baseCfg({ keepBottomRows: 0 });
    assert.equal(new m.Rain(cfg0, 10, 10).rainRows, 10);
});

test('loadConfig reads keepBottomRows from the plugin option and env var', () => {
    const home = path.join(os.tmpdir(), 'no-such-home');
    assert.equal(m.loadConfig(null, { env: {}, homeDir: home }).keepBottomRows, 6);
    assert.equal(m.loadConfig(null, { env: { CLAUDE_PLUGIN_OPTION_KEEP_BOTTOM_ROWS: '9' }, homeDir: home }).keepBottomRows, 9);
    assert.equal(m.loadConfig(null, { env: { CLAUDE_PLUGIN_OPTION_KEEP_BOTTOM_ROWS: '9', MATRIX_KEEP_BOTTOM_ROWS: '0' }, homeDir: home }).keepBottomRows, 0);
    assert.equal(m.loadConfig(null, { env: { MATRIX_KEEP_BOTTOM_ROWS: '-3' }, homeDir: home }).keepBottomRows, 6, 'negative values are ignored');
});

test('Rain resize while winding down does not seed new drops', () => {
    const cfg = baseCfg({ spawnChance: 0 });
    const rain = new m.Rain(cfg, 20, 10);
    rain.windingDown = true;
    rain.resize(30, 12);
    assert.equal(rain.isDark(), true);
    assert.equal(rain.render(true), '');
});

test('Rain overlay cells win over rain, are redrawn every frame, and are erased when removed', () => {
    const cfg = baseCfg({ columnSpacing: 2, keepBottomRows: 0, spawnChance: 0 });
    const rain = withRandom([0.99], () => new m.Rain(cfg, 10, 4));
    rain.render(true);
    const ov = new Map([[0 * 10 + 0, { ch: 'H', sgr: `${ESC}[1m` }], [0 * 10 + 1, { ch: '日', sgr: `${ESC}[1m` }], [0 * 10 + 2, { ch: '', sgr: `${ESC}[1m` }]]);
    rain.setOverlay(ov);
    let cells = writtenCells(rain.render(false));
    assert.deepEqual(cells.map((c) => c.ch), ['H', '日']);
    assert.equal(rain.drawn[0][2], m.OCCUPIED, 'right half of the wide glyph is marked occupied, not drawn');
    cells = writtenCells(rain.render(false));
    assert.deepEqual(cells.map((c) => c.ch), ['H', '日'], 'overlay is repainted every frame');
    rain.setOverlay(null);
    cells = writtenCells(rain.render(false));
    assert.deepEqual(cells.map((c) => [c.y, c.x, c.ch]), [[0, 0, ' '], [0, 1, ' '], [0, 2, ' ']], 'removed overlay cells are blanked, including the occupied half');
    assert.equal(rain.render(false), '');
});

test('Rain render output is a compact stream: moves only when the cursor is not already there', () => {
    const cfg = baseCfg({ columnSpacing: 1, keepBottomRows: 0, spawnChance: 0 });
    const rain = withRandom([0.99], () => new m.Rain(cfg, 5, 1));
    rain.render(true);
    rain.setOverlay(new Map([[0, { ch: 'a', sgr: m.SGR_RESET }], [1, { ch: 'b', sgr: m.SGR_RESET }], [3, { ch: 'c', sgr: m.SGR_RESET }]]));
    const out = rain.render(false);
    const moves = [...out.matchAll(CSI_MOVE)].map((x) => x[0]);
    assert.deepEqual(moves, [`${ESC}[1;1H`, `${ESC}[1;4H`], 'adjacent cells share one move; the gap forces another');
    assert.equal(out.replace(/\x1B\[[0-9;]*[Hm]/g, ''), 'abc');
});

// ---- overlay ----------------------------------------------------------------

test('Overlay is empty when both features are off or the screen is too small', () => {
    const off = new m.Overlay(baseCfg(), 100, 30, null, 'hello');
    assert.equal(off.cells().size, 0);
    const on = new m.Overlay(baseCfg({ messages: { enabled: true }, status: { enabled: true } }), 10, 5, null, 'hello');
    assert.equal(on.cells().size, 0, 'too small to share');
});

test('Overlay places the prompt, messages, and a pinned status line', () => {
    let now = 1_000_000;
    const clock = () => now;
    const cfg = baseCfg({ messages: { enabled: true, lines: 40 }, status: { enabled: true, verbs: ['Jacking in'], intervalMs: 60000 } });
    const dir = tmpDir('ov');
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, '');
    const transcript = new m.Transcript(file, 40);
    const W = 40, H = 10;
    const overlay = new m.Overlay(cfg, W, H, transcript, 'my prompt', clock);

    const text = (map, row) => { let s = ''; for (let x = 0; x < W; x++) { const c = map.get(row * W + x); s += c ? c.ch : '.'; } return s; };
    let map = overlay.cells();
    assert.equal(text(map, 0), '❯ my prompt' + '.'.repeat(W - 11));
    assert.equal(text(map, H - 1).replace(/\.+$/, ''), '✻ Jacking in… (0s)');
    now += 12_500;
    fs.appendFileSync(file, assistant([{ type: 'tool_use', name: 'Read', input: { file_path: 'a' } }]) + assistant([{ type: 'text', text: 'x'.repeat(100) }]));
    transcript.poll();
    map = overlay.cells();
    assert.equal(text(map, 2).replace(/\.+$/, ''), '⏺ Read(a)');
    assert.equal(text(map, 4), '⏺ ' + 'x'.repeat(W - 3) + '…', 'long message is truncated to the width');
    assert.equal(text(map, 1), '.'.repeat(W), 'blank line between messages leaves the rain alone');
    assert.equal(text(map, H - 1).replace(/\.+$/, ''), '✻ Jacking in… (12s)');

    // Enough messages to overflow: the stack anchors to the bottom (scrolls).
    for (let i = 0; i < 10; i++) fs.appendFileSync(file, assistant([{ type: 'text', text: `msg ${i}` }]));
    transcript.poll();
    map = overlay.cells();
    assert.equal(text(map, H - 2).replace(/\.+$/, ''), '⏺ msg 9', 'newest message sits just above the status line');
    assert.equal(text(map, 0)[0], '❯' === text(map, 0)[0] ? '❯' : text(map, 0)[0]);
    assert.notEqual(text(map, 0).slice(0, 2), '❯ ', 'the prompt has scrolled off the top');

    overlay.windingDown = true;
    assert.equal(overlay.verb(), cfg.status.windDownVerb);
});

test('Overlay.place protects wide glyphs and stops at the right edge', () => {
    const cfg = baseCfg();
    const overlay = new m.Overlay(cfg, 5, 8, null, '');
    const map = new Map();
    overlay.place(map, 0, [{ text: 'a日b日', sgr: '' }]);
    assert.deepEqual([...map.keys()].sort((p, q) => p - q), [0, 1, 2, 3], 'the second wide glyph does not fit and is dropped');
    assert.equal(map.get(2).ch, '', 'right half marker');
    overlay.place(map, 99, [{ text: 'zzz', sgr: '' }]);
    assert.equal(map.size, 4, 'rows outside the screen are ignored');
});
