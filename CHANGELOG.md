# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-08

First release.

### Added
- Matrix digital rain drawn on Claude Code's terminal while a prompt is being
  answered, driven by the `UserPromptSubmit` and `Stop` hooks.
- True-color green streams with a bright head and fading trails, dense from
  the first frame; a 256-color fallback for terminals without true color.
- Coexistence with Claude Code's own interface: the rain draws in every other
  column and erases only its own trails, so Claude's messages and streamed
  reply show through where they normally appear.
- A protected band at the bottom of the terminal (six rows by default, the
  `keep_bottom_rows` option) that the rain never touches, so Claude Code's
  prompt box, borders, and status line stay clean while you type your next
  prompt.
- An opt-in overlay that draws your prompt and Claude's progress messages as
  formatted bullets, read from the session transcript, plus a Matrix-themed
  status line with elapsed time that holds one verb per turn.
- A graceful wind-down: when Claude finishes, the streams drain off the screen
  and the transcript is restored in place via a terminal-resize repaint nudge.
- Settings through plugin options (`userConfig`), a JSON config file, or
  environment variables.
- One lock file per terminal in the system temp directory, so several Claude
  Code sessions in different windows each get their own rain, and a stale lock
  whose PID was recycled by another process is ignored rather than trusted.
- Terminal size read with a window-size ioctl through a throwaway tty handle
  (no `stty` fork twice a second), with `stty` kept as a fallback; on Linux the
  terminal device is found through `/proc`, so minimal images without `ps` work.
- A test suite (`npm test`, no dependencies) covering settings, colors, text
  measurement, the transcript parser, the renderer, the overlay, and the full
  start/run/stop lifecycle against a real pseudo-terminal, including teardown
  on parent death, signals, and a closed terminal.
- GitHub Actions running the suite on Ubuntu and macOS with Node 18, 20 and 22.
- `scripts/record-demo.py`, which records `assets/demo.gif` from a real
  Claude Code session.
- License, changelog, and a self-hosted marketplace manifest for installation.
