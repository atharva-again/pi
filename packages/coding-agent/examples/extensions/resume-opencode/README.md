# @atharva-again/pi-resume-opencode

Continue an OpenCode conversation in Pi without copying context by hand.

`/resume-opencode` imports an OpenCode session as native Pi history while keeping foreign reasoning, tool calls, tool results, attachments, and failed output out of the model context.

## Demo

https://github.com/user-attachments/assets/f226f3ad-459d-4d92-b39d-f97bbd378e8f


## Install

```bash
pi install npm:@atharva-again/pi-resume-opencode
```

Requirements:

- Pi 0.80.7 or newer
- The `opencode` CLI available on `PATH`
- An existing OpenCode database

The extension has been tested with OpenCode 1.17.20.

## Use

Run the command from the project whose sessions you want to browse:

```text
/resume-opencode
```

The picker starts with OpenCode sessions from Pi's current directory.

- Press Tab to switch between **Current Directory** and **All** sessions.
- Type to search by title, directory, or session ID.
- Select a session to import it into a new native Pi session.
- Press Escape while discovering or exporting to cancel.

If you already know the full OpenCode session ID, skip the picker:

```text
/resume-opencode ses_abc123
```

Importing from another directory requires confirmation. Pi keeps its current working directory rather than switching to the source directory.

## What gets imported

Only deterministic conversation text is added to Pi's model context:

- Real user text
- Completed, non-error assistant text

The following OpenCode data is deliberately excluded:

- Reasoning
- Tool calls and tool results
- System prompts
- Attachments and file contents
- Synthetic or ignored text
- Compaction summaries
- Errored or incomplete assistant responses

The result is a Pi session that appears as recent in `/resume` and can be continued with the active Pi model.

## Security

The extension uses the installed OpenCode CLI instead of reading or modifying OpenCode's SQLite database directly.

- Discovery uses fixed SQL and fixed command arguments.
- Exported transcripts are captured in an owner-only temporary file and deleted after reading.
- Foreign tools and tool results are never recreated as executable Pi history.
- Exports have no timeout or size cap; interactive exports can still be cancelled with Escape.

## Local development

Load the extension directly from this directory:

```bash
pi -e ./index.ts
```

Source is maintained in the [`atharva-again/pi`](https://github.com/atharva-again/pi/tree/main/packages/coding-agent/examples/extensions/resume-opencode) monorepo.
