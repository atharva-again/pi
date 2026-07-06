# pi Telegram

Experimental Telegram client for pi, published as `@atharva-again/pi-tg` with the `pi-tg` binary.

## Quick start

1. Install the package:

```bash
npm install -g @atharva-again/pi-tg
```

2. Create a Telegram bot with [@BotFather](https://t.me/BotFather).
3. Find your Telegram numeric user ID with [@userinfobot](https://t.me/userinfobot).
4. Run setup:

```bash
pi-tg setup
pi-tg doctor
pi-tg
```

Setup writes `~/.pi/agent/telegram/config.json` with `0600` permissions. Flags and
`PI_TELEGRAM_*` environment variables still work and override the saved config.

The bot uses the same pi provider configuration and credentials as the CLI.
Authorized Telegram users inherit the filesystem and shell permissions of the
user running `pi-tg`.

## Non-interactive start

```bash
PI_TELEGRAM_BOT_TOKEN=123:abc \
PI_TELEGRAM_ALLOWED_USERS=123456789 \
pi-tg
```

## Telegram UX

- A normal DM is one pi session by default.
- Telegram registers Pi's 22 built-in slash commands plus Telegram-native `/start` and `/help`.
- Workspace extension, prompt, and skill commands are added to the per-chat slash menu when a Pi runtime is available.
- `/scoped_models` is the Telegram-safe alias for Pi's `/scoped-models` command.
- Menu-like commands use inline buttons, confirmations, document upload/download, and per-chat pending prompts.
- Workspace changes are available from `/settings` and `/session` buttons without adding an extra slash command.
- Normal messages are sent to pi with full tool access as the user running `pi-tg`.

## Commands

Telegram-native commands:

- `/start` - start the Telegram client and show help
- `/help` - show help and command list

Pi commands:

- `/settings` - button menu for model, thinking, scoped models, workspace, session, auth, trust, and reload actions
- `/model` - provider/model picker followed by thinking-level buttons; also accepts `/model provider/model [thinking]`
- `/scoped_models` - session-scoped model checklist for Pi model cycling
- `/export` - choose HTML or JSONL and receive the export as a Telegram document
- `/import` - import a local JSONL path or upload a `.jsonl` Telegram document
- `/share` - confirm and create a Pi share link through the local `gh` CLI
- `/copy` - send the last assistant response as copyable Telegram text
- `/name` - show or set the session name; no-arg flow prompts for a new name
- `/session` - session dashboard with action buttons
- `/changelog` - paginated changelog viewer
- `/hotkeys` - explain Telegram equivalents for TUI hotkeys
- `/fork` - pick a prior user message with buttons or pass an entry id
- `/clone` - confirmation flow for cloning the current session
- `/tree` - compact tree view with buttons to navigate branches
- `/trust` - show Telegram/process trust state and local trust guidance
- `/login` - local-login guidance; credentials are not collected in chat
- `/logout` - local-logout guidance for destructive credential removal
- `/new` - confirmation flow for a new session
- `/compact` - compact now or prompt for custom instructions
- `/resume` - recent-session picker or `/resume <id-or-path>`
- `/reload` - reload keybindings, extensions, skills, prompts, and themes
- `/quit` - private-chat confirmation to stop `pi-tg`
