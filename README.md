# Infinite Memory — OpenClaw Plugin

Persistent, local-first memory and RAG. Every conversation stored permanently in SQLite with hybrid BM25 + vector search, temporal decay, rolling summaries, and document collections. Nothing leaves your server.

---

## Files

```
infinite-memory/
├── index.ts               ← plugin (single TypeScript file)
├── openclaw.plugin.json   ← plugin manifest
├── scripts/
│   ├── embed.py           ← embedding helper (called by Node via subprocess)
│   └── ingest.py          ← document ingestion (SemanticChunker + BGE-M3)
└── README.md
```

---

## Install

### Step 1 — Python dependencies

```bash
pip install fastembed langchain-experimental langchain-community pdfplumber python-docx --break-system-packages
```

`fastembed` downloads the BGE-M3 model (~1.2 GB) on first use. Subsequent runs load it from cache.

### Step 2 — sqlite-vec (vector search)

Download the compiled extension for your platform from:
**https://github.com/asg017/sqlite-vec/releases**

Place the `.so` (Linux) or `.dylib` (macOS) at any of these paths:
```
/usr/local/lib/vec0.so
/usr/lib/sqlite3/vec0.so
~/.local/lib/vec0.so
```

Verify it loaded correctly later with `openclaw memory stats`.

### Step 3 — Install the plugin

```bash
openclaw plugins install ./infinite-memory
```

Or link in place for development (no copy):
```bash
openclaw plugins install -l ./infinite-memory
```

### Step 4 — Configure `openclaw.json`

```json
{
  "plugins": {
    "slots": {
      "memory": "infinite-memory"
    },
    "entries": {
      "infinite-memory": {
        "enabled": true,
        "config": {
          "workspacePath": "/home/youruser/.openclaw/workspace",
          "summarizationModel": "ollama/qwen3:8b"
        }
      }
    }
  }
}
```

`workspacePath` defaults to `~/.openclaw/workspace` if omitted.

### Step 5 — Restart the gateway

```bash
openclaw gateway restart
```

That's it. Memory is now active on every conversation.

---

## How It Works

Every message is stored to `memory.db` before the LLM is called. Before each LLM call the plugin assembles a three-band context block and injects it into the system prompt:

```
[Conversation Summary — messages 11–30, compressed]
[Semantic Search Results — messages 11+, ranked by relevance + recency]
[Last 10 messages verbatim]
[Current message]
```

**Temporal decay** — older conversation memories naturally score lower in retrieval as newer content takes over. Half-life defaults to 90 days. RAG documents never decay.

**Sanitization** — injected context markers are stripped from assistant responses before storage, preventing the plugin's own output from polluting future searches.

**Semantic search overlaps the summary band** (both start at message 11). The summary is lossy compression. The semantic search is a safety net that can surface exact details the summary may have dropped.

---

## Natural Language Settings

These commands are intercepted before the LLM — no LLM call is made for them.

### Channels
```
switch to my work channel
create a new channel called research
what channel am I on?
list my channels
rename this channel to project_x
sync telegram to my open webui channel
```

### Memory behaviour
```
increase my short term memory to 20 messages
summarize every 30 messages
give me more context
make older memories fade faster          → decay half-life = 30 days
never forget anything                    → disables decay entirely
use phi4 for summaries
```

### Document collections
```
list my collections
search only work and resume collections
search all collections
what collections are you searching?
```

---

## CLI Commands

```bash
# Search memory from the command line
openclaw memory search "what did we decide about the database schema?"

# Ingest a document into a collection
openclaw memory ingest ~/documents/resume.pdf resume
openclaw memory ingest ~/documents/strategy.docx work

# Show memory statistics
openclaw memory stats
```

---

## Agent Tools

The LLM can call these tools directly when needed:

- **`memory_search`** — search memory and collections with a natural language query
- **`memory_ingest`** — ingest a file at a given path into a named collection

---

## Data Location

Everything lives in two paths:

```
~/.openclaw/workspace/memory.db       ← the entire brain
~/.openclaw/workspace/collections/    ← original source files
```

To move to a new machine, copy both. All relative paths inside the DB stay valid.

---

## Troubleshooting

**Vector search not working** — sqlite-vec extension not found. Check the `.so` is at one of the expected paths and restart the gateway.

**Embeddings slow on first run** — BGE-M3 is downloading (~1.2 GB). Subsequent calls are fast.

**Summary not appearing** — summaries only generate once 11+ messages exist in a channel, and only every 20 messages. Use `openclaw memory stats` to check message counts.

**Large paste not indexing** — messages over ~8000 tokens are auto-ingested as paste collections (`p:channelname`). Say "list my pastes" to see them.
