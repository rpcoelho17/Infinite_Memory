# OpenClaw Infinite Memory — Implementation Specification V4

> **For the implementing LLM:** This document is a complete, self-contained blueprint. Read it fully before writing a single line of code. Every architectural decision has been made deliberately. Your job is to implement exactly what is described here, adapting only where the user's existing OpenClaw codebase requires it (e.g. TypeScript vs JavaScript patterns, existing config conventions).

---

## 1. Overview

**Infinite Memory** is a persistent, unified memory and RAG (Retrieval-Augmented Generation) module for OpenClaw. It runs **inside** the OpenClaw project — not as a separate service — and is called via direct function imports from the OpenClaw gateway.

### Core Capabilities
- Stores every conversation message (Telegram and Open WebUI) permanently in SQLite
- Organizes documents into named RAG collections with semantic search
- Assembles intelligent context for the LLM on every message: MEMORY.md + rolling summary + semantic search + recent messages
- Manages multiple named channels — each with isolated memory and configurable collection scope
- Supports independent active channel per interface (Telegram and Open WebUI)
- All settings and channel management configurable via natural language — handled by LLM tools, not regex
- **Pre-execution confirmation for all state-changing commands** — the bot describes what it is about to do and waits for explicit user approval before executing
- **Deep Memory Search** — exhaustive cross-collection research triggered by natural language, with automatic two-pass synthesis fallback when results exceed context limits

### Design Principles
- **Two-process architecture** — Node/TypeScript for runtime (always running), Python for ingestion (spawned on demand). They share `memory.db` — no HTTP between them.
- **Portable brain** — copy `memory.db` + `collections/` folder to move everything to a new machine
- **Local first** — all data stays on your server. No third-party data transmission by default.
- **Zero extra cost** — runs entirely on free infrastructure
- **Compact storage** — abbreviated values in DB (U/A, D, p:) to minimize database growth
- **Best tool for each job** — Python for ingestion (LangChain SemanticChunker, superior NLP libraries), TypeScript for runtime (existing OpenClaw codebase)
- **Confirm before acting** — all state-changing operations require explicit user confirmation before execution, protecting against voice transcription errors and LLM misinterpretation

---

## 2. Infrastructure

| Component | Solution | Cost |
|---|---|---|
| Server | Oracle Cloud Always Free — 4 ARM vCPU, 24GB RAM, 240GB storage | Free forever |
| LLM (primary) | Qwen3 8B via Ollama | Free |
| LLM (summarization) | Same Qwen3 8B via Ollama — configured separately in `openclaw.json` | Free |
| Embeddings | BGE-M3 ONNX (local, 1024-dim) | Free |
| Vector Search | SQLite + sqlite-vec (vec0 HNSW index) | Free |
| Frontend | Open WebUI (optional) | Free |
| Bot | OpenClaw + Telegram | Free |
 
 ### Windows Host Considerations
 
 **For Windows users:**
 - **Python Version:** Use Python 3.13 for best CUDA compatibility. Python 3.14 (experimental) may lack stable CUDA wheels for PyTorch.
 - **CUDA Support:** Ensure you install the `+cuXXX` version of PyTorch (e.g., `pip install torch --index-url https://download.pytorch.org/whl/cu124`).
 - **Console Encoding:** Windows consoles use `cp1252` by default. Avoid using emojis in Python logs to prevent `UnicodeEncodeError`.

### Embedding Model

**Use BGE-M3 ONNX** (`BAAI/bge-m3` via `fastembed` or `FlagEmbedding`):
- 1024 dimensions
- ~1.2GB disk, ~2.5GB RAM
- 100% local, no API calls
- Supports 100+ languages
- **8192 token context window** — handles virtually all real-world messages in a single embedding
- Use ONNX O2 optimizations for ARM CPU

Set `EMBEDDING_DIM = 1024` throughout the implementation.

**Fallback (low-RAM environments):** `gemini-embedding-001` API at 768 dimensions. Check available RAM at startup — if < 8GB, warn user and suggest API fallback.

---

## 3. Directory Structure

```
~/.openclaw/workspace/              ← ALL DATA lives here
├── MEMORY.md                       ← OpenClaw native: curated facts about user
├── USER.md                         ← OpenClaw native: user preferences
├── SOUL.md                         ← OpenClaw native: agent personality
├── memory.db                       ← OUR: entire brain (chunks, embeddings, metadata)
├── collections/                    ← OUR: original RAG source files only
│   ├── work/
│   │   ├── report_q3.pdf
│   │   └── strategy_2026.docx
│   ├── resume/
│   │   └── resume.pdf
│   └── research/
│       └── transformers_paper.pdf
└── memory/                         ← OpenClaw native: daily markdown logs
    ├── 2026-03-01.md
    └── 2026-02-28.md

openclaw/
└── src/
    └── memory/                     ← ALL TypeScript CODE lives here
        ├── index.ts                ← public API — exports all functions
        ├── db.ts                   ← SQLite connection + schema init
        ├── embed.ts                ← embedding provider wrapper (Node runtime only)
        ├── store.ts                ← message/memory storage
        ├── search.ts               ← unified semantic search
        ├── deep-search.ts          ← deep_memory_search tool — cross-collection exhaustive search
        └── upload.ts               ← file upload handler (Telegram + Open WebUI)

scripts/
└── ingest.py                       ← Python ingestion script (spawned via child_process)
                                       Uses LangChain SemanticChunker + fastembed BGE-M3
                                       Writes directly to memory.db — no HTTP bridge
```

### Portability

To copy your brain to another machine:
```bash
cp ~/.openclaw/workspace/memory.db ~/backup/memory.db
cp -r ~/.openclaw/workspace/collections ~/backup/collections
```

All `file_path` values in the `documents` table are stored as **relative paths** from the workspace root (e.g. `collections/resume/`) so they remain valid after copying.

### Configuration

`db.ts` resolves the workspace path from environment:
```typescript
const WORKSPACE = process.env.OPENCLAW_WORKSPACE ?? path.join(os.homedir(), '.openclaw/workspace')
const DB_PATH = path.join(WORKSPACE, 'memory.db')
const COLLECTIONS_PATH = path.join(WORKSPACE, 'collections')
const MEMORY_MD_PATH = path.join(WORKSPACE, 'MEMORY.md')
```

### Concurrent Access — Busy Timeout

Both the Node runtime and Python ingestion script access `memory.db` simultaneously. WAL mode allows concurrent reads, but writes can still conflict briefly. **Both processes must set a busy timeout** to avoid `SQLITE_BUSY` errors:

```typescript
// Node (db.ts)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')   // wait up to 5 seconds if DB is locked
```

```python
# Python (ingest.py)
db = sqlite3.connect(DB_PATH)
db.execute("PRAGMA journal_mode=WAL")
db.execute("PRAGMA busy_timeout=5000")
```

---

## 4. Compact Value Conventions

To minimize database size over thousands of messages and rows, abbreviated values are used throughout. **These are never exposed to the LLM directly** — always translate to full values when assembling prompts.

| Concept | DB Value | Prompt Value |
|---|---|---|
| Default channel | `D` | `Default` |
| Speaker: user | `U` | `User` |
| Speaker: assistant | `A` | `Assistant` |
| RAG chunk channel | `__rag__` | n/a (never in prompt directly) |
| Default pastes collection | `p:D` | n/a |
| Named pastes collection | `p:work`, `p:research` etc. | n/a |
| Interface: Telegram | `tg` | n/a |
| Interface: Open WebUI | `owui` | n/a |

---

## 5. Database Schema

> **Implement this schema exactly.** Run on first startup if tables do not exist.

```sql
-- ============================================================
-- memory.db — Complete Schema
-- ============================================================

-- ── MEMORY TABLE ─────────────────────────────────────────────
-- Stores ALL chunks: conversation messages (type='M') and
-- RAG document chunks (type='R').
-- Single source of truth for all searchable content.
-- speaker: 'U' = user, 'A' = assistant, NULL for RAG chunks
CREATE TABLE IF NOT EXISTS memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL CHECK(type IN ('M', 'R')),
    channel     TEXT NOT NULL,          -- channel name. 'D' = default
    doc_id      INTEGER REFERENCES documents(doc_id) ON DELETE CASCADE,
                                        -- NULL for conversation messages (type='M')
    chunk_text  TEXT NOT NULL,
    speaker     TEXT CHECK(speaker IN ('U', 'A') OR speaker IS NULL),
    embedding_status TEXT DEFAULT 'ok' CHECK(embedding_status IN ('ok', 'failed')),
                                        -- tracks embedding generation success
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memory_channel ON memory(channel);
CREATE INDEX IF NOT EXISTS idx_memory_type_channel ON memory(type, channel);
CREATE INDEX IF NOT EXISTS idx_memory_doc_id ON memory(doc_id);
CREATE INDEX IF NOT EXISTS idx_memory_timestamp ON memory(timestamp);

-- ── MEMORY EMBEDDINGS ─────────────────────────────────────────
-- Vector embeddings for every row in the memory table.
-- Linked by rowid — rowid in memory_embeddings MUST match id in memory.
-- HNSW index is built into vec0 — no separate index needed.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
    embedding FLOAT[1024]               -- BGE-M3 dimensions; change to 768 for Gemini
);

-- ── DOCUMENTS TABLE ───────────────────────────────────────────
-- Registry of ingested RAG files. Metadata only — no file content.
-- Actual files live on disk in collections/ subfolders.
CREATE TABLE IF NOT EXISTS documents (
    doc_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,          -- filename e.g. "resume.pdf"
    collection  TEXT NOT NULL,          -- collection name e.g. "resume"
    file_path   TEXT NOT NULL,          -- relative path WITHOUT filename e.g. "collections/resume/"
    description TEXT,                   -- LLM-generated one-paragraph summary (nullable)
    ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    chunk_count INTEGER DEFAULT 0,      -- updated after ingestion completes
    UNIQUE(name, collection)            -- prevents duplicate ingestion of the same file
);

-- ── SUMMARIES TABLE ───────────────────────────────────────────
-- One rolling summary per channel. Updated every N messages.
-- Loaded into memory on startup as an in-memory cache.
CREATE TABLE IF NOT EXISTS summaries (
    channel     TEXT PRIMARY KEY,       -- 'D', 'work', etc.
    summary     TEXT NOT NULL,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── SETTINGS TABLE ────────────────────────────────────────────
-- All user-configurable parameters. Changed via natural language.
-- Global settings: plain key
-- Per-channel settings: "setting_name:channel"
-- Per-interface active channel: "active_channel:tg" / "active_channel:owui"
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
);

-- ── PENDING CONFIRMATIONS TABLE ───────────────────────────────
-- Stores pending tool actions awaiting user confirmation.
-- One row per interface — only one action can be pending at a time per interface.
-- Cleared immediately on confirm or cancel.
CREATE TABLE IF NOT EXISTS pending_confirmations (
    interface       TEXT PRIMARY KEY,   -- 'tg' or 'owui'
    tool_name       TEXT NOT NULL,      -- e.g. 'switch_channel'
    tool_params     TEXT NOT NULL,      -- JSON-encoded params
    prompt_shown    TEXT NOT NULL,      -- the confirmation message shown to user
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── FULL TEXT SEARCH (BM25) ──────────────────────────────────
-- FTS5 virtual table for BM25 keyword search.
-- content= avoids duplicating text — reads directly from memory table.
-- Triggers below keep it automatically in sync.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    chunk_text,
    content='memory',
    content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, chunk_text) VALUES (new.id, new.chunk_text);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, chunk_text) VALUES('delete', old.id, old.chunk_text);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, chunk_text) VALUES('delete', old.id, old.chunk_text);
    INSERT INTO memory_fts(rowid, chunk_text) VALUES (new.id, new.chunk_text);
END;

-- ── DEFAULT SETTINGS ─────────────────────────────────────────
-- Insert only if not already present
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('recent_messages_limit',               '10'),
    ('summary_update_frequency',            '10'),
    ('semantic_search_top_k',               '5'),
    ('summarization_model',                 'ollama/qwen3:8b'),
    ('vector_weight',                       '0.7'),
    ('bm25_weight',                         '0.3'),
    ('memory_decay_halflife_days',          '90'),  -- conversation memories decay to ~37% after 90 days
                                                    -- set to 0 to disable decay entirely
    ('deep_memory_search_token_threshold',  '4000'), -- total token threshold above which two-pass
                                                    -- synthesis is used instead of single-pass
    ('active_channel:tg',                  'D'),
    ('active_channel:owui',                'D');
```

### Insert Pattern for Embeddings

**CRITICAL:** Always insert into `memory` first, then use the returned `lastInsertRowid` as the explicit rowid for `memory_embeddings`. They must match exactly.

```typescript
const result = db.prepare(
  `INSERT INTO memory (type, channel, doc_id, chunk_text, speaker) VALUES (?, ?, ?, ?, ?)`
).run(type, channel, docId ?? null, chunkText, speaker ?? null)

const memoryId = result.lastInsertRowid

db.prepare(
  `INSERT INTO memory_embeddings (rowid, embedding) VALUES (?, ?)`
).run(memoryId, embeddingBuffer)
```

### Embedding Failure Recovery

When embedding generation fails (API down, OOM, rate-limited), the message is still stored but marked with `embedding_status = 'failed'`. These messages are findable via BM25 keyword search but invisible to vector search until their embeddings are backfilled.

**On insert failure:**

```typescript
try {
  const embedding = await embed(chunkText)
  const buffer = embeddingToBuffer(embedding)
  db.prepare(
    `INSERT INTO memory_embeddings (rowid, embedding) VALUES (?, ?)`
  ).run(memoryId, buffer)
} catch (err) {
  console.warn(`⚠️ Embedding failed for memory ${memoryId}:`, err)
  db.prepare(
    `UPDATE memory SET embedding_status = 'failed' WHERE id = ?`
  ).run(memoryId)
}
```

**Background retry — run periodically (e.g. every 5 minutes):**

```typescript
async function retryFailedEmbeddings(): Promise<void> {
  const failed = db.prepare(
    `SELECT id, chunk_text FROM memory WHERE embedding_status = 'failed' LIMIT 10`
  ).all() as { id: number; chunk_text: string }[]

  for (const row of failed) {
    try {
      const embedding = await embed(row.chunk_text)
      const buffer = embeddingToBuffer(embedding)
      db.prepare(
        `INSERT INTO memory_embeddings (rowid, embedding) VALUES (?, ?)`
      ).run(row.id, buffer)
      db.prepare(
        `UPDATE memory SET embedding_status = 'ok' WHERE id = ?`
      ).run(row.id)
      console.log(`✅ Backfilled embedding for memory ${row.id}`)
    } catch {
      // Still failing — leave it for next retry cycle
    }
  }
}
```

---

## 6. Channel System

Channels are the primary isolation boundary for conversation memory. Every message belongs to a channel. Every semantic memory search is scoped to the current channel.

### Channel Naming

| Situation | Channel Value |
|---|---|
| First conversation — any interface, no channel created | `D` |
| User-named channel — any interface | `work`, `resume`, `project_x` etc. |

`D` is the universal default regardless of interface. Both Telegram and Open WebUI start on `D` until the user explicitly creates a new channel.

### Per-Interface Active Channel

Each interface tracks its own active channel independently, enabling multitasking across interfaces simultaneously.

```sql
('active_channel:tg',   'work')      -- Telegram currently on 'work'
('active_channel:owui', 'research')  -- Open WebUI currently on 'research'
```

Neither interface affects the other when switching channels — unless the user explicitly syncs them.

### Sync Commands

```
"sync open web ui to my telegram channel"
  → proposes: setActiveChannel('owui', currentTgChannel)

"sync telegram to my open web ui channel"
  → proposes: setActiveChannel('tg', currentOwuiChannel)
```

Both require pre-execution confirmation before the channel switch takes effect.

---

## 7. Settings System

All parameters stored in `settings` table. The LLM can change any setting by calling the `propose_change_setting` tool — there is no regex interception, no hardcoded phrase list. The LLM handles natural language variation naturally.

All settings changes go through the confirmation flow (Section 8a) before being written to the database.

### Global Settings

| Key | Default | Example Natural Language |
|---|---|---|
| `recent_messages_limit` | `10` | `"increase my short term memory to 20 messages"` |
| `summary_update_frequency` | `5` | `"summarize every 10 messages"` |
| `semantic_search_top_k` | `5` | `"give me more context"` |
| `summarization_model` | `"ollama/qwen3:8b"` | `"use phi4 for summaries"` |
| `memory_decay_halflife_days` | `90` | `"make older memories fade faster"`, `"set half life to 8"`, `"never forget anything"` → 0 (disables decay) |
| `deep_memory_search_token_threshold` | `4000` | `"set deep memory search threshold to 6000"`, `"use single pass for deep searches"` → set high value |

### Per-Channel Settings

Stored with key format `setting_name:channel`. Managed via LLM tools — the LLM calls `propose_change_setting` or `list_collections` based on intent.

### Collection Filter Behavior

- **Memory chunks (type='M'):** Always filtered by current channel. Never cross-channel.
- **RAG chunks (type='R'):** Filtered by `active_collections` for current channel. If no setting exists, searches ALL collections.
- **Paste collections (p:channel):** Always included automatically for current channel. Excluded from `"list my collections"`, shown in `"list my pastes"`.

---

## 8. Message Flow

Complete sequence for every incoming message from Telegram or Open WebUI.

```
1. MESSAGE ARRIVES
   Identify interface: 'tg' or 'owui'
   Get active channel from settings: active_channel:tg or active_channel:owui

2. CHECK FOR PENDING CONFIRMATION
   Query pending_confirmations WHERE interface = currentInterface.
   If a pending confirmation exists:
     → Route message to confirmation handler (Section 8b).
     → STOP normal flow.

3. CHECK MESSAGE SIZE
   Count tokens in message.
   If tokens > 8000:
     → Auto-ingest to paste collection p:<channel> (see Section 11)
     → Store short reference in memory: '[Large paste — collection: p:<channel>]'
     → Respond: "That looked like a large paste. I've saved and indexed it in
                 your p:<channel> collection. What would you like to know about it?"
     → STOP. No LLM call.
   If tokens <= 8000: continue.

4. STORE IMMEDIATELY
   Insert full message into memory BEFORE any LLM call.
   type='M', channel=currentChannel, speaker='U'
   Generate one embedding → insert into memory_embeddings.

5. BUILD CONTEXT
   Assemble in this exact order:

   a) MEMORY.md
      Read from WORKSPACE/MEMORY.md. Always included.
      Rarely changes → prompt cache checkpoint here.

   b) Rolling summary
      Covers messages 11–30 (the middle band).
      Load from summaryCache for current channel.
      Omit if fewer than 11 messages exist. Changes every 20 messages.
      → prompt cache checkpoint here.

   c) Semantic search results
      Run search() with current message as query.
      Scoped to messages 11+ (intentionally overlaps summary band).
      Memory: scoped to current channel only.
      RAG: scoped to active_collections for current channel.
      Returns top_k=5 results with source labels, decay applied.
      Changes per query — not cached.

   d) Last 10 messages verbatim
      Load last 10 from memory for current channel, ordered ASC by timestamp.
      Translate: 'U' → 'User:', 'A' → 'Assistant:'
      Changes every message — not cached.

6. ASSEMBLE PROMPT — THREE-BAND MODEL

   Band        | Coverage        | Mechanism
   ------------|-----------------|------------------------------------------
   Verbatim    | Last 10 msgs    | Always included, no compression
   Summary     | Messages 11–30  | Rolling LLM summary, refreshed every 20
   Deep history| Messages 11+    | Semantic search with decay (overlaps summary)

   [MEMORY.md]
   [Semantic search results — messages 11+, relevance + decay scored]
   [Rolling summary — messages 11–30, if exists]
   [Last 10 messages verbatim]
   [User's new message]

7. SEND TO LLM
   Send to primary LLM with tools registered (see Section 8a).
   Apply prompt caching (see Section 13).

8. HANDLE TOOL CALLS
   If LLM response contains a tool call, determine its type:

   → PROPOSE TOOL (name begins with 'propose_'):
       Write the proposed action to pending_confirmations table.
       Respond to user with the confirmation prompt from the tool result.
       STOP. Do not store this as a regular assistant message.

   → READ / EXECUTE TOOL (list_channels, get_current_channel,
     list_collections, deep_memory_search):
       Execute the tool immediately.
       Feed the tool result back to the LLM as a tool response.
       LLM produces a final synthesis response — continue to step 9.
       Note: deep_memory_search may make multiple internal search calls
       and an optional summarization pass before returning its result.

   If no tool call: continue.

9. STORE RESPONSE — WITH SANITIZATION
   Sanitize the LLM response before storing it.
   Strip all injected context markers so they don't get stored as if
   the LLM said them, creating a pollution loop in future searches.
   Then insert into memory.
   type='M', channel=currentChannel, speaker='A'
   Generate one embedding → insert into memory_embeddings.

10. CHECK SUMMARY TRIGGER
    If new message count >= summary_update_frequency:
      → Fire background summarization (non-blocking, fire and forget)

11. DELIVER RESPONSE
    Return to Telegram or Open WebUI.
```

---

## 8a. LLM Tools

All channel management and settings changes are exposed as **propose** tools. The naming convention is intentional: every tool *proposes* an action and returns a human-readable confirmation prompt. **No tool executes state changes directly.** Execution happens only after the user confirms (Section 8b).

This two-phase design is the core reliability mechanism. It protects against:
- Voice transcription errors ("walk channel" instead of "work channel")
- LLM misinterpretation of ambiguous phrasing
- Accidental commands embedded in longer messages

The only pre-LLM intercept that remains is large paste detection (Section 11), which must abort before the LLM sees thousands of tokens of raw text.

### Why Propose Tools Instead of Execute Tools

| Direct execution (V2) | Propose + confirm (V3) |
|---|---|
| Handles any phrasing | Handles any phrasing |
| Silent failure if LLM misunderstands | User catches mismatch before state changes |
| No recovery from wrong channel switch | User can cancel before damage occurs |
| No protection against voice errors | Voice errors surfaced and correctable |

### Tool Definitions

> **Single-propose rule:** The LLM must call **at most one** `propose_` tool per response. If the user's message implies multiple state changes (e.g. "switch to work and increase my memory to 20"), the LLM should execute the first propose tool and instruct the user to issue the second command in a separate message after confirming the first. This prevents silent loss of confirmations (the `pending_confirmations` table holds only one action per interface).

```typescript
// ── CHANNEL MANAGEMENT ────────────────────────────────────────

api.registerTool('propose_switch_channel', {
  description: 'Propose switching to a different conversation channel, or creating a new one. Always call this tool when the user wants to change channels — never execute the switch directly.',
  parameters: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: 'The channel name to switch to. If it does not exist, it will be created.'
      },
      interface: { type: 'string', enum: ['tg', 'owui'] }
    },
    required: ['channel', 'interface']
  },
  run: (params) => {
    const action = { tool: 'execute_switch_channel', params }
    const prompt = `You want me to switch to the "${params.channel}" channel — is that correct? (yes / no)`
    savePendingConfirmation(params.interface, action, prompt)
    return prompt
  }
})

api.registerTool('propose_rename_channel', {
  description: 'Propose renaming the current channel. Always call this tool — never rename directly.',
  parameters: {
    type: 'object',
    properties: {
      new_name: { type: 'string' },
      current_channel: { type: 'string' },
      interface: { type: 'string', enum: ['tg', 'owui'] }
    },
    required: ['new_name', 'current_channel', 'interface']
  },
  run: (params) => {
    const action = { tool: 'execute_rename_channel', params }
    const prompt = `You want me to rename the "${params.current_channel}" channel to "${params.new_name}" — is that correct? (yes / no)`
    savePendingConfirmation(params.interface, action, prompt)
    return prompt
  }
})

api.registerTool('propose_sync_channels', {
  description: 'Propose syncing the active channel from one interface to the other.',
  parameters: {
    type: 'object',
    properties: {
      from_interface: { type: 'string', enum: ['tg', 'owui'] },
      to_interface: { type: 'string', enum: ['tg', 'owui'] }
    },
    required: ['from_interface', 'to_interface']
  },
  run: (params) => {
    const fromChannel = getActiveChannel(params.from_interface)
    const action = { tool: 'execute_sync_channels', params }
    const prompt = `You want me to sync ${params.to_interface} to the "${fromChannel}" channel (currently active on ${params.from_interface}) — is that correct? (yes / no)`
    savePendingConfirmation(params.from_interface, action, prompt)
    return prompt
  }
})

api.registerTool('propose_delete_channel', {
  description: 'Propose deleting a conversation channel. All conversation messages in the channel will be permanently deleted. Any document collections associated with the channel will be reassigned to the Default channel — collections are never deleted by this tool. The Default channel cannot be deleted. Always call this tool — never delete directly.',
  parameters: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: 'The channel name to delete. Cannot be "D" (Default).'
      },
      interface: { type: 'string', enum: ['tg', 'owui'] }
    },
    required: ['channel', 'interface']
  },
  run: (params) => {
    if (params.channel === 'D') {
      return 'The Default channel cannot be deleted.'
    }
    const msgCount = db().prepare(
      `SELECT COUNT(*) as c FROM memory WHERE type='M' AND channel=?`
    ).get(params.channel) as { c: number }
    const collCount = db().prepare(
      `SELECT COUNT(DISTINCT collection) as c FROM documents d
       JOIN memory m ON m.doc_id = d.doc_id
       WHERE m.channel = ? AND m.type = 'R'`
    ).get(params.channel) as { c: number }
    const action = { tool: 'execute_delete_channel', params }
    const collNote = collCount.c > 0
      ? ` ${collCount.c} collection(s) will be reassigned to the Default channel.`
      : ''
    const prompt = `You want me to delete the "${params.channel}" channel (${msgCount.c} messages will be permanently removed).${collNote} Is that correct? (yes / no)`
    savePendingConfirmation(params.interface, action, prompt)
    return prompt
  }
})

api.registerTool('propose_delete_collection', {
  description: 'Propose deleting a document collection and all its ingested chunks. This is a separate action from channel deletion — channels and collections are independent. Always call this tool — never delete directly.',
  parameters: {
    type: 'object',
    properties: {
      collection: {
        type: 'string',
        description: 'The collection name to delete.'
      },
      interface: { type: 'string', enum: ['tg', 'owui'] }
    },
    required: ['collection', 'interface']
  },
  run: (params) => {
    const docs = db().prepare(
      `SELECT COUNT(*) as c FROM documents WHERE collection=?`
    ).get(params.collection) as { c: number }
    if (docs.c === 0) {
      return `No collection named "${params.collection}" found.`
    }
    const action = { tool: 'execute_delete_collection', params }
    const prompt = `You want me to delete the "${params.collection}" collection (${docs.c} document(s) and all indexed chunks will be permanently removed). Is that correct? (yes / no)`
    savePendingConfirmation(params.interface, action, prompt)
    return prompt
  }
})

// ── READ-ONLY TOOLS (no confirmation needed) ──────────────────

api.registerTool('list_channels', {
  description: 'List all conversation channels or paste collections. Safe read — no confirmation needed.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['channels', 'pastes'], default: 'channels' }
    }
  },
  run: (params) => {
    const filter = params.type === 'pastes' ? "LIKE 'p:%'" : "NOT LIKE 'p:%'"
    const rows = db().prepare(
      `SELECT DISTINCT channel FROM memory WHERE type='M' AND channel ${filter}`
    ).all() as { channel: string }[]
    return rows.map(r => r.channel).join(', ') || '(none)'
  }
})

api.registerTool('get_current_channel', {
  description: 'Return the currently active channel for this interface.',
  parameters: {
    type: 'object',
    properties: { interface: { type: 'string', enum: ['tg', 'owui'] } },
    required: ['interface']
  },
  run: (params) => getActiveChannel(params.interface)
})

api.registerTool('list_collections', {
  description: 'List all document collections with document counts. Safe read — no confirmation needed.',
  parameters: { type: 'object', properties: {} },
  run: () => {
    const rows = db().prepare(
      `SELECT collection, COUNT(*) as n FROM documents GROUP BY collection`
    ).all() as { collection: string; n: number }[]
    return rows.map(r => `${r.collection} (${r.n} docs)`).join(', ') || '(none)'
  }
})

api.registerTool('deep_memory_search', {
  description: `Perform exhaustive research across ALL document collections ingested in the current
channel. Use when the user asks for comprehensive, cross-document analysis of a topic.
Primary trigger phrase: "do a deep memory search about/for/on X".
Also triggers on: "search all my documents for", "compare all my sources on",
"what do all my books say about", "find everywhere X is mentioned".
Do NOT use for regular conversational questions — use only when the user explicitly
wants exhaustive cross-collection coverage.
Do NOT use for internet or web searches — this searches only ingested local documents.
Returns per-collection findings which you must synthesize into a coherent answer.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The research question or concept to investigate across all collections.'
      },
      top_k_per_collection: {
        type: 'number',
        description: 'Number of results to retrieve per collection. Default 5. Increase for broader coverage on dense topics.',
        default: 5
      }
    },
    required: ['query']
  },
  run: async (params) => {
    return deepMemorySearch(params.query, params.top_k_per_collection ?? 5)
  }
})

// ── SETTINGS MANAGEMENT ───────────────────────────────────────

api.registerTool('propose_change_setting', {
  description: `Propose changing a memory plugin setting. Always propose — never change directly.
Available keys:
- recent_messages_limit: verbatim recent messages to include (default 10)
- summary_update_frequency: regenerate summary every N messages (default 5)
- semantic_search_top_k: number of semantic search results (default 5)
- summarization_model: Ollama model for summaries, e.g. ollama/phi4
- memory_decay_halflife_days: older memory fade rate in days; 0 disables (default 90)
- active_collections:<channel>: comma-separated collections to search; delete key to search all`,
  parameters: {
    type: 'object',
    properties: {
      key: { type: 'string' },
      value: { type: 'string' },
      interface: { type: 'string', enum: ['tg', 'owui'] },
      human_description: {
        type: 'string',
        description: 'A plain-language description of what this change does, for the confirmation prompt.'
      }
    },
    required: ['key', 'value', 'interface', 'human_description']
  },
  run: (params) => {
    const action = { tool: 'execute_change_setting', params }
    const prompt = `You want me to ${params.human_description} — is that correct? (yes / no)`
    savePendingConfirmation(params.interface, action, prompt)
    return prompt
  }
})
```

### Pending Confirmation Helpers

```typescript
function savePendingConfirmation(
  iface: string,
  action: { tool: string; params: Record<string, unknown> },
  prompt: string
): void {
  db().prepare(`
    INSERT OR REPLACE INTO pending_confirmations (interface, tool_name, tool_params, prompt_shown)
    VALUES (?, ?, ?, ?)
  `).run(iface, action.tool, JSON.stringify(action.params), prompt)
}

function clearPendingConfirmation(iface: string): void {
  db().prepare(`DELETE FROM pending_confirmations WHERE interface = ?`).run(iface)
}

function getPendingConfirmation(iface: string): PendingConfirmation | null {
  return db().prepare(
    `SELECT * FROM pending_confirmations WHERE interface = ?`
  ).get(iface) as PendingConfirmation | null
}
```

---

## 8b. Confirmation Handler

When a message arrives and a pending confirmation exists for that interface, route it here instead of the normal message flow.

```typescript
async function handleConfirmation(
  iface: 'tg' | 'owui',
  userText: string
): Promise<string> {
  const pending = getPendingConfirmation(iface)
  if (!pending) return null

  const text = userText.trim().toLowerCase()

  // Detect affirmative responses
  const isYes = /^(yes|y|yeah|yep|correct|confirm|ok|okay|sure|do it|go ahead|affirmative)$/i.test(text)

  // Detect negative responses
  const isNo = /^(no|n|nope|cancel|stop|abort|negative|don't|dont|never mind|nevermind)$/i.test(text)

  if (!isYes && !isNo) {
    // Ambiguous response — re-show the confirmation prompt
    return `I didn't catch that. ${pending.prompt_shown}`
  }

  clearPendingConfirmation(iface)

  if (isNo) {
    return `Got it — cancelled. ${pending.prompt_shown.split('—')[0].trim()} was not changed.`
  }

  // Execute the confirmed action
  return executeConfirmedAction(pending.tool_name, JSON.parse(pending.tool_params), iface)
}

async function executeConfirmedAction(
  toolName: string,
  params: Record<string, unknown>,
  iface: string
): Promise<string> {
  switch (toolName) {
    case 'execute_switch_channel': {
      setActiveChannel(params.interface as string, params.channel as string)
      return `Done — switched to the "${params.channel}" channel.`
    }
    case 'execute_rename_channel': {
      db().prepare('UPDATE memory SET channel=? WHERE channel=?')
        .run(params.new_name, params.current_channel)
      db().prepare('UPDATE summaries SET channel=? WHERE channel=?')
        .run(params.new_name, params.current_channel)
      setActiveChannel(params.interface as string, params.new_name as string)
      return `Done — channel renamed to "${params.new_name}".`
    }
    case 'execute_sync_channels': {
      const fromChannel = getActiveChannel(params.from_interface as string)
      setActiveChannel(params.to_interface as string, fromChannel)
      return `Done — ${params.to_interface} is now on the "${fromChannel}" channel.`
    }
    case 'execute_change_setting': {
      setSetting(params.key as string, params.value as string)
      return `Done — ${params.human_description}.`
    }
    case 'execute_delete_channel': {
      const ch = params.channel as string
      // Delete conversation messages only
      db().prepare('DELETE FROM memory WHERE type=\'M\' AND channel=?').run(ch)
      // Reassign any RAG chunks in this channel to Default
      db().prepare('UPDATE memory SET channel=\'D\' WHERE type=\'R\' AND channel=?').run(ch)
      // Clean up summary
      db().prepare('DELETE FROM summaries WHERE channel=?').run(ch)
      // Clean up per-channel settings
      db().prepare('DELETE FROM settings WHERE key LIKE ?').run(`%:${ch}`)
      // Switch user to default channel
      setActiveChannel(params.interface as string, 'D')
      return `Done — deleted the "${ch}" channel. Collections have been reassigned to the Default channel. You are now on the Default channel.`
    }
    case 'execute_delete_collection': {
      const col = params.collection as string
      // CASCADE delete: removing documents will cascade-delete memory rows (type='R')
      // which also removes their embeddings
      db().prepare('DELETE FROM documents WHERE collection=?').run(col)
      return `Done — deleted the "${col}" collection and all its indexed chunks.`
    }
    default:
      return `Unknown action: ${toolName}`
  }
}
```

### Confirmation UX Examples

```
User: "switch to the work channel"
Bot:  "You want me to switch to the 'work' channel — is that correct? (yes / no)"

User: "yes"
Bot:  "Done — switched to the 'work' channel."

---

User (via voice, transcribed as): "switch to the walk channel"
Bot:  "You want me to switch to the 'walk' channel — is that correct? (yes / no)"

User: "no"
Bot:  "Got it — cancelled. You want me to switch to the 'walk' channel was not changed."

User: "switch to the work channel"
Bot:  "You want me to switch to the 'work' channel — is that correct? (yes / no)"

User: "yes"
Bot:  "Done — switched to the 'work' channel."

---

User: "increase my short term memory to 20 messages"
Bot:  "You want me to set the recent messages limit to 20 — is that correct? (yes / no)"

User: "yes"
Bot:  "Done — set the recent messages limit to 20."

---

User (ambiguous): "maybe"
Bot:  "I didn't catch that. You want me to set the recent messages limit to 20 — is that correct? (yes / no)"

---

User: "delete the old_project channel"
Bot:  "You want me to delete the "old_project" channel (142 messages will be permanently removed). 2 collection(s) will be reassigned to the Default channel. Is that correct? (yes / no)"

User: "yes"
Bot:  "Done — deleted the "old_project" channel. Collections have been reassigned to the Default channel. You are now on the Default channel."

---

User: "delete the drafts collection"
Bot:  "You want me to delete the "drafts" collection (3 document(s) and all indexed chunks will be permanently removed). Is that correct? (yes / no)"

User: "yes"
Bot:  "Done — deleted the "drafts" collection and all its indexed chunks."

---

User: "switch to work and increase my memory to 20"
Bot:  "You want me to switch to the "work" channel — is that correct? (yes / no)
      (I'll handle the memory setting change after this — please send it as a separate message.)"
```

### Confirmation Expiry

Pending confirmations are stored in the database and survive restarts. However, a confirmation older than **5 minutes** should be treated as expired and automatically cancelled:

```typescript
function getPendingConfirmation(iface: string): PendingConfirmation | null {
  const row = db().prepare(
    `SELECT * FROM pending_confirmations WHERE interface = ?`
  ).get(iface) as PendingConfirmation | null

  if (!row) return null

  const ageMs = Date.now() - new Date(row.created_at).getTime()
  if (ageMs > 5 * 60 * 1000) {
    clearPendingConfirmation(iface)
    return null
  }

  return row
}
```

---

## 8c. Deep Memory Search

`deep_memory_search` is a read-only tool that performs exhaustive cross-collection research within the current channel. It is registered in Section 8a and its implementation lives in `deep-search.ts`.

### Core Logic

Unlike regular semantic search (which runs one query across all collections and returns a flat top-k), deep memory search queries **each collection independently**, guaranteeing that every ingested collection contributes findings. This ensures no source is silently omitted because it was outranked by a more prolific collection.

### Token Counting Utility

A lightweight token estimator tuned for **English and Portuguese** — the two primary languages of this system. Portuguese words average slightly more tokens than English due to longer inflected forms and diacritics.

```typescript
// Tuned for English (~1.3 tokens/word) and Portuguese (~1.5 tokens/word).
// Detects Portuguese via common character patterns and adjusts accordingly.
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length
  // Portuguese detection: check for common accented characters and patterns
  const ptPattern = /[àáâãçéêíóôõúü]|ção|ções|mente\b|ando\b|endo\b|indo\b/i
  const multiplier = ptPattern.test(text) ? 1.5 : 1.3
  return Math.ceil(words * multiplier)
}
```

### Two-Pass Fallback Logic

```
1. Query each collection independently (top_k_per_collection results each)
2. Count total estimated tokens across all results
3. If total <= deep_memory_search_token_threshold (default 4000):
     → SINGLE PASS: return all results as-is for LLM synthesis
4. If total > threshold:
     → TWO-PASS synthesis:
       Pass 1: Summarize each collection's results independently
               using summarization_model (small focused calls, one per collection)
       Pass 2: Combine per-collection summaries into a structured report
               (much smaller than raw chunks — safe to return as single tool result)
```

**Why the threshold matters:** Qwen3 8B has an ~8,192 token context window shared between system prompt, conversation history, tool results, and response generation. With a full context assembly already consuming 2,000-3,000 tokens, raw tool results must stay under ~4,000 tokens to leave room for synthesis. The threshold is configurable precisely because this balance shifts if you upgrade to a larger model.

**Why chunk sizes are typically well under the ceiling:** SemanticChunker splits at natural topic boundaries. Real lean six sigma book chunks will typically be 300-800 tokens each, not 8,000. The 8,192 token limit is BGE-M3's embedding ceiling — actual chunks are far smaller in practice.

### Implementation — `deep-search.ts`

```typescript
import { db, getSetting } from './db'
import { search, formatContext } from './search'

// ── SUMMARIZATION HELPER ──────────────────────────────────────
// Wraps the gateway's LLM caller with the correct signature.
// The gateway must inject this dependency when initializing.

let _callSummarizationLLM: (prompt: string) => Promise<string>

export function initDeepSearch(
  summarizer: (prompt: string) => Promise<string>
): void {
  _callSummarizationLLM = summarizer
}

// ── TOKEN ESTIMATOR ───────────────────────────────────────────
// Tuned for English (~1.3 tokens/word) and Portuguese (~1.5 tokens/word).

function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length
  const ptPattern = /[àáâãçéêíóôõúü]|ção|ções|mente\b|ando\b|endo\b|indo\b/i
  const multiplier = ptPattern.test(text) ? 1.5 : 1.3
  return Math.ceil(words * multiplier)
}

// ── MAIN ENTRY POINT ──────────────────────────────────────────

export async function deepMemorySearch(
  query: string,
  topKPerCollection = 5,
  channel: string
): Promise<string> {

  // Get all non-paste collections that have chunks in this channel's documents
  const collections = db().prepare(`
    SELECT DISTINCT d.collection, COUNT(m.id) as chunk_count
    FROM documents d
    JOIN memory m ON m.doc_id = d.doc_id
    WHERE d.collection NOT LIKE 'p:%'
    GROUP BY d.collection
    ORDER BY d.collection ASC
  `).all() as { collection: string; chunk_count: number }[]

  if (collections.length === 0) {
    return 'No document collections found. Ingest some documents first.'
  }

  // ── PASS 1: Query each collection independently ───────────────

  const collectionResults: Array<{
    collection: string
    chunk_count: number
    formatted: string
    tokenCount: number
  }> = []

  for (const col of collections) {
    const results = await search(query, {
      channel,
      collections: [col.collection],
      topK: topKPerCollection
    })

    if (results.length === 0) {
      collectionResults.push({
        collection: col.collection,
        chunk_count: col.chunk_count,
        formatted: '(no relevant content found)',
        tokenCount: 5
      })
      continue
    }

    const formatted = formatContext(results)
    collectionResults.push({
      collection: col.collection,
      chunk_count: col.chunk_count,
      formatted,
      tokenCount: estimateTokens(formatted)
    })
  }

  const totalTokens = collectionResults.reduce((sum, r) => sum + r.tokenCount, 0)
  const threshold = parseInt(getSetting('deep_memory_search_token_threshold') ?? '4000')

  // ── SINGLE PASS (under threshold) ────────────────────────────

  if (totalTokens <= threshold) {
    const parts = [
      `Deep memory search across ${collections.length} collection(s) for: "${query}"\n`,
      `Estimated tokens: ${totalTokens} (under ${threshold} threshold — single pass)\n`
    ]
    for (const r of collectionResults) {
      parts.push(`═══ Collection: ${r.collection} (${r.chunk_count} total chunks) ═══`)
      parts.push(r.formatted)
    }
    return parts.join('\n\n')
  }

  // ── TWO-PASS SYNTHESIS (over threshold) ──────────────────────

  const summarizationModel = getSetting('summarization_model') ?? 'ollama/qwen3:8b'

  const perCollectionSummaries: string[] = []

  for (const r of collectionResults) {
    if (r.formatted === '(no relevant content found)') {
      perCollectionSummaries.push(
        `[${r.collection}]: No relevant content found for this query.`
      )
      continue
    }

    const summaryPrompt = `You are summarizing search results from the "${r.collection}" document collection.
The user's research question is: "${query}"

Below are the most relevant passages retrieved from this collection.
Summarize what THIS collection specifically says about the topic.
Be concise but complete. Preserve specific facts, definitions, numbers, and named concepts.
Do not add information from outside these passages.

Passages:
${r.formatted}

Summary of what [${r.collection}] says about "${query}":`

    const summary = await _callSummarizationLLM(summaryPrompt)
    perCollectionSummaries.push(`[${r.collection}]: ${summary.trim()}`)
  }

  // Return structured per-collection summaries for the LLM to synthesize
  const output = [
    `Deep memory search across ${collections.length} collection(s) for: "${query}"`,
    `Estimated tokens: ${totalTokens} (over ${threshold} threshold — two-pass synthesis used)`,
    `Per-collection findings:\n`,
    ...perCollectionSummaries
  ]

  return output.join('\n\n')
}
```

### UX Examples

```
User: "do a deep memory search about DOE"
Bot calls: deep_memory_search({ query: "Design of Experiments DOE", top_k_per_collection: 5 })
Tool queries: [lean_six_sigma_intro], [lean_six_sigma_advanced], [minitab_guide], [bok_reference]
Total tokens: 2,800 → under threshold → single pass
Bot synthesizes and responds: "Across your four collections, here is what your materials say
about DOE..."

---

User: "do a deep memory search on waste reduction techniques across all my lean books"
Bot calls: deep_memory_search({ query: "waste reduction techniques muda elimination", top_k_per_collection: 5 })
Tool queries: 6 collections × 5 results = up to 30 chunks
Total tokens: 7,200 → over threshold → two-pass
Pass 1: Summarize each collection independently (6 small LLM calls)
Pass 2: Bot receives 6 compact summaries → synthesizes final answer
Bot responds: "Here is a cross-collection synthesis of waste reduction techniques..."

---

User: "search the web for lean six sigma"
Bot does NOT call deep_memory_search — uses web search tool instead
(The tool description explicitly excludes internet/web searches)
```

### Gateway Integration Note

`deepMemorySearch` requires the current channel to be passed in. The gateway must supply it when registering the tool:

```typescript
// In gateway tool registration — bind current channel at registration time
// OR pass it through the tool context object if OpenClaw supports tool context injection

api.registerTool('deep_memory_search', {
  // ... description and parameters as in Section 8a ...
  run: async (params) => {
    const channel = getSetting(`active_channel:${currentInterface}`) ?? 'D'
    return deepMemorySearch(params.query, params.top_k_per_collection ?? 5, channel)
  }
})
```

---

## 9. Rolling Summary

### Storage & Caching

Stored in `summaries` table. Loaded into an in-memory Map on startup:

```typescript
const summaryCache = new Map<string, string>()
db.prepare(`SELECT channel, summary FROM summaries`).all().forEach((row: any) => {
  summaryCache.set(row.channel, row.summary)
})
```

Use `summaryCache` for reads during session. Write-through to DB on every update.

### Update — Cumulative Rolling Summary

The summary covers **all messages beyond the verbatim window** — not just a fixed range. Each update incorporates the previous summary plus new unsummarized messages, so information is never lost as conversations grow.

Triggered in background every `summary_update_frequency` messages (default 10). Never blocks response delivery. If it fails, log and continue.

```typescript
async function updateSummary(
  channel: string,
  callSummarizationLLM: (prompt: string) => Promise<string>
): Promise<void> {
  const recentLimit = parseInt(getSetting('recent_messages_limit') ?? '10')
  const totalMessages = getMessageCount(channel)

  // Only summarize if we have messages beyond the verbatim window
  if (totalMessages <= recentLimit) return

  // Get messages just beyond the verbatim window up to 20 messages deep
  // (these are the newest unsummarized messages)
  const unsummarized = getMessageRange(channel, recentLimit + 1, recentLimit + 20)
  if (unsummarized.length === 0) return

  const previousSummary = summaryCache.get(channel)

  const prompt = previousSummary
    ? `You are updating an ongoing conversation summary.
Below is the EXISTING summary of all previous conversation history, followed by
NEW messages that have not yet been incorporated.
Merge the new information into the existing summary. Produce a single cohesive
paragraph. Preserve all important facts, decisions, and user preferences from
the existing summary. Add new information from the recent messages.
Do not repeat anything likely still in the last ${recentLimit} verbatim messages.
Be concise but complete.

EXISTING SUMMARY:
${previousSummary}

NEW MESSAGES:
${unsummarized.map(m => `${m.speaker === 'U' ? 'User' : 'Assistant'}: ${m.chunk_text}`).join('\n')}

Updated summary:`
    : `You are summarizing conversation history beyond the most recent messages.
This summary will be injected into context alongside the last ${recentLimit} verbatim messages,
so do not repeat anything likely still in the recent window.
Focus on: decisions made, facts established, topics covered, user preferences expressed.
Write as a single cohesive paragraph. Be concise but complete.

Messages to summarize:
${unsummarized.map(m => `${m.speaker === 'U' ? 'User' : 'Assistant'}: ${m.chunk_text}`).join('\n')}

Summary:`

  const newSummary = await callSummarizationLLM(prompt)
  summaryCache.set(channel, newSummary)
  db.prepare(
    `INSERT OR REPLACE INTO summaries (channel, summary, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`
  ).run(channel, newSummary)
}
```

---

## 10. Semantic Search

### Chat Messages — No Chunking

Conversation messages are stored whole — no chunking. BGE-M3's 8192 token context window handles all real-world chat messages in a single embedding. One message = one `memory` row = one `memory_embeddings` row.

### Hybrid Search: Vector + BM25

Every search runs **two queries simultaneously** and merges results using Reciprocal Rank Fusion. Neither method alone is sufficient:

- **Vector search** finds semantically similar content but misses exact matches. "RLS error" might not match "row-level security permission denied" semantically.
- **BM25 keyword search** finds exact matches but misses meaning. "concurrent write problem" won't match "parallel connection failure."

Together they cover each other's blind spots. The merge weights are 70% vector + 30% BM25.

### Reciprocal Rank Fusion

```typescript
function temporalDecay(timestamp: string, halfLifeDays: number): number {
  // Returns a multiplier between 0 and 1.
  // A memory from today = ~1.0. From 90 days ago (default half-life) = ~0.37.
  // From 1 year ago = ~0.06. Approaches but never reaches zero.
  const ageMs = Date.now() - new Date(timestamp).getTime()
  const ageDays = ageMs / (1000 * 60 * 60 * 24)
  return Math.exp(-ageDays / halfLifeDays)
}

function reciprocalRankFusion(
  vectorResults: SearchResult[],
  bm25Results: SearchResult[],
  vectorWeight = 0.7,
  bm25Weight = 0.3,
  k = 60,           // RRF constant — dampens the impact of rank position
  halfLifeDays = 90 // temporal decay half-life — configurable via settings
): SearchResult[] {
  const scores = new Map<number, number>()

  vectorResults.forEach((r, rank) => {
    const decay = r.type === 'M' ? temporalDecay(r.timestamp, halfLifeDays) : 1.0
    // RAG document chunks do NOT decay — a document is as valid today as when ingested.
    // Only conversation memory chunks (type='M') decay over time.
    scores.set(r.id, (scores.get(r.id) ?? 0) + vectorWeight * (1 / (k + rank + 1)) * decay)
  })

  bm25Results.forEach((r, rank) => {
    const decay = r.type === 'M' ? temporalDecay(r.timestamp, halfLifeDays) : 1.0
    scores.set(r.id, (scores.get(r.id) ?? 0) + bm25Weight * (1 / (k + rank + 1)) * decay)
  })

  const all = [...new Map([...vectorResults, ...bm25Results].map(r => [r.id, r])).values()]
  return all.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
}
```

### Function Signature

```typescript
interface SearchResult {
  id: number
  type: 'M' | 'R'
  channel: string
  chunk_text: string
  prev_paragraph: string | null   // last paragraph of previous chunk (RAG only)
  next_paragraph: string | null   // first paragraph of next chunk (RAG only)
  speaker: 'U' | 'A' | null
  timestamp: string
  distance: number
  doc_name: string | null
  file_path: string | null
  collection: string | null
  doc_id: number | null
}

async function search(
  query: string,
  options: {
    channel: string           // required — scopes memory chunks
    collections?: string[]    // optional — RAG filter. null/undefined = all collections
    topK?: number             // default: semantic_search_top_k setting
    minSimilarity?: number    // default: 0.3
  }
): Promise<SearchResult[]>
```

### SQL Pattern — Vector Query

```sql
SELECT
  m.id, m.type, m.channel, m.chunk_text, m.speaker, m.timestamp,
  e.distance,
  d.name AS doc_name, d.file_path, d.collection, d.doc_id
FROM memory_embeddings e
JOIN memory m ON m.id = e.rowid
LEFT JOIN documents d ON d.doc_id = m.doc_id
WHERE e.embedding MATCH :queryVector
  AND k = :topK
  AND (
    (m.type = 'M' AND m.channel = :channel)
    OR
    (m.type = 'R' AND (:collections IS NULL OR d.collection IN (:collections)))
  )
ORDER BY e.distance ASC;
```

### SQL Pattern — BM25 Query

```sql
SELECT
  m.id, m.type, m.channel, m.chunk_text, m.speaker, m.timestamp,
  bm25(memory_fts) AS bm25_score,
  d.name AS doc_name, d.file_path, d.collection, d.doc_id
FROM memory_fts
JOIN memory m ON m.id = memory_fts.rowid
LEFT JOIN documents d ON d.doc_id = m.doc_id
WHERE memory_fts MATCH :query
  AND (
    (m.type = 'M' AND m.channel = :channel)
    OR
    (m.type = 'R' AND (:collections IS NULL OR d.collection IN (:collections)))
  )
ORDER BY bm25_score ASC   -- bm25() returns negative values; more negative = better match
LIMIT :topK;
```

### Contextual Paragraph Retrieval (RAG chunks only)

After merging results, enrich RAG chunks (type='R') with one paragraph of surrounding context from neighboring chunks in the same document.

**Why one paragraph, not the full neighboring chunk:** SemanticChunker chunks can be large and variable in size. Returning full neighboring chunks on top of the match could easily inject 2000+ tokens per result × 5 results = 10,000+ tokens of RAG context. One paragraph is bounded (~100-150 tokens) regardless of chunk size.

```typescript
async function enrichWithContext(results: SearchResult[]): Promise<SearchResult[]> {
  return Promise.all(results.map(async (result) => {
    if (result.type !== 'R' || !result.doc_id) return result

    const prevChunk = db.prepare(`
      SELECT chunk_text FROM memory
      WHERE doc_id = ? AND id < ? AND type = 'R'
      ORDER BY id DESC LIMIT 1
    `).get(result.doc_id, result.id) as { chunk_text: string } | undefined

    const nextChunk = db.prepare(`
      SELECT chunk_text FROM memory
      WHERE doc_id = ? AND id > ? AND type = 'R'
      ORDER BY id ASC LIMIT 1
    `).get(result.doc_id, result.id) as { chunk_text: string } | undefined

    const prevParagraph = prevChunk
      ? prevChunk.chunk_text.split('\n\n').filter(Boolean).at(-1) ?? null
      : null

    const nextParagraph = nextChunk
      ? nextChunk.chunk_text.split('\n\n').filter(Boolean).at(0) ?? null
      : null

    return { ...result, prev_paragraph: prevParagraph, next_paragraph: nextParagraph }
  }))
}
```

### Context Formatting for Prompt

```typescript
function formatContext(results: SearchResult[]): string {
  const messages = results.filter(r => r.type === 'M')
  const docs = results.filter(r => r.type === 'R')
  const parts: string[] = []

  if (messages.length > 0) {
    parts.push('--- Relevant conversation history ---')
    messages.forEach(m => {
      const speaker = m.speaker === 'U' ? 'User' : 'Assistant'
      parts.push(`${speaker}: ${m.chunk_text}`)
    })
  }

  if (docs.length > 0) {
    parts.push('--- Relevant documents ---')
    docs.forEach(d => {
      parts.push(`[${d.doc_name} — collection: ${d.collection}]`)
      if (d.prev_paragraph) parts.push(`...${d.prev_paragraph}...\n─────`)
      parts.push(d.chunk_text)
      if (d.next_paragraph) parts.push(`─────\n...${d.next_paragraph}...`)
    })
  }

  return parts.join('\n\n')
}
```

---

## 11. Large Message Handling

When a message exceeds **8000 tokens**, route it through the ingestion pipeline automatically.

### Flow

```
1. Detect: token count > 8000
2. Save to: WORKSPACE/collections/p:<channel>/paste_<timestamp>.txt
3. Run full ingestion pipeline on that file
   collection = 'p:<channel>'
4. Store reference in memory:
   chunk_text = '[Large paste — collection: p:<channel> — paste_<timestamp>.txt]'
   type='M', channel=currentChannel, speaker='U'
5. Respond: "That looked like a large paste (~X tokens). I've saved and indexed
   it in your p:<channel> collection. What would you like to know about it?"
6. No LLM call — wait for user's follow-up question.
```

Note: Large paste handling is a pre-LLM intercept and bypasses the confirmation flow entirely — there is no destructive state change, only an additive ingestion.

### Paste Collection Naming

| Channel | Paste Collection |
|---|---|
| `D` | `p:D` |
| `work` | `p:work` |
| `research` | `p:research` |

Paste collections are automatically included in semantic search for the current channel. Excluded from `"list my collections"`, shown in `"list my pastes"`.

---

## 12. Document Ingestion

### How Node Calls Python

Ingestion is handled entirely by `scripts/ingest.py` — a standalone Python script. Node spawns it as a child process via `execFile`. They share `memory.db` on disk. No HTTP, no sockets.

```typescript
export function runIngestion(filePath: string, collection: string): Promise<string> {
  const pythonPath = process.platform === 'win32' ? 'C:\\Python313\\python.exe' : 'python3';
  return new Promise((resolve, reject) => {
    // On Windows, manually quote all paths to handle spaces correctly
    const cmd = process.platform === 'win32' 
        ? `"${pythonPath}" "${scriptPath}" "${filePath}"`
        : `${pythonPath} "${scriptPath}" "${filePath}"`;

    execSync(cmd, { 
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      maxBuffer: 50 * 1024 * 1024 
    });
    // ...
  })
}
```

Python holds a brief SQLite write lock only while inserting each chunk. Node reads freely the rest of the time.

### Supported File Types

| Extension | Python Library |
|---|---|
| `.pdf` | `pypdf` |
| `.docx` | `python-docx` |
| `.txt`, `.md` | plain read |
| `.html` | `beautifulsoup4` |
| `.jpg`, `.png` | `pytesseract` + `Pillow` |

### Semantic Chunking — LangChain SemanticChunker

**Do not use fixed-size or sentence-boundary chunking.** Use LangChain's `SemanticChunker` from `langchain_experimental`, which splits documents at natural topic boundaries.

```python
from langchain_experimental.text_splitter import SemanticChunker
from langchain_community.embeddings.fastembed import FastEmbedEmbeddings

embeddings = FastEmbedEmbeddings(model_name="BAAI/bge-m3")

chunker = SemanticChunker(
    embeddings,
    breakpoint_threshold_type="percentile",
    breakpoint_threshold_amount=95
)

chunks = chunker.create_documents([document_text])
```

**Breakpoint threshold types:**
- `percentile` — splits at the top X% most dissimilar sentence transitions. Best default for mixed documents.
- `standard_deviation` — splits when similarity drops more than N standard deviations below mean. Good for long uniform documents.
- `interquartile` — uses IQR statistical method. More aggressive splitting.
- `gradient` — splits based on rate of change in similarity. Best for documents with abrupt topic shifts.

Default: `percentile` at `95`. Expose `breakpoint_threshold_type` and `breakpoint_threshold_amount` as configurable parameters in `openclaw.json`.

### `ingest.py` — Complete Pipeline

```python
#!/usr/bin/env python3
"""
OpenClaw document ingestion script.
Usage: python3 ingest.py <file_path> <collection>
Writes chunks + embeddings directly to memory.db.
"""

import sys
import os
import sqlite3
import struct
import numpy as np
from pathlib import Path
from langchain_experimental.text_splitter import SemanticChunker
from langchain_community.embeddings.fastembed import FastEmbedEmbeddings
import requests

WORKSPACE = os.environ.get('OPENCLAW_WORKSPACE',
                            os.path.expanduser('~/.openclaw/workspace'))
DB_PATH = os.path.join(WORKSPACE, 'memory.db')


def extract_text(file_path: str) -> str:
    ext = Path(file_path).suffix.lower()
    if ext == '.pdf':
        from pypdf import PdfReader
        reader = PdfReader(file_path)
        return '\n'.join(page.extract_text() or '' for page in reader.pages)
    elif ext == '.docx':
        from docx import Document
        doc = Document(file_path)
        return '\n'.join(p.text for p in doc.paragraphs)
    elif ext in ('.txt', '.md'):
        return Path(file_path).read_text(encoding='utf-8')
    elif ext == '.html':
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(Path(file_path).read_text(), 'html.parser')
        return soup.get_text(separator='\n')
    elif ext in ('.jpg', '.jpeg', '.png'):
        import pytesseract
        from PIL import Image
        return pytesseract.image_to_string(Image.open(file_path))
    else:
        raise ValueError(f"Unsupported file type: {ext}")


def generate_description(text: str, model: str) -> str | None:
    try:
        excerpt = text[:8000]
        response = requests.post('http://localhost:11434/api/generate', json={
            'model': model,
            'prompt': f"Summarize this document in one paragraph, describing what it contains and what it is useful for:\n\n{excerpt}",
            'stream': False
        }, timeout=30)
        return response.json().get('response', '').strip() or None
    except Exception as e:
        print(f"Warning: description generation failed: {e}", file=sys.stderr)
        return None


def embed_to_bytes(vector: list[float]) -> bytes:
    return struct.pack(f'{len(vector)}f', *vector)


def ingest(file_path: str, collection: str):
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")
    db.enable_load_extension(True)
    db.load_extension("vec0")

    file_name = Path(file_path).name
    
    # Check for duplicates
    exists = db.execute(
        "SELECT 1 FROM documents WHERE name=? AND collection=?", 
        (file_name, collection)
    ).fetchone()
    
    if exists:
        print(f"File '{file_name}' already exists in collection '{collection}'. Skipping ingestion.", file=sys.stderr)
        sys.exit(0)

    model = db.execute(
        "SELECT value FROM settings WHERE key='summarization_model'"
    ).fetchone()
    summarization_model = (model[0] if model else 'qwen3:8b').replace('ollama/', '')

    print(f"Reading {file_path}...")
    text = extract_text(file_path)

    print("Generating description...")
    description = generate_description(text, summarization_model)

    rel_path = f"collections/{collection}/"
    cursor = db.execute(
        "INSERT INTO documents (name, collection, file_path, description) VALUES (?, ?, ?, ?)",
        (file_name, collection, rel_path, description)
    )
    doc_id = cursor.lastrowid

    print("Chunking document semantically...")
    embeddings = FastEmbedEmbeddings(model_name="BAAI/bge-m3")
    chunker = SemanticChunker(
        embeddings,
        breakpoint_threshold_type="percentile",
        breakpoint_threshold_amount=95
    )
    docs = chunker.create_documents([text])
    chunks = [d.page_content for d in docs]

    print(f"Embedding {len(chunks)} chunks...")
    chunk_embeddings = embeddings.embed_documents(chunks)

    for chunk_text, embedding in zip(chunks, chunk_embeddings):
        result = db.execute(
            "INSERT INTO memory (type, channel, doc_id, chunk_text, speaker) VALUES ('R', '__rag__', ?, ?, NULL)",
            (doc_id, chunk_text)
        )
        memory_id = result.lastrowid
        db.execute(
            "INSERT INTO memory_embeddings (rowid, embedding) VALUES (?, ?)",
            (memory_id, embed_to_bytes(embedding))
        )

    db.execute("UPDATE documents SET chunk_count=? WHERE doc_id=?", (len(chunks), doc_id))
    db.commit()
    db.close()
    print(f"Ingested {len(chunks)} chunks from {file_name}")


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("Usage: ingest.py <file_path> <collection>", file=sys.stderr)
        sys.exit(1)
    ingest(sys.argv[1], sys.argv[2])
```

### Document Commands (read-only — no confirmation needed)

```
"what documents are in my work collection?"
  → SELECT name, description, ingested_at, chunk_count FROM documents WHERE collection='work'

"list all collections"
  → SELECT DISTINCT collection FROM documents WHERE collection NOT LIKE 'p:%'
```

Destructive document operations (e.g. deleting a document) should go through confirmation:

```
"delete resume.pdf"
  → Bot: "You want me to delete resume.pdf and all its indexed chunks — is that correct? (yes / no)"
  → On confirm: DELETE FROM documents WHERE name='resume.pdf' (cascades to memory rows)
```

---

## 13. File Upload Flow (Telegram & Open WebUI)

Users attach files using native UI buttons — the paperclip in Telegram, the + button in Open WebUI. No slash commands needed. The bot intercepts the upload and asks which collection to add the file to, presenting existing collections as tappable/clickable options.

File ingestion does **not** require the confirmation flow — it is purely additive and easily reversed by deleting the document if unwanted. The collection-picker dialog that already exists serves as sufficient intent verification.

### Telegram — Inline Keyboard Buttons

```typescript
export async function handleFileUpload(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id
  const doc = msg.document ?? msg.photo?.[msg.photo.length - 1]
  if (!doc) return

  const fileLink = await bot.getFileLink((doc as any).file_id)
  const fileName = (msg.document?.file_name) ?? `image_${Date.now()}.jpg`
  const tmpPath = `/tmp/openclaw_upload/${fileName}`
  fs.mkdirSync('/tmp/openclaw_upload', { recursive: true })
  await downloadFile(fileLink, tmpPath)

  pendingUploads.set(chatId, { filePath: tmpPath, fileName })

  const rows = db.prepare(
    `SELECT DISTINCT collection FROM documents WHERE collection NOT LIKE 'p:%'`
  ).all() as { collection: string }[]
  const collections = rows.map(r => r.collection)

  const keyboard = [
    ...chunk(collections.map(c => ({ text: c, callback_data: `ingest:${c}` })), 3),
    [{ text: '➕ New collection', callback_data: 'ingest:__new__' }]
  ]

  await bot.sendMessage(chatId,
    `Which collection should I add *${fileName}* to?`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }
  )
}

export async function handleIngestCallback(bot: TelegramBot, query: TelegramBot.CallbackQuery) {
  const chatId = query.message!.chat.id
  const data = query.data!
  await bot.answerCallbackQuery(query.id)

  const pending = pendingUploads.get(chatId)
  if (!pending) return

  if (data === 'ingest:__new__') {
    awaitingNewCollection.set(chatId, pending)
    pendingUploads.delete(chatId)
    await bot.sendMessage(chatId, 'What would you like to call the new collection?')
    return
  }

  const collection = data.replace('ingest:', '')
  pendingUploads.delete(chatId)
  await runIngestion(bot, chatId, pending.filePath, pending.fileName, collection)
}

async function runIngestion(
  bot: TelegramBot, chatId: number,
  tmpPath: string, fileName: string, collection: string
) {
  const destDir = path.join(COLLECTIONS_PATH, collection)
  const destPath = path.join(destDir, fileName)
  fs.mkdirSync(destDir, { recursive: true })
  fs.renameSync(tmpPath, destPath)

  await bot.sendMessage(chatId,
    `Got it — ingesting *${fileName}* into [${collection}]...`,
    { parse_mode: 'Markdown' }
  )

  execFile('python3', [INGEST_SCRIPT, destPath, collection], (err, stdout) => {
    if (err) {
      bot.sendMessage(chatId, `❌ Ingestion failed: ${err.message}`)
    } else {
      bot.sendMessage(chatId, `✅ ${stdout.trim()}`)
    }
  })
}

function chunk<T>(arr: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size))
}
```

**Gateway wiring:**

```typescript
// Handle file uploads
if (msg.document || msg.photo) {
  await handleFileUpload(bot, msg)
  return
}

// Handle inline button callbacks
bot.on('callback_query', async (query) => {
  if (query.data?.startsWith('ingest:')) {
    await handleIngestCallback(bot, query)
  }
})

// Intercept text replies that might be new collection names
const wasCollectionName = await handleNewCollectionName(bot, msg)
if (wasCollectionName) return

// Check for pending confirmation BEFORE normal message flow
const channel = getSetting(`active_channel:tg`) ?? 'D'
const confirmResult = await handleConfirmation('tg', msg.text ?? '')
if (confirmResult !== null) {
  await bot.sendMessage(msg.chat.id, confirmResult)
  return
}

// Otherwise normal message flow...
```

### Open WebUI — File Upload via Pipeline

```python
class Pipeline:
    def __init__(self):
        self.pending_uploads: dict = {}

    async def inlet(self, body: dict, user: dict) -> dict:
        user_id = user.get('id', 'default')
        messages = body.get('messages', [])
        last = messages[-1] if messages else {}

        # Check for file attachment
        file_data = self._extract_file(last)
        if file_data:
            self.pending_uploads[user_id] = file_data
            collections = self._get_collections()
            collection_list = '\n'.join(f"  {i+1}. {c}" for i, c in enumerate(collections))
            response_text = (
                f"I received **{file_data['name']}**. "
                f"Which collection should I add it to?\n\n"
                f"Your collections:\n{collection_list}\n"
                f"  {len(collections)+1}. New collection (type a name)\n\n"
                f"Reply with a number or a new collection name."
            )
            body['__collection_prompt__'] = response_text
            return body

        # Check if user is replying to a collection prompt
        if user_id in self.pending_uploads and last.get('role') == 'user':
            reply = last.get('content', '').strip()
            pending = self.pending_uploads.pop(user_id)
            collection = self._resolve_collection(reply)
            self._run_ingestion(pending['path'], collection)
            body['__ingestion_response__'] = (
                f"Got it — ingesting **{pending['name']}** into [{collection}]..."
            )
            return body

        # Normal message — inject memory context
        query = last.get('content', '')
        channel = self._get_setting('active_channel:owui') or 'D'
        context = self._build_context(query, channel)
        body['messages'].insert(0, {'role': 'system', 'content': context})
        return body
```

### Comparison

| Feature | Telegram | Open WebUI |
|---|---|---|
| File upload button | ✅ Paperclip | ✅ Plus (+) button |
| Collection picker | ✅ Tappable inline buttons | ⚠️ Numbered text list |
| New collection | ✅ Button → type name | ✅ Type |

---

## 14. Prompt Caching

Order from most stable (top) to least stable (bottom). Cache after each stable block.

```
[MEMORY.md]                ← almost never changes  → CACHE CHECKPOINT
[Rolling summary]          ← changes every N msgs  → CACHE CHECKPOINT
[Semantic search results]  ← changes per query     — not cached
[Last N messages]          ← changes every message — not cached
[User's new message]
```

| Provider | Method |
|---|---|
| Anthropic Claude | `cache_control: {"type": "ephemeral"}` on content blocks |
| Google Gemini | Implicit prefix caching (automatic) |
| OpenAI | Automatic for prompts > 1024 tokens |
| Ollama / local | No caching — send full context each time |

Detect provider from `openclaw.json` and apply automatically.

---

## 15. Source Files

### `db.ts`
Opens SQLite connection, runs schema on startup, exports `db` singleton, `getSetting`, `updateSetting`.

### `embed.ts`
Wraps BGE-M3 ONNX (primary) and Gemini API (fallback). Auto-detects based on available RAM. Exports `embed(text): Promise<Float32Array>`. Supports batch embedding.

### `store.ts`
Exports `storeMessage(iface, channel, speaker, text)`. Checks token count — routes to large message handler if > 8000. For assistant responses (speaker='A'), sanitizes text before storing. Stores message + embedding atomically. Tracks message count for summary trigger. Manages `summaryCache`. Exports `getSummary`, `updateSummary`.

**Sanitization function:**

```typescript
const INJECTION_MARKERS = [
  /^---\s+Relevant conversation history\s+---\n?/gm,
  /^---\s+Relevant documents\s+---\n?/gm,
  /^## Conversation Summary\n/gm,
  /^## Relevant Context\n/gm,
  /^## Recent Conversation\n/gm,
  /^\[.+? — collection: .+?\]\n?/gm,
  /^\.\.\..*?\.\.\.\n?/gm,
  /^─────\n?/gm,
]

function sanitizeForStorage(text: string): string {
  let clean = text
  for (const pattern of INJECTION_MARKERS) {
    clean = clean.replace(pattern, '')
  }
  return clean.trim()
}
```

This runs only on assistant responses (speaker='A') — user messages are stored verbatim.

### `search.ts`
Exports `search(query, options)`. Runs vector and BM25 queries in parallel, merges via Reciprocal Rank Fusion (70/30 default weights), enriches RAG results with one paragraph of surrounding context. Exports `formatContext(results)`.

### `upload.ts`
Exports `handleFileUpload`, `handleIngestCallback`, `handleNewCollectionName`. Manages `pendingUploads` and `awaitingNewCollection` state maps. Calls `runIngestion` on confirmation.

### `index.ts`

```typescript
export { storeMessage, getSummary, updateSummary } from './store'
export { search, formatContext } from './search'
export { deepMemorySearch } from './deep-search'
export { getSetting, updateSetting } from './db'
export { handleFileUpload, handleIngestCallback, handleNewCollectionName } from './upload'
export { handleConfirmation, savePendingConfirmation, getPendingConfirmation, clearPendingConfirmation } from './confirm'
```

Note: `commands.ts` is eliminated in V3 and remains absent in V4. All command handling flows through LLM tools + the confirmation system. `deep-search.ts` is a new addition in V4.

---

## 16. Gateway Integration

```typescript
import {
  storeMessage, search, formatContext,
  getSummary, getSetting, handleConfirmation
} from './memory'
import * as fs from 'fs'

async function handleMessage(iface: 'tg' | 'owui', userText: string): Promise<string> {
  const channel = getSetting(`active_channel:${iface}`) ?? 'D'

  // Check for pending confirmation first — takes priority over all other processing
  const confirmResult = await handleConfirmation(iface, userText)
  if (confirmResult !== null) return confirmResult

  // Store + handle large pastes
  const storeResult = await storeMessage(iface, channel, 'U', userText)
  if (storeResult === 'LARGE_PASTE') {
    return `That looked like a large paste. I've saved and indexed it in your p:${channel} collection. What would you like to know about it?`
  }

  // Build context
  const memoryMd = fs.readFileSync(MEMORY_MD_PATH, 'utf-8')
  const summary = getSummary(channel)
  const results = await search(userText, { channel })
  const context = formatContext(results)
  const recentN = parseInt(getSetting('recent_messages_limit') ?? '10')
  const recent = getLastNMessages(channel, recentN)
  const recentText = recent
    .map(m => `${m.speaker === 'U' ? 'User' : 'Assistant'}: ${m.chunk_text}`)
    .join('\n')

  // Assemble prompt
  const systemPrompt = [
    memoryMd,
    summary    ? `## Conversation Summary\n${summary}` : '',
    context    ? `## Relevant Context\n${context}` : '',
    recentText ? `## Recent Conversation\n${recentText}` : ''
  ].filter(Boolean).join('\n\n---\n\n')

  // Call LLM with tools registered
  const { response, toolCall } = await callLLMWithTools(systemPrompt, userText)

  // If the LLM called a propose tool, the confirmation prompt is already stored.
  // Return the tool result as the response — do NOT store it as a memory message.
  if (toolCall) {
    return toolCall.result
  }

  await storeMessage(iface, channel, 'A', response)
  checkAndUpdateSummary(channel)  // fire and forget

  return response
}
```

---

## 17. Open WebUI Integration

Open WebUI's built-in RAG (ChromaDB) cannot be replaced. Use a **Filter Pipeline** to intercept requests and inject context:

1. Disable Open WebUI's built-in RAG
2. Install a Python Filter Pipeline that reads `memory.db` directly
3. Pipeline injects assembled context into system prompt before LLM call

```python
class Pipeline:
    async def inlet(self, body: dict, user: dict) -> dict:
        query = body["messages"][-1]["content"]
        channel = get_setting(db, 'active_channel:owui') or 'D'
        context = build_context(db, embedder, query, channel)
        body["messages"].insert(0, {"role": "system", "content": context})
        return body
```

The pipeline reads `memory.db` directly using Python's `sqlite3` module and `fastembed` for embeddings — sharing the same database file with the Node process. No HTTP bridge needed.

---

## 18. Configuration in `openclaw.json`

```json
{
  "models": {
    "primary": "ollama/qwen3:8b",
    "summarization": "ollama/qwen3:8b"
  },
  "memory": {
    "workspace": "~/.openclaw/workspace",
    "embedding_model": "bge-m3",
    "embedding_dim": 1024,
    "recent_messages_limit": 10,
    "summary_update_frequency": 10,
    "semantic_search_top_k": 5,
    "large_message_token_threshold": 8000,
    "confirmation_timeout_minutes": 5,
    "deep_memory_search_token_threshold": 4000,
    "chunking": {
      "breakpoint_threshold_type": "percentile",
      "breakpoint_threshold_amount": 95
    }
  }
}
```

Values in `openclaw.json` are startup defaults only. Once changed via natural language (and confirmed), the `settings` table takes precedence.

---

## 19. Dependencies

### Node/TypeScript
```
better-sqlite3          # SQLite driver with sync API
sqlite-vec              # vector search extension
@xenova/transformers    # BGE-M3 ONNX embeddings
pdf-parse               # PDF text extraction
mammoth                 # DOCX text extraction
cheerio                 # HTML text extraction
tesseract.js            # OCR for images
```

### Python (ingestion script + Open WebUI pipeline)
```
langchain-experimental  # SemanticChunker
langchain-community     # FasembedEmbeddings
fastembed               # BGE-M3 ONNX embeddings
sqlite-vec              # sqlite-vec Python bindings
pypdf                   # PDF text extraction
python-docx             # DOCX text extraction
pytesseract             # OCR for images
Pillow                  # image handling
beautifulsoup4          # HTML text extraction
requests                # Ollama API calls
```

### System
```
ollama                  # local LLM serving
tesseract-ocr           # apt install tesseract-ocr
```

---

## 20. Migration & Backup

```bash
# Backup
cp ~/.openclaw/workspace/memory.db ~/backup/memory.db
cp -r ~/.openclaw/workspace/collections ~/backup/collections

# Restore on new machine
mkdir -p ~/.openclaw/workspace
cp ~/backup/memory.db ~/.openclaw/workspace/memory.db
cp -r ~/backup/collections ~/.openclaw/workspace/collections
```

All file paths are relative — no updates needed after migration.

---

## 21. Implementation Notes for LLM

1. **Schema first.** Create and verify schema before writing any business logic. Test insert + retrieval before proceeding.

2. **sqlite-vec rowid contract.** The rowid in `memory_embeddings` MUST equal the `id` in `memory`. Insert `memory` first, capture `lastInsertRowid`, use it explicitly for `memory_embeddings`. Never let these get out of sync.

3. **Compact values are DB-only.** `U`, `A`, `D`, `p:channel`, `tg`, `owui` are storage conventions. Always translate to full human-readable values when assembling prompts or responding to users.

4. **Embedding dimensions must match everywhere.** If switching from BGE-M3 (1024) to Gemini (768), update the `vec0` table definition AND all embedding generation code.

5. **Startup sequence:** open DB → run schema → load summaryCache → load settingsCache → init embedding model → initDeepSearch (inject LLM caller) → ready.

6. **Background summarization and embedding retries** must never block response delivery. Fire and forget. Run `retryFailedEmbeddings()` at the end of the agent loop. Log failures silently.

7. **Confirmation check is always first.** In the message handler, check `pending_confirmations` before any other processing. A pending confirmation hijacks the entire message flow.

8. **Propose tools never execute.** All tools whose names begin with `propose_` only write to `pending_confirmations` and return a prompt string. Execution happens exclusively in `executeConfirmedAction`.

9. **Two kinds of non-propose tool calls.** Read-only tools (`list_channels`, `get_current_channel`, `list_collections`) execute immediately and return their result directly to the user — the LLM run ends. Execute tools that feed results back for synthesis (`deep_memory_search`) execute immediately but return their result to the LLM as a tool response, allowing the LLM to produce a final synthesized answer before the run ends. Neither type writes to `pending_confirmations`.

10. **Confirmation messages are not stored as memory.** Tool call results (confirmation prompts, cancellation acknowledgements, execution confirmations) bypass the `storeMessage` path entirely. Only genuine conversational exchanges are stored.

11. **RAG sentinel channel.** Use `'__rag__'` for all RAG chunk channel values. Search scopes RAG via collection filter, not channel.

12. **Relative file paths.** Store path without filename. Reconstruct: `path.join(WORKSPACE, doc.file_path, doc.name)`.

13. **Build incrementally:** (a) store message + embedding → (b) retrieve with search → (c) assemble prompt → (d) LLM response → (e) handle tool call OR store response. Only then add RAG, ingestion, and confirmation system.

14. **Match OpenClaw's language.** Check existing gateway language (TypeScript/JavaScript) and follow its conventions throughout.

15. **Build `deep-search.ts` after `search.ts` is proven.** `deepMemorySearch` depends entirely on `search()` and `formatContext()` from `search.ts`. Do not attempt to implement deep search until single-collection search is working and tested. The two-pass path also depends on `callLLM` being available — test single-pass first, then add two-pass.

16. **Deep memory search does not store results.** The tool result is returned to the LLM for synthesis and the LLM's final response is stored as a normal assistant message (speaker='A'). The raw tool result itself is never written to `memory`.

17. **Handle concurrent SQLite access safely.** Always enable `PRAGMA busy_timeout = 5000` in both the Node.js runtime and the Python ingestion script to prevent `SQLITE_BUSY` errors when both processes access the database simultaneously.

18. **Enforce the single-propose rule.** The LLM should only ever call one `propose_` tool per response. The `pending_confirmations` table uses `INSERT OR REPLACE` keyed by interface, so multiple propose calls in the same response will silently overwrite each other.

19. **Protect against duplicate ingestion.** The Python ingest script checks for existing `(name, collection)` pairs in the `documents` table and exits early if a match is found. This prevents duplicated chunks from polluting the embedding space.
