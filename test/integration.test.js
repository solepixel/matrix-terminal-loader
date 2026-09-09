'use strict';

// End-to-end tests of the three modes against a real pseudo-terminal. The
// plugin is pointed at the pty with MATRIX_TTY (the same override the start
// hook passes to the run process), and everything it writes there is
// captured by the pty holder, so these tests see exactly what a terminal
// would. Skipped on platforms without a usable pty (Windows, no python3).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const m = require('../index.js');
const { openPty, PTY_AVAILABLE } = require('./helpers/pty.js');

const INDEX = path.join(__dirname, '..', 'index.js');
const ESC = '\x1B';
const skip = PTY_AVAILABLE ? false : 'no pseudo-terminal available (needs python3 on macOS/Linux)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms = 5000, every = 50) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (pred()) return true;
        await sleep(every);
    }
    return pred();
}

// Run a hook mode to completion with JSON on stdin, the way Claude Code does.
function hook(mode, input, env = {}) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [INDEX, mode], {
        input: JSON.stringify(input),
        env: { ...process.env, COLORTERM: 'truecolor', ...env },
        encoding: 'utf8',
        timeout: 30000,
    });
    return { ...r, ms: Date.now() - t0 };
}

// Launch the animation loop directly (as the start hook would) and return the child.
function launchRun(env) {
    return spawn(process.execPath, [INDEX, '--run'], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, COLORTERM: 'truecolor', ...env },
    });
}

function katakanaCount(s) { return (s.match(/[ｦ-ﾝ]/g) || []).length; }

test('start hook does nothing without a terminal', { skip }, () => {
    const r = hook('--start', { prompt: 'hi' }, { MATRIX_TTY: '' });
    // This test runner has no controlling terminal, so ppid lookup fails and
    // the hook stands down. (If it is run from an interactive shell the hook
    // would find that shell's tty instead, so only assert on the exit code.)
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'hooks never print to stdout');
});

test('start hook exits quickly, writes a per-tty lock, and the rain draws on the pty', { skip }, async () => {
    const pty = await openPty(60, 16);
    const lock = m.lockPath(pty.tty);
    try {
        const r = hook('--start', { prompt: 'Tell me a joke', cwd: os.tmpdir() }, { MATRIX_TTY: pty.tty });
        assert.equal(r.status, 0);
        assert.equal(r.stdout, '');
        assert.ok(r.ms < 2000, `start hook took ${r.ms} ms`);
        assert.ok(fs.existsSync(lock), 'lock file written');
        const pid = m.readLockPid(lock);
        assert.ok(m.isRainProcess(pid), 'lock names a live --run process');

        assert.ok(await waitFor(() => katakanaCount(pty.output()) > 50, 3000), 'rain glyphs arrive on the terminal');
        const out = pty.output();
        assert.ok(out.startsWith(`${ESC}[?25l`), 'cursor hidden first');
        assert.ok(out.includes(`${ESC}[38;2;`), '24-bit color used under COLORTERM=truecolor');
        assert.ok(!out.includes(`${ESC}[?1049h`), 'alternate screen not used by default');
        assert.ok(out.includes(`${ESC}[1;1H`), 'cursor parked top-left after each frame');
        // Rain only lands in even columns (spacing 2) and never in the bottom
        // six rows where Claude Code's prompt box lives: parse every absolute move.
        const moves = [...out.matchAll(/\x1B\[(\d+);(\d+)H/g)].map((x) => ({ row: +x[1], col: +x[2] }));
        assert.ok(moves.length > 50);
        assert.ok(moves.every((mv) => mv.col === 1 || (mv.col - 1) % 2 === 0), 'writes only to rain columns');
        assert.ok(moves.every((mv) => mv.row <= 16 - 6), `writes stay above the prompt box; rows seen: ${[...new Set(moves.map((mv) => mv.row))].sort((p, q) => p - q)}`);
        assert.ok(moves.some((mv) => mv.row === 10), 'the last rain row is used');

        // A second start on the same terminal is a no-op.
        const r2 = hook('--start', { prompt: 'again' }, { MATRIX_TTY: pty.tty });
        assert.equal(r2.status, 0);
        assert.equal(m.readLockPid(lock), pid, 'lock unchanged');

        // Stop: graceful wind-down, then restore and nudge.
        const dbg = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mtl-log-')), 'debug.log');
        pty.reset();
        const s = hook('--stop', { cwd: os.tmpdir() }, { MATRIX_TTY: pty.tty, MATRIX_WIND_DOWN_MS: '300', MATRIX_DEBUG: dbg });
        assert.equal(s.status, 0);
        assert.equal(s.stdout, '');
        assert.ok(s.ms < 4000, `stop hook took ${s.ms} ms`);
        assert.ok(await waitFor(() => !m.isAlive(pid), 2000), 'run process has exited');
        assert.ok(!fs.existsSync(lock), 'lock removed');
        assert.ok(await waitFor(() => pty.output().includes(`${ESC}[?25h`), 2000), 'cursor shown again');
        assert.ok(pty.output().includes(`${ESC}[2J`), 'screen cleared for Claude Code to repaint');
        const log = fs.readFileSync(dbg, 'utf8');
        assert.match(log, /repaint nudge sent/);
    } finally {
        try { process.kill(m.readLockPid(lock), 'SIGKILL'); } catch (e) {}
        try { fs.unlinkSync(lock); } catch (e) {}
        await pty.close();
    }
});

test('two terminals get independent rains and stops', { skip }, async () => {
    const a = await openPty(40, 12);
    const b = await openPty(40, 12);
    const la = m.lockPath(a.tty), lb = m.lockPath(b.tty);
    try {
        assert.equal(hook('--start', {}, { MATRIX_TTY: a.tty }).status, 0);
        assert.equal(hook('--start', {}, { MATRIX_TTY: b.tty }).status, 0);
        const pa = m.readLockPid(la), pb = m.readLockPid(lb);
        assert.ok(pa && pb && pa !== pb, 'two distinct run processes');
        assert.ok(await waitFor(() => katakanaCount(a.output()) > 10 && katakanaCount(b.output()) > 10, 3000));
        hook('--stop', {}, { MATRIX_TTY: a.tty, MATRIX_WIND_DOWN_MS: '0' });
        assert.ok(await waitFor(() => !m.isAlive(pa), 2000), 'terminal A stopped');
        assert.ok(m.isAlive(pb), 'terminal B keeps raining');
        hook('--stop', {}, { MATRIX_TTY: b.tty, MATRIX_WIND_DOWN_MS: '0' });
        assert.ok(await waitFor(() => !m.isAlive(pb), 2000), 'terminal B stopped');
    } finally {
        for (const l of [la, lb]) { try { process.kill(m.readLockPid(l), 'SIGKILL'); } catch (e) {} try { fs.unlinkSync(l); } catch (e) {} }
        await a.close(); await b.close();
    }
});

test('a stale lock with a recycled pid does not block the rain', { skip }, async () => {
    const pty = await openPty(40, 12);
    const lock = m.lockPath(pty.tty);
    try {
        fs.writeFileSync(lock, String(process.pid)); // alive, but not a rain process
        assert.equal(hook('--start', {}, { MATRIX_TTY: pty.tty }).status, 0);
        const pid = m.readLockPid(lock);
        assert.notEqual(pid, process.pid, 'lock was replaced');
        assert.ok(m.isRainProcess(pid));
        // A stop with that stale lock must not signal the test runner either.
        fs.writeFileSync(lock, String(process.pid));
        assert.equal(hook('--stop', {}, { MATRIX_TTY: pty.tty, MATRIX_WIND_DOWN_MS: '0' }).status, 0);
        assert.ok(m.isAlive(pid), 'the real rain was left alone');
        process.kill(pid, 'SIGTERM');
        assert.ok(await waitFor(() => !m.isAlive(pid), 2000));
    } finally {
        try { process.kill(m.readLockPid(lock), 'SIGKILL'); } catch (e) {}
        try { fs.unlinkSync(lock); } catch (e) {}
        await pty.close();
    }
});

test('run process exits and restores the terminal when its parent dies', { skip }, async () => {
    const pty = await openPty(40, 12);
    const parent = spawn('sleep', ['30']);
    let child;
    try {
        child = launchRun({ MATRIX_TTY: pty.tty, MATRIX_PARENT_PID: String(parent.pid) });
        assert.ok(await waitFor(() => katakanaCount(pty.output()) > 10, 3000), 'rain started');
        parent.kill('SIGKILL');
        const t0 = Date.now();
        assert.ok(await waitFor(() => !m.isAlive(child.pid), 3000), 'run process noticed the parent is gone');
        assert.ok(Date.now() - t0 < 2000, 'within about a second');
        assert.ok(pty.output().includes(`${ESC}[?25h`), 'cursor restored');
    } finally {
        try { child.kill('SIGKILL'); } catch (e) {}
        try { parent.kill('SIGKILL'); } catch (e) {}
        await pty.close();
    }
});

test('run process handles SIGTERM, SIGINT, SIGHUP, and a closed terminal', { skip }, async () => {
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
        const pty = await openPty(40, 12);
        const child = launchRun({ MATRIX_TTY: pty.tty });
        try {
            assert.ok(await waitFor(() => katakanaCount(pty.output()) > 10, 3000), `${sig}: rain started`);
            child.kill(sig);
            assert.ok(await waitFor(() => !m.isAlive(child.pid), 3000), `${sig}: exited`);
            assert.ok(pty.output().endsWith(`${ESC}[?25h`), `${sig}: last bytes restore the terminal`);
        } finally {
            try { child.kill('SIGKILL'); } catch (e) {}
            await pty.close();
        }
    }
    // Closing the terminal makes writes fail; the process must stop on its own.
    const pty = await openPty(40, 12);
    const child = launchRun({ MATRIX_TTY: pty.tty });
    assert.ok(await waitFor(() => katakanaCount(pty.output()) > 10, 3000));
    await pty.close();
    assert.ok(await waitFor(() => !m.isAlive(child.pid), 5000), 'exited after the terminal went away');
});

test('run process winds down on its own after maxRunMs and honours the config file', { skip }, async () => {
    const pty = await openPty(40, 12);
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mtl-proj-'));
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', m.CONFIG_BASENAME), JSON.stringify({ maxRunMs: 700, windDownMaxMs: 500, columnSpacing: 3 }));
    const child = launchRun({ MATRIX_TTY: pty.tty, MATRIX_CWD: project });
    try {
        assert.ok(await waitFor(() => katakanaCount(pty.output()) > 10, 3000));
        const cols = [...pty.output().matchAll(/\x1B\[(\d+);(\d+)H/g)].map((x) => +x[2]);
        assert.ok(cols.every((c) => (c - 1) % 3 === 0), 'columnSpacing from the project config is applied');
        assert.ok(await waitFor(() => !m.isAlive(child.pid), 4000), 'stopped after the hard cap and wind-down');
        assert.ok(pty.output().endsWith(`${ESC}[?25h`));
    } finally {
        try { child.kill('SIGKILL'); } catch (e) {}
        await pty.close();
    }
});

test('overlay mode draws the prompt and transcript bullets over the rain', { skip }, async () => {
    const pty = await openPty(80, 20);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtl-tr-'));
    const transcript = path.join(dir, 'session.jsonl');
    fs.writeFileSync(transcript, '');
    const child = launchRun({ MATRIX_TTY: pty.tty, MATRIX_TRANSCRIPT: transcript, MATRIX_PROMPT: 'Explain the plan', MATRIX_MESSAGES: '1', MATRIX_STATUS: '1' });
    // Overlay segments change color mid-line, so compare with colors stripped.
    const plain = () => pty.output().replace(/\x1B\[[0-9;]*m/g, '');
    try {
        assert.ok(await waitFor(() => plain().includes('❯ Explain the plan'), 3000), 'prompt shown');
        fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] } }) + '\n');
        assert.ok(await waitFor(() => plain().includes('⏺ Read(README.md)'), 3000), 'transcript bullet shown');
        assert.ok(/✻ [^\x1B]+… \(\d+s\)/.test(plain()), 'status line with elapsed seconds');
    } finally {
        child.kill('SIGTERM');
        await waitFor(() => !m.isAlive(child.pid), 2000);
        await pty.close();
    }
});

test('ttySize reads the pty size without stty, and picks up a resize', { skip }, async () => {
    const pty = await openPty(77, 21);
    try {
        assert.deepEqual(m.ttySize(pty.tty), { width: 77, height: 21 });
        assert.ok(m.setTtySize(pty.tty, 66, 19));
        assert.deepEqual(m.ttySize(pty.tty), { width: 66, height: 19 });
        assert.ok(m.nudgeRepaint(pty.tty));
        assert.deepEqual(m.ttySize(pty.tty), { width: 66, height: 19 }, 'nudge leaves the size as it was');
        assert.equal(m.ttySize('/dev/null'), null);
    } finally {
        await pty.close();
    }
});

test('resolveTty finds the terminal of a process and honours MATRIX_TTY', { skip }, async () => {
    const pty = await openPty(40, 12);
    try {
        assert.equal(m.resolveTty({ MATRIX_TTY: '/dev/ttyXYZ' }), '/dev/ttyXYZ');
        const ps = execFileSync('ps', ['-o', 'pid=,tty=', '-t', pty.tty.replace(/^\/dev\//, '')], { encoding: 'utf8' }).trim();
        const holderChild = parseInt(ps.split('\n')[0], 10);
        assert.ok(holderChild > 0, `a process on ${pty.tty}`);
        assert.equal(m.ttyOfProcess(holderChild), pty.tty);
        assert.equal(m.ttyOfProcess(2147483646), null);
        assert.match(m.commandOfProcess(holderChild), /sleep/);
    } finally {
        await pty.close();
    }
});

test('a usage message and exit code 2 when run with no mode', () => {
    const r = spawnSync(process.execPath, [INDEX], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: node index\.js --run \| --start \| --stop/);
});

test('plugin and marketplace manifests validate', () => {
    const root = path.join(__dirname, '..');
    const plugin = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(plugin.name, 'matrix-terminal-loader');
    assert.equal(market.plugins[0].name, plugin.name);
    assert.equal(market.plugins[0].version, plugin.version, 'plugin.json and marketplace.json versions match');
    assert.equal(pkg.version, plugin.version, 'package.json version matches');
    assert.match(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), new RegExp(`## \\[${plugin.version.replace(/\./g, '\\.')}\\]`), 'CHANGELOG has an entry for this version');
    assert.equal(plugin.hooks.UserPromptSubmit[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/index.js" --start');
    assert.equal(plugin.hooks.Stop[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/index.js" --stop');
    assert.equal(plugin.userConfig.wind_down_ms.default, m.DEFAULTS.windDownMaxMs, 'plugin option default matches the code default');
    assert.equal(plugin.userConfig.message_lines.default, m.DEFAULTS.messages.lines);
    assert.equal(plugin.userConfig.show_messages.default, m.DEFAULTS.messages.enabled);
    assert.equal(plugin.userConfig.show_status.default, m.DEFAULTS.status.enabled);
    assert.equal(plugin.userConfig.keep_bottom_rows.default, m.DEFAULTS.keepBottomRows);
    assert.ok(plugin.hooks.Stop[0].hooks[0].timeout * 1000 > m.WIND_DOWN_CAP_MS + 1500, 'Stop hook timeout covers the longest wind-down');

    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { stdio: 'ignore' });
    if (which.status !== 0) return; // claude CLI not installed here; manifests were still cross-checked above
    const r = spawnSync('claude', ['plugin', 'validate', root, '--strict'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, `claude plugin validate --strict failed:\n${r.stdout}\n${r.stderr}`);
});
