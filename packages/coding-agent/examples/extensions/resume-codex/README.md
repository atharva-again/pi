# @atharva-again/pi-resume-codex

Continue a Codex conversation in Pi without copying context by hand.

`/resume-codex` imports a local Codex CLI, desktop, or IDE session as native Pi history while keeping foreign reasoning, tool activity, attachments, and unfinished output out of the model context.

## Install

```bash
pi install npm:@atharva-again/pi-resume-codex
```

Requirements:

- Pi 0.80.7 or newer
- A recent `codex` CLI available on `PATH`
- An existing local Codex session

The extension has been tested with Codex CLI 0.144.5.

## Use

Run the command from the project whose sessions you want to browse:

```text
/resume-codex
```

The picker starts with Codex sessions from Pi's current directory.

- Press Tab to switch between **Current Directory** and **All** sessions.
- Type to search by title, directory, source, or thread ID.
- Select a session to import it into a new native Pi session.
- Press Escape while discovering or reading to cancel.

If you already know the full Codex thread ID, skip the picker:

```text
/resume-codex 019f5f7c-1de1-77d1-b12f-972d618e845f
```

Importing from another directory requires confirmation. Pi keeps its current working directory rather than switching to the source directory.

## Supported Codex clients

Codex CLI, Codex desktop, and the Codex IDE extension share local Codex history. The picker includes interactive sessions created by these clients.

Regular ChatGPT conversations are not supported. They are cloud-backed and use a separate data-export workflow.

## What gets imported

Only deterministic conversation text is added to Pi's model context:

- User text
- Assistant text from completed turns

The following Codex data is deliberately excluded:

- Reasoning and plans
- Commands, tool calls, and their output
- File changes
- Hook and system prompts
- Attachments and images
- Skills and mentions
- Subagent activity
- Failed, interrupted, or unfinished assistant output

The result is a Pi session that appears as recent in `/resume` and can be continued with the active Pi model.

## Security

The extension uses the installed Codex app-server instead of reading or modifying Codex's SQLite databases or internal rollout files directly.

- Discovery and history reads use Codex's documented read APIs.
- The app-server runs only while discovery or import is active and is terminated afterward.
- Foreign tools and tool results are never recreated as executable Pi history.
- Protocol output, stderr, session counts, turns, and items have defensive limits.

## Local development

Load the extension directly from this directory:

```bash
pi -e ./index.ts
```

Source is maintained in the [`atharva-again/pi`](https://github.com/atharva-again/pi/tree/main/packages/coding-agent/examples/extensions/resume-codex) monorepo.
