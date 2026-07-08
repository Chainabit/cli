# @chainabit/cli

The official Chainabit CLI — a terminal control plane for workspaces, chains, AI, and connectors.

## Installation

```bash
npm install -g @chainabit/cli
```

Requires Node.js ≥ 20.

## Quick start

```bash
# Log in
chainabit auth login

# Pin your workspace
chainabit workspace use <workspace-id>

# Open the AI shell
chainabit

# Or send a one-shot message
chainabit chao --message "Summarize my progress this week"
```

## Command groups

| Group | Description |
|---|---|
| `auth` | Login, logout, tokens, API keys, device flow |
| `workspace` | Pin workspace context, list workspaces |
| `account` | Account profile and settings |
| `wallet` | Wallet management |
| `chainy` | Chain and workflow management — list, create, manage |
| `chain` | Chains and streaks — list, get, create, delete |
| `bit` | Individual bits / micro-actions |
| `contribution` | Contribution tracking and history |
| `ai` | Chat with Chao inline |
| `chao` | Streaming AI chat with verbose agent phases |
| `connectors` | Install, authenticate, and execute connectors |

Add `--help` to any command or subcommand for detailed usage and examples.

## Global flags

| Flag | Description |
|---|---|
| `--json` | Machine-readable output (respected by every command) |
| `--api-url <url>` | Override the API endpoint for this invocation |
| `--env-file <path>` | Load env vars from a file |

## Configuration

The CLI stores credentials in `~/.chainabit/config.json` after login. You can also supply
environment variables directly or via a file:

```bash
# Load from a file for this command only
chainabit --env-file .env.local chain list

# Or export for the whole shell session
export CHAINABIT_BASE_URL=https://api.chainabit.com/api/v1
export CHAINABIT_TOKEN=cbt_live_...
chainabit chain list
```

See [`.env.example`](./.env.example) for all supported variables.

## License

See [chainabit.com/legal](https://chainabit.com/legal) for terms of service.
