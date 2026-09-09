# matrix-terminal-loader

A [Claude Code](https://code.claude.com) plugin that fills your terminal with Matrix-style digital rain while Claude is thinking, then puts the screen back exactly as it was, with the finished reply in place.

![Matrix digital rain running in an 80x24 terminal](assets/demo.gif)

The recording above is the real `index.js` animation captured in an 80x24 pseudo-terminal.

## How it works

Claude Code exposes lifecycle [hooks](https://code.claude.com/docs/en/hooks). This plugin registers two of them in `.claude-plugin/plugin.json`:

| Hook event         | Fires when                         | What the plugin does                         |
| ------------------ | ---------------------------------- | -------------------------------------------- |
| `UserPromptSubmit` | You press Enter on a prompt        | `node index.js --start` launches the rain    |
| `Stop`             | Claude finishes its response       | `node index.js --stop` stops it and restores |

Two details of Claude Code's hook runner shape the design, and are worth knowing if you want to modify the plugin:

1. **Hooks block Claude Code until they exit.** The start hook therefore never animates itself. It spawns a detached background process (`node index.js --run`), writes that process's PID to `.matrix.lock`, and exits in well under 100 ms.
2. **Hook output is captured, not shown.** Claude Code parses a hook's stdout as JSON and runs hooks in their own session with no controlling terminal, so `/dev/tty` is unavailable and printing escape codes does nothing. Instead, the start hook asks `ps` for the terminal device of its parent process (Claude Code itself), such as `/dev/ttys005` on macOS or `/dev/pts/3` on Linux, and the background process opens that device by path and draws on it directly. The terminal size is read the same way, through `stty`, and polled so window resizes are picked up.

Two more choices make the hand-back clean:

3. **The rain lives on the alternate screen buffer**, the same one `vim` and `less` use. Claude Code's transcript on the main screen is never touched, and switching back restores it byte for byte. Claude's spinner and streamed reply do land on the alternate screen while the rain runs, so you see them flicker through the rain, and a full repaint every two seconds sweeps them away.
4. **The stop hook makes Claude Code repaint.** The reply Claude streamed during the rain was written to the alternate screen, so it would be missing after the switch back. Claude Code ignores a bare `SIGWINCH` but fully re-renders its transcript on a real size change, so the stop hook shrinks the terminal by one column with `stty` and puts it straight back. The result is the same screen you would have seen without the plugin.

The stop hook sends `SIGTERM` to the PID in the lock file, waits briefly for it to leave the alternate screen, deletes the lock, writes the restore sequence itself as a fallback, then sends the repaint nudge.

Colors are 24-bit (`COLORTERM=truecolor` or `24bit`) so the green is the same in every terminal theme. Terminals without true color get the closest entries from the 256-color palette. The basic ANSI green was deliberately avoided because many themes remap it to olive or yellow.

Safety nets in the background process:

- It exits on its own within a second if the Claude Code process that started it disappears, so a crash or Ctrl+C never leaves rain running.
- It exits if the terminal device goes away or refuses writes.
- A second `--start` while one is already running is a no-op.

## Requirements

- Claude Code with plugin support (validated against 2.1.x).
- Node.js 18 or newer on your `PATH` as `node`.
- macOS or Linux. Windows has no terminal device path to write to, so the hooks exit quietly and Claude Code behaves as if the plugin were not installed.
- A terminal font with half-width katakana (U+FF66 to U+FF9D). Most terminals fall back to a system CJK font automatically.

Tested on macOS with Node 22 and Claude Code 2.1.266, in both interactive and `claude -p` sessions, including the repaint of the finished reply after the rain. Linux has not been exercised yet, though nothing in the code is macOS specific.

## Installation

### Try it for one session

```bash
git clone https://github.com/solepixel/matrix-terminal-loader.git
claude --plugin-dir ./matrix-terminal-loader
```

`--plugin-dir` loads the plugin for that session only. Type any prompt and the rain starts.

### Make it permanent with a shell alias

```bash
# ~/.zshrc or ~/.bashrc
alias claude='claude --plugin-dir "$HOME/path/to/matrix-terminal-loader"'
```

### Install through a marketplace

If you keep your own plugin marketplace, add this repository as a plugin entry:

```json
{
  "name": "my-plugins",
  "owner": { "name": "you" },
  "plugins": [
    {
      "name": "matrix-terminal-loader",
      "source": { "source": "github", "repo": "solepixel/matrix-terminal-loader" },
      "description": "Matrix digital rain while Claude is thinking."
    }
  ]
}
```

Then inside Claude Code run `/plugin marketplace add <your-marketplace>` followed by `/plugin install matrix-terminal-loader@my-plugins`. See the [plugin marketplaces docs](https://code.claude.com/docs/en/plugin-marketplaces) for the full schema.

## Usage

There is nothing to configure. Submit a prompt, watch the rain, and the screen is restored when Claude finishes.

To see the animation outside Claude Code, run it directly in any terminal and press Ctrl+C to stop:

```bash
node index.js --run
```

## Validating the plugin

```bash
claude plugin validate ./matrix-terminal-loader --strict
```

`--strict` turns warnings into errors. The current manifest passes cleanly.

## Customizing

Everything visual is a constant in the "Look and feel" block at the top of `index.js`:

| Constant             | Default          | Effect                                                       |
| -------------------- | ---------------- | ------------------------------------------------------------ |
| `FRAME_MS`           | `50`             | Milliseconds per frame (20 frames per second)                |
| `COLUMN_SPACING`     | `2`              | One stream every N terminal cells                            |
| `SPAWN_CHANCE`       | `0.03`           | Chance per frame that an idle column starts a new drop       |
| `DECAY_PER_FRAME`    | `0.035`          | How fast trails fade; lower means longer trails              |
| `FLICKER_CHANCE`     | `0.02`           | Chance per frame that a lit cell swaps its glyph             |
| `FULL_REPAINT_EVERY` | `40`             | Frames between full repaints that clear stray output         |
| `SPEEDS`             | `[1, 1, 2, 2, 3]`| Frames per step, drawn at random for each drop               |
| `chars`              | katakana, 0-9, A-F | Glyph set                                                  |
| `LEVELS` and `HEAD`  | greens, near-white | Trail brightness bands and head color, as RGB plus a 256-color index |

## Troubleshooting

**Nothing happens when I submit a prompt.**
Run with a debug log and read it after a prompt:

```bash
MATRIX_DEBUG=/tmp/matrix.log claude --plugin-dir ./matrix-terminal-loader
cat /tmp/matrix.log
```

A healthy run logs `start: tty=/dev/...`, then `run: tty=/dev/... size=WxH truecolor=true`, then `stop: repaint nudge sent`. If `tty=null`, Claude Code is not attached to a terminal (for example when driven over a pipe) and the plugin stands down on purpose.

**The rain is yellow or the wrong green.**
Your terminal is not advertising true color, so the plugin fell back to the 256-color palette, which some themes remap. Set `COLORTERM=truecolor` in your shell profile if your terminal supports it.

**The rain is still running after Claude stopped.**
The `Stop` hook did not fire, usually because the session ended abruptly. The background process notices its parent is gone within a second and exits. If one ever survives:

```bash
pkill -f "index.js --run"
rm -f /path/to/matrix-terminal-loader/.matrix.lock
```

**The cursor is missing, colors look wrong, or the screen is stuck on the rain afterwards.**
Run `node index.js --stop` from the plugin directory, which leaves the alternate screen and restores the cursor, or `reset` in that terminal.

## Known limitations

- **Claude Code keeps drawing too.** Its spinner line and the streamed response show through the rain on the alternate screen until the next full repaint. Everything is repainted cleanly once the rain stops.
- **The repaint relies on a resize.** If a future Claude Code release stops re-rendering on size changes, the reply streamed during the rain would be missing from the screen after the rain. Pressing Enter on an empty prompt or resizing the window brings it back.
- **One animation per plugin directory.** The lock file lives next to `index.js`, so two Claude Code sessions sharing one install share one animation. The second session's start is a no-op and either session's stop ends it.
- **Permission prompts and questions are not covered.** The rain runs from prompt submit until Claude's final `Stop`. If Claude pauses to ask for tool permission, the rain keeps falling over the prompt until you answer.

## Project layout

```
matrix-terminal-loader/
├── .claude-plugin/
│   └── plugin.json   # manifest: name, version, author, hook registrations
├── assets/
│   └── demo.gif      # the recording shown above
├── index.js          # --start / --stop hook entry points and the --run animation loop
├── .gitignore        # ignores the runtime .matrix.lock file
└── README.md
```

## Credits

Original animation and concept generated with Gemini. Hook wiring, terminal-device discovery, process lifecycle handling, and testing inside Claude Code by Claude.
