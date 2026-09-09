# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-08

First release.

### Added
- Matrix digital rain drawn on Claude Code's terminal while a prompt is being
  answered, driven by the `UserPromptSubmit` and `Stop` hooks.
- True-color green streams with a bright head and fading trails; a 256-color
  fallback for terminals without true color.
- Your prompt and Claude's progress messages overlaid onto the rain, read from
  the session transcript.
- A Matrix-themed status line with elapsed time that holds one verb per turn.
- A graceful wind-down: when Claude finishes, the streams drain off the screen
  and the transcript is restored in place via a terminal-resize repaint nudge.
- Settings through plugin options (`userConfig`), a JSON config file, or
  environment variables.
- License, changelog, and a self-hosted marketplace manifest for installation.
