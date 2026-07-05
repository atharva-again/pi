# pi Telegram

Experimental Telegram client for pi.

## Quick start

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather).
2. Find your Telegram numeric user ID with [@userinfobot](https://t.me/userinfobot).
3. Start the bot from any directory where pi can run:

```bash
PI_TELEGRAM_BOT_TOKEN=123:abc \
PI_TELEGRAM_ALLOWED_USERS=123456789 \
pi-telegram
```

The bot uses the same pi provider configuration and credentials as the CLI.
Authorized Telegram users inherit the filesystem and shell permissions of the
user running `pi-telegram`.

## Telegram UX

- A normal DM is one pi session by default.
- Telegram registers Pi's 22 built-in slash commands plus Telegram-native `/start` and `/help`.
- `/scoped_models` is the Telegram-safe alias for Pi's `/scoped-models` command.
- Menu-like commands use inline buttons, confirmations, document upload/download, and per-chat pending prompts.
- Workspace changes are available from `/settings` and `/session` buttons without adding an extra slash command.
- Normal messages are sent to pi with full tool access as the user running `pi-telegram`.

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
- `/quit` - private-chat confirmation to stop `pi-telegram`
