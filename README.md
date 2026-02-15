# KernelBot

AI engineering agent — a Telegram bot backed by Claude Sonnet with full OS control via tool use.

Send a message in Telegram, and KernelBot will read files, write code, run commands, and respond with the results. It's your personal engineering assistant with direct access to your machine.

## How It Works

```text
You (Telegram) → KernelBot → Claude Sonnet (Anthropic API)
                                   ↕
                             OS Tools (shell, files, directories)
```

KernelBot runs a **tool-use loop**: Claude decides which tools to call, KernelBot executes them on your OS, feeds results back, and Claude continues until the task is done. One message can trigger dozens of tool calls autonomously.

## Tools

| Tool              | Description                                         |
| ----------------- | --------------------------------------------------- |
| `execute_command` | Run any shell command (git, npm, python, etc.)      |
| `read_file`       | Read file contents with optional line limits        |
| `write_file`      | Write/create files, auto-creates parent directories |
| `list_directory`  | List directory contents, optionally recursive       |

## Installation

```bash
npm install -g kernelbot
```

## Quick Start

```bash
kernelbot
```

That's it. On first run, KernelBot will:

1. Detect missing credentials and prompt for them
2. Save them to `~/.kernelbot/.env`
3. Verify API connections
4. Launch the Telegram bot

## Configuration

KernelBot auto-detects config from the current directory or `~/.kernelbot/`. Everything works with zero config — just provide your API keys when prompted.

### Environment Variables

Set these in `.env` or as system environment variables:

```text
ANTHROPIC_API_KEY=sk-ant-...
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
```

### `config.yaml` (optional)

Drop a `config.yaml` in your working directory or `~/.kernelbot/` to customize behavior:

```yaml
bot:
  name: KernelBot

anthropic:
  model: claude-sonnet-4-20250514
  max_tokens: 8192
  temperature: 0.3
  max_tool_depth: 25 # max tool calls per message

telegram:
  allowed_users: [] # empty = allow all (dev mode)
  # allowed_users: [123456789]  # lock to specific Telegram user IDs

security:
  blocked_paths: # paths the agent cannot touch
    - /etc/shadow
    - /etc/passwd

logging:
  level: info
  max_file_size: 5242880 # 5 MB

conversation:
  max_history: 50 # messages per chat
```

## Security

- **User allowlist** — restrict bot access to specific Telegram user IDs. Empty list = dev mode (anyone can use it).
- **Blocked paths** — files/directories the agent is forbidden from reading or writing (e.g., `/etc/shadow`, SSH keys).
- **Audit logging** — every tool call is logged to `kernel-audit.log` with user, tool, params, result, and duration. Secrets in params are automatically redacted.
- **Command timeout** — shell commands are killed after 30 seconds by default.

## Project Structure

```text
KernelBot/
├── bin/
│   └── kernel.js           # Entry point
├── src/
│   ├── agent.js            # Sonnet tool-use loop
│   ├── bot.js              # Telegram bot (polling, auth, message handling)
│   ├── conversation.js     # Per-chat conversation history
│   ├── prompts/
│   │   └── system.js       # System prompt
│   ├── security/
│   │   ├── auth.js         # User allowlist
│   │   └── audit.js        # Tool call audit logging
│   ├── tools/
│   │   ├── os.js           # OS tool definitions + handlers
│   │   └── index.js        # Tool registry + dispatcher
│   └── utils/
│       ├── config.js       # Config loading (auto-detect + prompt)
│       ├── display.js      # CLI display (logo, spinners, banners)
│       └── logger.js       # Winston logger
├── config.example.yaml
├── .env.example
└── package.json
```

## Requirements

- Node.js 18+
- [Anthropic API key](https://console.anthropic.com/)
- [Telegram Bot Token](https://t.me/BotFather)

## Author

Abdullah Al-Taheri
