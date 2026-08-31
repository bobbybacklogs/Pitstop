<p align="center">
  <img src="./repo_assets/lockup.png" alt="Pitstop" width="600" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@genoventures-labs/pitstop"><img src="https://img.shields.io/npm/v/@genoventures-labs/pitstop?style=for-the-badge&color=8bd600" alt="npm version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-17b8d4?style=for-the-badge" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18.0.0-8bd600?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js version" />
  <img src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <a href="https://github.com/genoventures-labs/ModelHitch"><img src="https://img.shields.io/badge/routing-ModelHitch-purple?style=for-the-badge" alt="ModelHitch" /></a>
</p>

<p align="center">
  <strong>One job. Scan your codebase. Rotate coding models. Hunt down uncaught bugs. Hand off actionable fixes.</strong>
</p>

---

## Overview

Pitstop is a command-line tool with a single focused job: scan your current working directory, rotate coding models through it via ModelHitch, surface obvious and uncaught bugs, and output a structured handoff report for the next agent to resolve.

Linters catch formatting and syntax issues, but silent logic errors, unhandled asynchronous rejections, race conditions, empty catch blocks, and missing parameter guards often slip through. Pitstop routes your codebase through coding models, aggregates their findings, and writes an actionable agent handoff document with exact file locations, triggers, and patch instructions.

## Quickstart

Run directly using npx:

```bash
npx @genoventures-labs/pitstop
```

Or install globally:

```bash
npm install -g @genoventures-labs/pitstop
pitstop
```

## How It Works

1. **Scan**: Pitstop inspects the target directory, respects your `.gitignore`, filters lockfiles and binary assets, and structures the codebase context.
2. **Rotate**: Leveraging ModelHitch, Pitstop rotates across configured coding models with automated failover handling on rate limits or provider downtime.
3. **Audit**: Models audit the codebase for tangible, non-stylistic bugs across logic, runtime, concurrency, error handling, and security categories.
4. **Handoff**: Results are compiled into a structured markdown report containing prioritized checklists, reproduction triggers, code patches, and copy-ready prompts for the next agent.
5. **Save**: The report is saved to disk, and the absolute file path is presented in the terminal output.

## Usage

```bash
# Scan the current directory
pitstop

# Scan a specific directory
pitstop ./packages/backend

# Specify a custom report destination
pitstop -o ./docs/pitstop-handoff.md

# Rotate through specific coding models
pitstop -m "opencode-zen/big-pickle,deepseek/deepseek-v4-flash"

# Run a multi-model consensus pass
pitstop --multi

# Run offline in mock mode without API keys
pitstop --mock

# Output companion JSON data
pitstop --json
```

## Options

| Option | Short | Description | Default |
| --- | --- | --- | --- |
| `[directory]` | | Target directory to scan | `.` (current directory) |
| `--output` | `-o` | Destination path for the markdown handoff report | `./pitstop-handoff.md` |
| `--models` | `-m` | Comma-separated list of provider and model pairs | ModelHitch configuration |
| `--multi` | | Multi-pass rotation aggregating findings across models | `false` |
| `--mock` | | Offline deterministic audit without network or keys | `false` |
| `--json` | | Write companion structured JSON report | `false` |
| `--max-files` | | Maximum number of files to process | `60` |
| `--verbose` | `-v` | Display detailed scanner and rotation output | `false` |
| `--help` | `-h` | Display command-line help | |
| `--version` | `-V` | Output version number | |

## Model Configuration

Pitstop integrates with ModelHitch for model routing and BYOK credential management:

- Local configuration: Reads providers, keys, and policies from `~/.modelhitch/config.json`.
- Environment variables: Automatically falls back to standard provider environment variables (such as `DEEPSEEK_API_KEY`, `OPENCODE_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `GROQ_API_KEY`).
- Automatic failover: When a provider reports rate limits (HTTP 429) or service interruption, ModelHitch rotates transparently to the next available lane.

## Agent Handoff

The generated report (`pitstop-handoff.md`) provides:

- Executive summary with metrics and repository health status
- Prioritized task checklist for the next agent
- Detailed bug cards with file paths, line ranges, triggers, and patch code
- Copy-paste prompt ready for tools such as Claude Code, Codex, Cursor, or Antigravity
- Embedded JSON payload for automated parsing

## License

MIT (c) bobbybacklogs
