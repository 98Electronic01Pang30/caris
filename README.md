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

Move to the project directory where you want to use the coding agents. A Git
repository is recommended because it enables diff tracking and recovery. Do not run
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
Code, Gemini CLI, and Antigravity (`agy`). CARIS searches `PATH`, npm and pnpm user bins, and common
provider install locations, then reports the selected executable and duplicate
candidates. `INSTALLED` does not verify authentication. Use
`caris doctor --live` to make a minimal authenticated call to each installed
provider; this may consume provider tokens. A live workflow requires at least
one provider reported as `READY` by that check. CARIS uses each CLI's existing
authentication and does not store credentials itself.

`doctor` also reports `Workspace: Git` or `Workspace: Directory`. In Directory
mode, planning and read-only Roles work normally, while CARIS warns before the
first modifying Role because Git diff and recovery are unavailable. CARIS does
not initialize Git automatically. Run `git init`, add the intended files, and
create a baseline commit when you want Git-backed change tracking.

### 4. Run individual roles

Create a plan without modifying files:

```powershell
caris plan "Add rate limiting to the login API"
```

Continue the same manual run with its ID:

```powershell
caris implement "Implement the approved API design" --run-id <run-id>
caris verify "Verify the new rate limiting behavior" --run-id <run-id>
caris debug "Fix the failed rate limit test" --run-id <run-id>
caris review "Review security and regressions" --run-id <run-id>
```

Interactive CARIS asks once before Implement or Debug modifies a non-Git
directory. A non-interactive modifying command must opt in explicitly:

```powershell
caris implement "Implement the change" --run-id <run-id> --allow-non-git-write
```

Each command invokes only its configured Role. `/verify` runs configured commands
and then asks the verifier Role to assess the latest implemented or debugged behavior.
It never starts debugging automatically.

Start a checkpointed plan, implementation, verification, debugging, and review
workflow:

```powershell
caris run "Add rate limiting to the login API"
```

CARIS stops after every step. Enter `Y` to continue, `N` to pause the run, or
custom feedback to revise the completed step. Verification feedback is routed
to the implementer before verification runs again. Review requires a final
approval before the run is marked complete.

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
- Use `/plan`, `/implement`, `/debug`, `/verify`, `/review`, `/run`, `/status`, `/roles`, `/budget`, `/diff`, `/log`,
  `/transcript`, `/doctor`, `/resume`, `/clear`, and `/exit` for workflow control.

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

Gemini CLI and Antigravity do not expose CARIS-compatible per-invocation effort
options, so CARIS leaves their thinking configuration at the provider default.

Recent and interrupted runs can also be inspected or resumed non-interactively:

```powershell
caris inspect
caris inspect <run-id>
caris resume <run-id>
caris resume <run-id> --approve
caris resume <run-id> --reject
caris resume <run-id> --feedback "Include migration risks"
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

After each Role completes, CARIS displays the provider's human-readable chat,
tool calls and results, and the complete current workspace diff. Provider JSONL
protocol output remains in the raw call artifact. Human-readable per-call files
are stored as `agent-transcript-N.md`/`.json`, with the full run conversation in
`transcript.md`.

CARIS never reads or stores provider credentials. Authentication remains owned
by each provider CLI.
