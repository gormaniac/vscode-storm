<p align="center"><img src="https://raw.githubusercontent.com/gormaniac/vscode-storm/main/images/icon.png" width="128" alt=""></p>

# Synapse Storm for VS Code

Highlighting, lint, completion and hover docs for the [Synapse](https://github.com/vertexproject/synapse)
Storm query language, in `.storm` files and in ```` ```storm ```` blocks in Markdown.

Includes a language server using a live Cortex (default local or production with live installed packages) to provide completion and documentation on hover features.

## How it works

* **Highlighting** is a TextMate grammar ([syntaxes/storm.tmLanguage.json](https://github.com/gormaniac/vscode-storm/blob/main/syntaxes/storm.tmLanguage.json)). It
  needs nothing else.
* **Lint, completion and hover** come from a small language server,
  [server/stormls.py](https://github.com/gormaniac/vscode-storm/blob/main/server/stormls.py). The extension starts it with Python and talks to it with JSON lines
  on stdio. It parses Storm with Synapse's own parser and checks it against a Cortex's metadata (data model,
  commands, `$lib`, packages). Queries are never run.
  * By default the server starts a **temporary Cortex** in its own process. There is no network and nothing
    is kept. It starts in about 2 seconds and gives you the Synapse core model, every built-in command and
    every `$lib` library, for the Synapse version you have installed.
  * **Storm: Connect to Cortex...** checks against a **real Cortex** over telepath instead. You get its
    extended model, installed packages (with their commands' arguments) and tag completion. The server
    refreshes its copy of the metadata every 60s. The URL is kept in VS Code's secret storage.

There are no npm dependencies. The extension is plain JavaScript using only the `vscode` API.

## Getting started

Highlighting works as soon as the extension is installed. Lint, completion and hover need a Python with
`synapse` installed:

```bash
python3 -m venv ~/.venvs/storm
~/.venvs/storm/bin/pip install synapse
```

Then point the extension at it. Run **Storm: Select Python...** or set `storm.pythonPath`:

```json
"storm.pythonPath": "~/.venvs/storm/bin/python"
```

If the Python it finds has no `synapse`, the extension says so the first time you open a `.storm` file and
offers to pick another one.

## Lint rules

| Rule | Severity | Finds |
| --- | --- | --- |
| `E001` | error | Syntax errors from the Storm parser, at the exact line and column |
| `E002`, `E003`, `R*`, `P*`, `S*`, `M*` | varies | Synapse's own `StormLinter` rules |
| `N001` | error | A form or full prop (`inet:fqdnx`, `inet:fqdn:newp`) that is not in the data model |
| `N002` | error | An unknown relative prop (`:newp`) for the forms in the pipeline |
| `N003` | error | An unknown Storm command |
| `N004` | error | Bad command arguments, checked by the command's own argument parser (constant args only) |
| `N005` | error | An unknown `$lib` library or member |
| `N006` | warning | A variable that is used but never set |

## Completion and hover

| Where you type | What it suggests |
| --- | --- |
| `inet:fq` | Forms |
| `inet:fqdn:` | Full props, with their types |
| `:zo` | Relative props of the forms in the query |
| `.` | Universal props |
| `\| li` (also after a pipe at the end of the previous line) | Commands |
| `$lib.` / `$lib.str.` | Libraries and members, with signatures |
| `#cno.` | Tags (only when connected to a Cortex) |

Hover over a form, prop, command or `$lib` name to see its docs.

## Settings and commands

| Setting | Default | |
| --- | --- | --- |
| `storm.pythonPath` | `""` | The Python that runs the server (it needs `synapse`) |
| `storm.lint.enabled` | `true` | Check as you type |
| `storm.lint.delay` | `250` | Milliseconds to wait after typing stops |

Commands: **Storm: Select Python...**, **Storm: Connect to Cortex...**, **Storm: Use a Temporary Cortex**,
**Storm: Restart Language Server** and **Storm: Show Output**. Click the Storm item in the status bar for the same list.

If you have another Storm extension (for example `jeroenvda.synapsestorm`), disable it. Both claim `.storm`.

## Development

Build and install a local copy (no Node.js needed):

```bash
python3 scripts/package.py
code --install-extension vscode-storm-0.1.0.vsix
```

To release, bump `version` in `package.json`, add it to `CHANGELOG.md`, then push a matching tag. The
[release workflow](https://github.com/gormaniac/vscode-storm/blob/main/.github/workflows/release.yml) runs the
tests and publishes to the Visual Studio Marketplace (and Open VSX when `OVSX_PAT` is set):

```bash
git tag v0.1.0 && git push origin v0.1.0
```

## Tests

Neither test needs a Node.js install. `test/node` runs scripts with the Node.js built into VS Code.

```bash
./test/node test/grammar.test.js
STORM_PYTHON=/path/to/venv/bin/python ./test/node test/extension.test.js
```

The grammar tests tokenize with VS Code's own TextMate engine. The extension tests drive the real
completion, hover and lint code against the real language server, with a small stand-in for the `vscode`
module.
