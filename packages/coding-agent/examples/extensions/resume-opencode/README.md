# pi-resume-opencode

A Pi extension that imports an OpenCode session into a new native Pi session.

## Requirements

- Pi 0.80.7 or newer
- An installed `opencode` CLI with the `db` and `export` commands
- An existing OpenCode database

The extension has been tested against OpenCode 1.17.20.

## Install

From npm:

```bash
pi install npm:pi-resume-opencode@0.1.0
```

For local development:

```bash
pi -e ./index.ts
```

If this directory is moved to the root of a dedicated Git repository, users can also install a pinned release directly:

```bash
pi install git:github.com/OWNER/pi-resume-opencode@v0.1.0
```

## Usage

Open the interactive picker:

```text
/resume-opencode
```

Or import a known full OpenCode session ID:

```text
/resume-opencode ses_abc123
```

Discovery and export show cancellable progress spinners. The searchable picker starts with sessions from Pi's current working directory; press Tab to switch between current-directory and all root, non-archived sessions. It shows each session's title, update time, ID, and directory when viewing all sessions. Importing a session from another directory requires confirmation and keeps Pi's current working directory.

## Import policy

The extension imports only:

- Real user text
- Completed, non-error assistant text

It intentionally omits:

- Reasoning
- Tool calls and tool results
- System prompts
- Attachments and file contents
- Synthetic or ignored text
- Compaction summaries
- Errored or incomplete assistant responses

The extension records source IDs, content hashes, omission counts, source metadata, and the export fingerprint as a custom Pi entry. This provenance is not sent to the model.

Imported history is limited to half of the active model's context window, capped at 100,000 estimated tokens. Older messages are omitted first. Oversized retained messages are truncated deterministically.

## Publishing

The npm package name `pi-resume-opencode` was unclaimed when this package was created. Verify availability before publishing:

```bash
npm view pi-resume-opencode version
```

Inspect the package contents, then publish from this directory:

```bash
npm pack --dry-run
npm publish --access public
```

For later releases, update the version and install examples before publishing.

## Security

The extension executes the local `opencode` binary with fixed argument arrays and fixed SQL. It never writes to OpenCode's database. Because OpenCode can truncate large exports written to a pipe, the extension captures export output in an owner-only temporary file, reads it, and deletes it immediately. Exports have no timeout or size cap; Escape still cancels an export in interactive mode. Extensions run with the user's full permissions; review the source before installation.
