<a id="cli-and-modes-reference"></a>

# Command Line

This page documents Pi's built-in command-line commands and options. Run `pi --help` or append `--help` to a command for the exact interface in your installed version. The top-level help also includes options registered by loaded extensions.

```sh
pi [options] [--] [@files...] [messages...]
pi install <source> [options]
pi remove <source> [options]
pi uninstall <source> [options]
pi update [target] [options]
pi list
pi config [options]
pi auth login <provider> [--api-key] [--no-browser]
pi auth logout <provider>
pi auth <check|print-api-key|print-bearer-token> [options]
```

<a id="modes"></a>

## Invocation and output

```sh
pi
pi --print "Summarize this repository"
git diff | pi --print "Review this change"
pi --mode json "Inspect this repository" > events.jsonl
```

With terminal stdin and stdout, Pi opens the terminal UI unless `--print`, `--mode json`, or `--mode rpc` selects another interface. When either stream is redirected and neither JSON nor RPC mode is selected, Pi uses print mode. See [CLI Integration](cli-integration.md) for choosing between interactive, print, JSON, RPC, and SDK integration.

| Input | Behavior |
|---|---|
| `message` | Provide an initial prompt |
| `@path` | Include a text file or image in the first prompt |
| Piped stdin | Prepend its contents to the first prompt |
| `--` | Stop option parsing so a prompt can begin with `-` |

Pi resolves `@path` from the current working directory. The working directory also controls project configuration, resource discovery, and session grouping.

`--print` controls whether Pi runs once and exits. `--mode` selects the output interface. `--mode text` does not force one-shot execution when stdin and stdout are terminals; use `--print` for that behavior.

| Option | Behavior |
|---|---|
| `-p`, `--print` | Run the supplied prompts, write the final assistant text to stdout, then exit |
| `--mode text` | Select text output; still open the terminal UI when stdin and stdout are terminals |
| `--mode json` | Run the supplied prompts, write JSONL events to stdout, then exit |
| `--mode rpc` | Read JSONL commands from stdin and write responses and events to stdout until shutdown |
| `--export <input> [output]` | Export a session file to HTML and exit; derive the destination when `output` is omitted |

RPC mode rejects `@file` arguments. JSON and RPC modes reserve stdout for protocol records. See [JSON Event Stream](json.md) and [RPC Protocol](rpc.md).

<a id="model-options"></a>

## Models

```sh
pi --model sonnet:high
```

See [Choose a Model](models.md) for model selection and [Providers](providers.md) for credentials.

- `--provider <name>`<br>
  Restricts `--model` lookup to one provider. It requires `--model`.
- `--model <pattern>`<br>
  Selects by exact ID or fuzzy ID/name match. It accepts `provider/id` and an optional `:<thinking>` suffix. If several providers match, Pi prefers the one with credentials, otherwise it asks for `--provider`.
- `--api-key <key>`<br>
  Uses a non-persistent API-key override. It requires a model selected through `--model` or `--models`. It does not choose between providers that offer the same model.
- `--thinking <level>`<br>
  Sets `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. It overrides a `--model` suffix and is clamped to the model's capabilities.
- `--models <patterns>`<br>
  Sets a comma-separated scope for startup and cycling. It accepts exact IDs, fuzzy matches, case-insensitive globs, and optional `:<thinking>` suffixes. A model offered by several providers is added for each, with a warning.
- `--list-models [search]`<br>
  Lists available models, optionally filtered by a fuzzy search, then exits.

<a id="session-options"></a>

## Sessions

```sh
pi --continue
```

See [Sessions and Context](sessions.md) for resuming, forking, naming, and storing sessions.

- `-c`, `--continue`<br>
  Continues the most recent session for the current directory.
- `-r`, `--resume`<br>
  Opens the session selector and resumes the chosen session in its working directory. Press Tab to include sessions from other directories.
- `--session <path|id>`<br>
  Opens a session by file path or full/partial ID, and resumes it in its working directory. If the ID only matches sessions stored for another directory, Pi offers to fork it into the current directory instead.
- `--session-id <id>`<br>
  Opens the current directory's existing session with the ID, or creates it otherwise. IDs accept letters, numbers, `.`, `_`, and `-`.
- `--fork <path|id>`<br>
  Forks a session, chosen by file path or full/partial ID, into a new session in the current directory.
- `--session-dir <dir>`<br>
  Overrides storage and lookup. It takes precedence over `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting.
- `--no-session`<br>
  Uses an in-memory session that is not persisted.
- `-n`, `--name <name>`<br>
  Sets the session display name.

Constraints:

- Session IDs must start and end with a letter or number.
- `--fork` cannot be combined with `--session`, `--continue`, `--resume`, or `--no-session`.
- `--session-id` cannot be combined with `--session`, `--continue`, or `--resume`. Combine it with `--fork` to choose the new ID.

<a id="tool-options"></a>

## Tools

```sh
pi --tools read,grep,find,ls --print "Review this project"
```

See [Settings](settings.md#tools) for configuring the default tool selection.

- `-t`, `--tools <list>`<br>
  Replaces the default selection with a comma-separated allowlist of built-in, extension, or custom tools. Entries are tool names or patterns where `*` matches any characters. A list of only `+name` and `-name` entries is not an allowlist; it changes the default selection instead.
- `-xt`, `--exclude-tools <list>`<br>
  Disables comma-separated tool names or patterns after all other selection options.
- `-nbt`, `--no-builtin-tools`<br>
  Disables default built-in tools while retaining extension and custom tools.
- `-nt`, `--no-tools`<br>
  Starts with all built-in, extension, and custom tools disabled.

Default enabled tools are `read`, `bash`, `edit`, and `write`, unless `defaultTools` changes them. `--tools` with plain names replaces the whole selection, so name every tool you want. Like `defaultTools`, it also accepts a list of only `+name` and `-name` entries, which adds tools to or removes them from the default selection: `pi --tools +tool_search,-write` keeps the other default tools, enables tool search, and disables `write`. These entries take exact tool names, not `*` patterns; use `--exclude-tools` to disable tools by pattern. Plain names and `+name`/`-name` entries cannot be mixed. `/reload` enables tools newly added to `defaultTools`, but a tool removed with `-name` stays removed.

| Built-in | Purpose |
|---|---|
| `read` | Read text files and supported images |
| `bash` | Run shell commands |
| `powershell` | Run PowerShell commands on Windows |
| `edit` | Apply exact text replacements to an existing file |
| `write` | Create or overwrite a file |
| `grep` | Search file contents |
| `find` | Find paths using glob patterns |
| `ls` | List directory contents |

The built-in tool-search extension adds one tool, which is off by default. Enable it by naming it in `--tools` or `defaultTools`.

| Built-in extension | Purpose |
|---|---|
| `tool_search` | Search deferred tool metadata and declare matching tools for the next model call |

### Tool search

`tool_search` is off by default; enable it with `"defaultTools": ["+tool_search"]` or `--tools`. It ranks deferred tools and declares matching tools for the next model call. Loaded tools are recorded in the session like other tool changes, so they stay declared on that branch.

<a id="resource-options"></a>

## Resources

```sh
pi --extension ./review.ts
```

See [Configuration](configuration.md) for conventional directories and project trust, [Settings](settings.md#resources) for configured paths, and [Pi Packages](packages.md) for package sources.

- `-e`, `--extension <path>`<br>
  Loads an extension file or directory, or a built-in extension such as `builtin:llama.cpp`, and is repeatable.
- `-ne`, `--no-extensions`<br>
  Disables discovered, configured, and built-in extensions. Explicit `-e` paths still load.
- `--skill <path>`<br>
  Loads a skill file or directory and is repeatable.
- `-ns`, `--no-skills`<br>
  Disables discovered and configured skills. Explicit `--skill` paths still load.
- `--prompt-template <path>`<br>
  Loads a prompt-template file or directory and is repeatable.
- `-np`, `--no-prompt-templates`<br>
  Disables discovered and configured templates. Explicit `--prompt-template` paths still load.
- `--theme <path>`<br>
  Loads a theme file or directory and is repeatable.
- `--use-theme <name[/name]>`<br>
  Selects the initial interactive theme for this run.
- `--no-themes`<br>
  Disables discovered and configured themes. Explicit `--theme` paths still load.
- `-nc`, `--no-context-files`<br>
  Disables `AGENTS.md` and `CLAUDE.md` discovery.

Resource paths apply only to the current process. Relative paths resolve from the current working directory.

<a id="prompt-and-display-options"></a>

## Prompts and process

```sh
pi --append-system-prompt ./instructions.md
```

See [Configuration](configuration.md) for saved configuration, [Security](security.md#understand-project-trust) for project trust, and [Environment Variables](environment-variables.md) for process controls.

- `--system-prompt <text|path>`<br>
  Replaces the default system prompt with text or the contents of an existing file.
- `--append-system-prompt <text|path>`<br>
  Appends text or an existing file to the system prompt and is repeatable.
- `--tui-mode <mode>`<br>
  Uses `fullscreen` (default) or `regular` terminal mode.
- `--verbose`<br>
  Shows verbose interactive startup information, overriding `quietStartup`.
- `-a`, `--approve`<br>
  Trusts project-local configuration and resources for this process.
- `-na`, `--no-approve`<br>
  Ignores trust-gated project-local configuration and resources for this process.
- `--offline`<br>
  Disables automatic network activity, including model catalog refreshes. Equivalent to `PI_OFFLINE=1`.
- `-h`, `--help`<br>
  Shows help, including flags registered by loaded extensions, then exits.
- `-v`, `--version`<br>
  Shows the Pi version, then exits.

Extensions may register additional long-form options. Unknown short options are rejected.

## Package commands

```sh
pi install npm:@scope/package
```

See [Pi Packages](packages.md) for source formats, filtering, installation, and project scope.

### Common tasks

| Task | Command |
|---|---|
| Install a package | `pi install <source>` |
| List configured packages | `pi list` |
| Remove a package and its settings entry | `pi remove <source>` |
| Configure which package resources load | `pi config` |

Add `--local` or `-l` to `install`, `remove`, `uninstall`, or `config` to use project settings instead of global settings.

### Update Pi or packages

Running `pi update` without a target updates Pi itself.

| Task | Command |
|---|---|
| Update Pi | `pi update` |
| Update all installed packages | `pi update --extensions` |
| Update one installed package | `pi update <source>` |
| Refresh model catalogs | `pi update --models` |
| Update Pi and all installed packages | `pi update --all` |

Add `--force` to reinstall Pi when the selected update includes Pi.

`pi update` cannot update Pi when another package manager provides it, such as Nix. Update Pi with that package manager, for example `nix profile upgrade pi`. Package and model catalog updates still work.

#### Custom update command

If a wrapper or another package manager provides Pi, set `PI_SELF_UPDATE_COMMAND` so `pi update` runs its update command:

```sh
export PI_SELF_UPDATE_COMMAND="mise use -g npm:{packageName}@{version}"
```

`pi update` runs it only when pi.dev has a newer release, replacing `{packageName}`, `{version}`, and `{installSpec}` (`{packageName}@{version}`) with that release. The value is split on spaces. For arguments with spaces, use the `selfUpdateCommand` setting in `~/.pi/agent/settings.json` instead, an argv array such as `["nix", "profile", "upgrade", "pi"]`.

### Aliases and command options

- `pi uninstall <source>` is an alias for `pi remove <source>`.
- `pi update --self`, `pi update self`, and `pi update pi` are aliases for `pi update`.
- `pi update --extension <source>` is an alias for `pi update <source>`.
- `-a`, `--approve` trusts project-local files for one command. `-na`, `--no-approve` ignores trust-gated project-local files.
- Append `-h` or `--help` to a command for its exact usage and option constraints.

## Credential commands

`pi auth login <provider>` logs in to a provider in the terminal and exits, without starting a session. It signs in with an account and opens the browser, like `/login <provider>`. Providers without account sign-in ask for an API key. It requires an interactive terminal.

| Option | Description |
|---|---|
| `--api-key` | Save an API key instead of signing in with an account; the key is read without echoing it |
| `--no-browser` | Do not open a browser; use the provider's other sign-in method, such as a device code, for example over SSH. Asks when there are several. Not allowed with `--api-key` |

`pi auth logout <provider>` removes the credentials that `pi auth login` or `/login` stored, like `/logout`. Environment variables and `models.json` config are unchanged. It exits with status `0` when nothing is stored, so it is safe to repeat.

```sh
pi auth login anthropic
pi auth logout anthropic
pi auth check --provider openai --json
```

The other authentication commands require `--provider <provider>` or `--model <model>`. See [Providers](providers.md) for supported methods.

| Command | Description |
|---|---|
| `pi auth check` | Print `ready`, `not_ready`, or `invalid`; exit with status `0`, `1`, or `2`, respectively |
| `pi auth print-api-key` | Print the resolved API key |
| `pi auth print-bearer-token` | Print a resolved OAuth bearer token |

| Option | Applies to | Description |
|---|---|---|
| `--provider <provider>` | All | Resolve credentials for a provider |
| `--model <model>` | All | Resolve credentials from a model; may be combined with `--provider` |
| `--json` | `auth check` | Write the structured result as JSON |
| `--credentials` | `auth check` | Emit the resolved credential when ready |
| `--no-refresh` | `auth check` | Do not refresh expired OAuth credentials; refresh is the default |
| `--min-expiry <duration>` | `print-bearer-token` | Require remaining token lifetime using `ms`, `s`, `m`, or `h`, such as `30m` |

Credential-printing commands write secrets to stdout.
