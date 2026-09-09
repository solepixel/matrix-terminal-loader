#!/usr/bin/env python3
"""Record a real Claude Code session with the plugin into assets/demo.gif.

Nothing is mocked. The actual `claude` binary is run with --plugin-dir inside
a pseudo-terminal, every byte it and the plugin write is fed through a
terminal emulator (pyte, tracking both the main and alternate screen
buffers), and the active screen is snapshotted at a fixed interval. The
frames are then written out as a GIF, with the prompt-typing phase sampled
more sparsely than the rain so the recording gets to the point.

Requires: python3 with pyte, Pillow and fontTools (pip install pyte pillow
fonttools); the `claude` CLI; and, for the rendering, the macOS Menlo,
Arial Unicode and Apple Symbols fonts (edit FONTS for other systems).

usage: scripts/record-demo.py [--out assets/demo.gif] [--cols 100] [--rows 32]
                              [--prompt "..."] [--snap-ms 90] [--model haiku]
                              [--claude-args "--allowedTools Read"]
"""
import argparse
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

import pyte
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ap = argparse.ArgumentParser()
ap.add_argument('--out', default=os.path.join(ROOT, 'assets', 'demo.gif'))
ap.add_argument('--cols', type=int, default=100)
ap.add_argument('--rows', type=int, default=32)
ap.add_argument('--prompt', default='Read README.md, then CHANGELOG.md, then LICENSE, and after each say in one short sentence what it is.')
ap.add_argument('--snap-ms', type=int, default=90, help='how often the screen is snapshotted')
ap.add_argument('--model', default='haiku')
ap.add_argument('--claude-args', default='--allowedTools Read')
ap.add_argument('--typing-stride', type=int, default=4, help='keep every Nth frame while the prompt is being typed')
ap.add_argument('--rain-stride', type=int, default=2, help='keep every Nth frame once the prompt is submitted')
ap.add_argument('--colors', type=int, default=32, help='GIF palette size')
ap.add_argument('--stills', default='', help='directory to drop first/rain/last PNG stills into')
ap.add_argument('--cwd', default=ROOT, help='directory Claude Code is started in (shown in its header)')
args = ap.parse_args()

COLS, ROWS, SNAP_MS = args.cols, args.rows, args.snap_ms


class Screen(pyte.Screen):
    # Claude Code sends private-mode queries pyte does not understand; ignore them.
    def report_device_status(self, *a, **k): pass
    def report_device_attributes(self, *a, **k): pass
    def write_process_input(self, *a, **k): pass


main, alt = Screen(COLS, ROWS), Screen(COLS, ROWS)
streams = {'main': pyte.ByteStream(main), 'alt': pyte.ByteStream(alt)}
active = 'main'
ALT_ON, ALT_OFF = b'\x1b[?1049h', b'\x1b[?1049l'

log_path = os.path.join(os.path.dirname(os.path.abspath(args.out)), '.record-demo.log')
try: os.unlink(log_path)
except OSError: pass

pid, fd = pty.fork()
if pid == 0:
    # Start clean even when launched from inside another Claude Code session.
    for k in [k for k in os.environ if k == 'CLAUDECODE' or k.startswith('CLAUDE_CODE_')]: os.environ.pop(k, None)
    os.environ.update(TERM='xterm-256color', COLORTERM='truecolor', COLUMNS=str(COLS), LINES=str(ROWS), MATRIX_DEBUG=log_path)
    os.chdir(args.cwd)
    os.execvp('claude', ['claude', '--plugin-dir', ROOT, '--model', args.model] + args.claude_args.split())
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))

# ---- fonts ----
CELL_W, CELL_H, FONT_SIZE, PAD = 9, 18, 14, 12
FONTS = {
    'mono': ('/System/Library/Fonts/Menlo.ttc', 0),
    'mono_bold': ('/System/Library/Fonts/Menlo.ttc', 1),
    'unicode': ('/System/Library/Fonts/Supplemental/Arial Unicode.ttf', 0),
    'symbols': ('/System/Library/Fonts/Apple Symbols.ttf', 0),
}


def load(path, idx=0):
    return ImageFont.truetype(path, FONT_SIZE, index=idx), TTFont(path, fontNumber=idx).getBestCmap()


menlo, menlo_map = load(*FONTS['mono'])
menlo_b, _ = load(*FONTS['mono_bold'])
uni, uni_map = load(*FONTS['unicode'])
sym, sym_map = load(*FONTS['symbols'])


def font_for(ch, bold):
    cp = ord(ch)
    if cp in menlo_map: return menlo_b if bold else menlo
    if cp in uni_map: return uni
    if cp in sym_map: return sym
    return menlo


NAMED = {'default': (220, 220, 220), 'black': (40, 40, 40), 'red': (230, 80, 80), 'green': (80, 200, 100),
         'yellow': (220, 190, 80), 'blue': (100, 140, 240), 'magenta': (200, 120, 220), 'cyan': (90, 200, 210),
         'white': (240, 240, 240), 'brightblack': (130, 130, 130), 'brightred': (255, 110, 110),
         'brightgreen': (120, 240, 130), 'brightyellow': (250, 220, 120), 'brightblue': (140, 170, 255),
         'brightmagenta': (230, 150, 255), 'brightcyan': (130, 230, 240), 'brightwhite': (255, 255, 255)}
BG = (30, 30, 30)


def color(v, default):
    if v == 'default': return default
    if isinstance(v, str) and len(v) == 6 and re.fullmatch(r'[0-9a-fA-F]{6}', v):
        return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4))
    return NAMED.get(v, default)


W, H = COLS * CELL_W + PAD * 2, ROWS * CELL_H + PAD * 2


def render(screen):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    for y in range(ROWS):
        row = screen.buffer[y]
        for x in range(COLS):
            c = row[x]
            fg, bg = color(c.fg, NAMED['default']), color(c.bg, BG)
            if c.reverse: fg, bg = bg if bg != BG else (200, 200, 200), fg if fg != NAMED['default'] else (70, 70, 70)
            if bg != BG:
                d.rectangle([PAD + x * CELL_W, PAD + y * CELL_H, PAD + (x + 1) * CELL_W, PAD + (y + 1) * CELL_H], fill=bg)
            ch = c.data
            if not ch or ch == ' ': continue
            d.text((PAD + x * CELL_W, PAD + y * CELL_H), ch, font=font_for(ch, c.bold), fill=fg)
    return img


_CSI = re.compile(rb'\x1b\[[0-9;?]*[ -/]*[@-~]')
_OSC = re.compile(rb'\x1b\][^\x07]*(?:\x07|\x1b\\)')
_SHORT = re.compile(rb'\x1b[=>78Mc]')
carry = b''


def feed(data):
    # Hold back any trailing INCOMPLETE escape sequence so a truecolor SGR that
    # straddles a read boundary is never split, then route complete tokens
    # between the main and alternate screens.
    global carry, active
    buf = carry + data
    esc = buf.rfind(b'\x1b')
    if esc != -1 and not (_CSI.match(buf, esc) or _OSC.match(buf, esc) or _SHORT.match(buf, esc)):
        carry = buf[esc:]; buf = buf[:esc]
    else:
        carry = b''
    while buf:
        i_on, i_off = buf.find(ALT_ON), buf.find(ALT_OFF)
        cand = [i for i in (i_on, i_off) if i >= 0]
        idx = min(cand) if cand else -1
        if idx < 0:
            streams[active].feed(buf); break
        streams[active].feed(buf[:idx])
        active = 'alt' if idx == i_on else 'main'
        buf = buf[idx + len(ALT_ON):]


frames, phases = [], []   # phases[i] is the phase the i-th frame belongs to
recording = False
phase = 'typing'


def pump(seconds, stop_when=None):
    t0 = time.time(); nxt = time.time(); got = b''
    while time.time() - t0 < seconds:
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            try: data = os.read(fd, 65536)
            except OSError: return got
            got += data
            try: feed(data)
            except Exception as e: print('feed error (ignored):', e, file=sys.stderr)
        if recording and time.time() >= nxt:
            frames.append(render(main if active == 'main' else alt)); phases.append(phase); nxt += SNAP_MS / 1000
        if stop_when and stop_when(got): return got
    return got


boot = pump(7)
if b'trust' in boot.lower(): os.write(fd, b'\r'); pump(3)
recording = True
pump(0.8)
for ch in args.prompt.encode():           # type the prompt like a person would
    os.write(fd, bytes([ch])); pump(0.03)
pump(0.5)
phase = 'rain'
os.write(fd, b'\r')


def stopped(_):
    # The plugin's debug log says when the stop hook has finished.
    try: return 'repaint nudge' in open(log_path).read()
    except OSError: return False


pump(180, stop_when=stopped)
phase = 'restored'
pump(3.0)
recording = False
os.write(fd, b'/exit\r'); pump(3)
try: os.kill(pid, signal.SIGTERM)
except OSError: pass
try: os.unlink(log_path)
except OSError: pass

# ---- write the GIF ----
# Sample each phase at its own stride: typing goes by quickly, the rain and
# the restored transcript keep more of their frames.
stride = {'typing': args.typing_stride, 'rain': args.rain_stride, 'restored': args.rain_stride}
kept, durations, seen = [], [], {}
for f, p in zip(frames, phases):
    seen[p] = seen.get(p, 0) + 1
    if (seen[p] - 1) % stride[p] == 0:
        kept.append(f); durations.append(SNAP_MS * stride[p])
if kept:
    durations[-1] = 1500  # hold the restored transcript before looping
q = [f.quantize(colors=args.colors, method=Image.Quantize.MEDIANCUT) for f in kept]
q[0].save(args.out, save_all=True, append_images=q[1:], duration=durations, loop=0, optimize=True)
print(json.dumps({
    'frames_captured': len(frames), 'frames_kept': len(kept),
    'by_phase': {p: phases.count(p) for p in stride}, 'size': [W, H],
    'kb': round(os.path.getsize(args.out) / 1024), 'seconds': round(sum(durations) / 1000, 1),
}))
if args.stills:
    os.makedirs(args.stills, exist_ok=True)
    first_rain = next((i for i, p in enumerate(phases) if p == 'rain'), 0)
    for name, idx in (('first', 0), ('rain', min(len(frames) - 1, first_rain + 40)), ('last', len(frames) - 1)):
        frames[idx].save(os.path.join(args.stills, f'still_{name}.png'))
