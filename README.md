# CARIS: CLI Agent Routing and Integration System

CARIS is a local-first orchestration harness for Codex CLI, Claude Code, and
Gemini CLI. It assigns workflow roles to available providers, stores structured
handoff artifacts, enforces execution budgets, and runs deterministic project
verification between agent calls.

## Requirements

- Node.js 24 or newer
- pnpm 11
- Git
- At least one installed and authenticated coding-agent CLI for live runs

Claude and Gemini credentials are not required for development or fixture-based
tests. Missing or unauthenticated providers are detected and skipped according
to the configured fallback order.

## Installation

Copy or clone the CARIS repository, then run the following commands from the
CARIS directory:

```powershell
pnpm install
pnpm build
pnpm link --global
```

Confirm that the global command is available:

```powershell
caris --version
caris doctor
```

`pnpm link --global` links the current CARIS build to the global `caris`
command. Run `pnpm build` again after updating the CARIS source.

If pnpm reports that its global bin directory is unavailable, run `pnpm setup`,
open a new terminal, and repeat `pnpm link --global`.

## Quick Start

### 1. Open the project CARIS will manage

Move to a Git repository where you want to use the coding agents. Do not run
`caris init` from the CARIS source directory unless CARIS itself is the target.

```powershell
cd D:\path\to\your-project
```

### 2. Create the project configuration

```powershell
caris init
```

This creates `caris.config.yaml` in the current project. Edit it to select the
CLI assigned to each role, configure fallbacks, set budgets, and add the
project's test or lint commands.

### 3. Check the local environment

```powershell
caris doctor
```

`doctor` reports Node.js, Git, and the installation state of Codex CLI, Claude
Code, and Gemini CLI. `INSTALLED` does not verify authentication. Use
`caris doctor --live` to make a minimal authenticated call to each installed
provider; this may consume provider tokens. A live workflow requires at least
one provider reported as `READY` by that check. CARIS uses each CLI's existing
authentication and does not store credentials itself.

### 4. Create a plan or run a task

Create a plan without modifying files:

```powershell
caris plan "Add rate limiting to the login API"
```

Run the complete plan, implementation, verification, debugging, and review
workflow:

```powershell
caris run "Add rate limiting to the login API"
```

### 5. Use the interactive interface

```powershell
caris
```

Running `caris` without a subcommand opens the conversational REPL. Enter a
coding request directly. In a TTY terminal, CARIS opens an autocomplete TUI:

- Type `/` to search commands with the keyboard.
- Type `@` to search project files and attach them to the next request.
- Use `/model` to select each provider's model and effort for the session or
  save it to `caris.config.yaml`.
- Use `/plan`, `/run`, `/status`, `/roles`, `/budget`, `/diff`, `/log`,
  `/doctor`, `/resume`, `/clear`, and `/exit` for workflow control.

Use the line-oriented interface when terminal rendering is unavailable:

```powershell
caris --plain
```

Plain mode accepts model settings directly:

```powershell
caris --plain
/model codex gpt-5.5 high --save
/model claude sonnet medium --save
/model gemini auto
```

Gemini CLI does not expose a per-invocation effort option, so CARIS leaves its
thinking configuration at the provider default.

Recent and interrupted runs can also be inspected or resumed non-interactively:

```powershell
caris inspect
caris inspect <run-id>
caris resume <run-id>
```

## Source Development

This section is only for contributors working on CARIS itself. From the CARIS
source directory:

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Run the unlinked development entry point with `pnpm dev` followed by the normal
CARIS arguments:

```powershell
pnpm dev doctor
pnpm dev plan "Describe the repository"
```

## Runtime Data

Each run is checkpointed under `.caris/runs/<run-id>/`. The directory contains
the request, effective configuration, repository summary, plan, provider output,
workspace diff, verification results, review, events, and usage estimates. It is
ignored by Git because these artifacts can contain source context or sensitive
diagnostics.

CARIS never reads or stores provider credentials. Authentication remains owned
by each provider CLI.
