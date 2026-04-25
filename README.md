# openpave-wiki

📚 LLM-maintained personal knowledge base over PAVE session history.

Implements [Andrej Karpathy's LLM-Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) on top of PAVE: raw session history is the immutable source corpus, and an LLM curator agent maintains a structured markdown wiki at `~/.pave/wiki/` with entities, concepts, decisions, and learnings — all cross-referenced back to source sessions.

## Installation

```bash
# From local directory
pave install ~/pave-apps/openpave-wiki

# From marketplace (after publish)
pave install wiki
```

## Concept

PAVE stores every session, message, and tool part to `~/.pave/state/`. That's a goldmine of context but unreadable as raw JSON. This skill provides:

1. **Read access** to the raw corpus (`list-sessions`, `read-session`)
2. **Read/write access** to a curated wiki (`read-page`, `write-page`, `append-log`)
3. **Bookkeeping** for an LLM curator agent (`processed`, `search`, `stats`)

The wiki itself lives at `~/.pave/wiki/` and is governed by an `AGENTS.md` schema file that defines page formats (entities, concepts, decisions, learnings, sources) and ingest/query/lint procedures.

## Setup

After installing, seed the wiki directory:

```bash
mkdir -p ~/.pave/wiki/{entities/{people,projects,agents,systems},concepts,decisions,learnings,sources}
# Write your own AGENTS.md schema, index.md, log.md
# (See ~/.pave/wiki/AGENTS.md example in this repo's docs)
```

Then spawn a curator agent to maintain it:

```bash
pave agent --soul ~/.pave/souls/wiki-curator.md --sleep 6h --name wiki-curator
```

## Commands

| Command | Description |
|---------|-------------|
| `list-sessions` | List sessions, newest first; supports `--unprocessed`, `--since`, `--dir`, `--limit` |
| `read-session <id>` | Dump session metadata + ordered messages + parts as markdown |
| `list-pages` | List wiki pages, optionally filtered by `--category` |
| `read-page <path>` | Read a wiki page (path relative to `~/.pave/wiki/`) |
| `write-page <path> --content TEXT` | Create or overwrite a wiki page (use `--append` to append) |
| `append-log --kind <k> --summary <s> [--session <id>]` | Append dated entry to `wiki/log.md` |
| `processed <id>` | Exit 0 if session is already in the log, 2 otherwise |
| `search <pattern>` | Plain grep over wiki/ markdown |
| `stats` | Counts of sessions, messages, parts, wiki pages |

All commands support `--json` for machine output and `--help` for inline usage.

## Usage Examples

```bash
# See what's in the corpus
pave run wiki stats

# List 5 oldest unprocessed sessions
pave run wiki list-sessions --unprocessed --limit 5

# Read one as markdown
pave run wiki read-session 01KP51HP67TRSAQH5GHDB7THEQ --max-chars 4000

# Read the wiki index
pave run wiki read-page index.md

# Search the wiki
pave run wiki search "hacker mode"

# Append an ingest log entry
pave run wiki append-log --kind ingest --session 01KP... --summary "touched 3 pages"
```

## Security

This skill uses the PAVE sandbox:
- **Read-only** access to `~/.pave/state/**`
- **Read/write** access to `~/.pave/wiki/**`
- **No network**, no shell, no other filesystem access

The wiki may contain sensitive content (emails, messages, HR data, etc.) — treat `~/.pave/wiki/` as equally sensitive as `~/.pave/state/`.

## License

MIT
