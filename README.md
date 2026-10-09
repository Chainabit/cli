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

| Group          | Description                                           |
| -------------- | ----------------------------------------------------- |
| `auth`         | Login, logout, tokens, API keys, device flow          |
| `workspace`    | Pin workspace context, list workspaces                |
| `account`      | Account profile and settings                          |
| `wallet`       | Wallet management                                     |
| `chainy`       | Chain and workflow management — list, create, manage  |
| `chain`        | Executable workflows — list, get, create, run, delete |
| `bit`          | Executable atomic tasks used independently or in Chains |
| `contribution` | Contribution tracking and history                     |
| `ai`           | Chat with Chao inline                                 |
| `chao`         | Streaming AI chat with verbose agent phases           |
| `connectors`   | Install, authenticate, and execute connectors         |

Add `--help` to any command or subcommand for detailed usage and examples.

## Global flags

| Flag                | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `--json`            | Machine-readable output (respected by every command) |
| `--api-url <url>`   | Override the API endpoint for this invocation        |
| `--env-file <path>` | Load env vars from a file                            |

## Creating an automation key

Create the key from your signed-in human session before configuring CI:

```bash
chainabit auth keys create "github-actions" --ttl 90 --scope execution:run
```

When the server requires identity verification, the CLI asks for your account
password without displaying it and completes any required authenticator step.
It retries the same key request once after verification. Cancelling or providing
incorrect verification evidence creates no key.

JSON mode never prompts. Explicit verification input can be supplied with
`--password-env`, `--password-file`, or `--password-stdin`, and `--totp-env` when
an authenticator is required. Use the issued scoped key from your CI secret store
for unattended jobs. The key is displayed only once when it is created.

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

## Local conversations

Chats started with `chainabit chao`, the interactive shell, and `chainabit code`
keep their history on this computer. Chainabit still requires authenticated API
access for inference, tools, models, and usage enforcement.

```bash
chainabit chao --message "Explain this project"
chainabit sessions list
chainabit resume <conversation-id>
chainabit resume --last
chainabit chao --session <conversation-id> --message "Continue"
chainabit sessions show <conversation-id>
```

History is scoped to the API endpoint, account, workspace, and project directory.
Switching accounts or workspaces selects separate local history. Logging out
preserves local history; sending a message requires current authorization. Saved
history can be reviewed offline after its scope has been established online.

Closing the CLI preserves the current conversation. `/retry` reconnects the last
execution using its original identity. Sending another message first reconciles
an interrupted turn. During a running turn, the first Ctrl+C requests cancellation;
a second Ctrl+C exits. A closed connection may leave server work running, so
reconnection checks its authoritative result before submitting more work.

History stays until you delete it:

```bash
chainabit sessions delete <conversation-id>
chainabit sessions prune --before 2026-01-01
chainabit sessions prune --before 2026-01-01 --apply
chainabit sessions reset --yes
```

Pruning previews changes unless `--apply` is supplied. Reset deletes settled
conversations in the current scope. Unresolved executions and unreadable files
are preserved for recovery.

Default storage locations are `~/Library/Application Support/Chainabit/cli` on
macOS, `$XDG_DATA_HOME/chainabit/cli` (or `~/.local/share/chainabit/cli`) on Linux,
and `%LOCALAPPDATA%\Chainabit\cli` on Windows. `CHAINABIT_DATA_DIR` selects an
alternative local data directory. Credential storage is separate from chat files.

`chainabit ai sessions` continues to manage cloud conversations. Importing an
existing cloud conversation is explicit:

```bash
chainabit sessions import <cloud-session-id>
```

Local chat requires an API version supporting local conversation executions.
An older API produces an upgrade error; it does not silently create a cloud chat.
