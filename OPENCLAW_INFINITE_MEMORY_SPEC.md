# OpenClaw Infinite Memory — Implementation Specification

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
- All settings configurable via natural language commands

### Design Principles
- **Two-process architecture** — Node/TypeScript for runtime (always running), Python for ingestion (spawned on demand). They share `memory.db` — no HTTP between them.
- **Portable brain** — copy `memory.db` + `collections/` folder to move everything to a new machine
- **Local first** — all data stays on your server. No third-party data transmission by default.
- **Zero extra cost** — runs entirely on free infrastructure
- **Compact storage** — abbreviated values in DB (U/A, D, p:) to minimize database growth
- **Best tool for each job** — Python for ingestion (LangChain SemanticChunker, superior NLP libraries), TypeScript for runtime (existing OpenClaw codebase)

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
        ├── upload.ts               ← file upload handler (Telegram + Open WebUI)
        └── commands.ts             ← natural language command handler

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
    speaker     TEXT CHECK(speaker IN ('U', 'A', NULL)),
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
    chunk_count INTEGER DEFAULT 0       -- updated after ingestion completes
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

-- ── SETTINGS TABLE ────────────────────────────────────────────
-- Default settings (insert only if not already present)
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('recent_messages_limit',       '10'),
    ('summary_update_frequency',    '5'),
    ('semantic_search_top_k',       '5'),
    ('summarization_model',         'ollama/qwen3:8b'),
    ('vector_weight',               '0.7'),
    ('bm25_weight',                 '0.3'),
    ('memory_decay_halflife_days',  '90'),  -- conversation memories decay to ~37% after 90 days
                                            -- set to 0 to disable decay entirely
    ('active_channel:tg',           'D'),
    ('active_channel:owui',         'D');
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
  → sets active_channel:owui = value of active_channel:tg

"sync telegram to my open web ui channel"
  → sets active_channel:tg = value of active_channel:owui
```

### Channel Commands (intercepted before LLM — no LLM call made)

```
"create a new channel called work"
  → updates active_channel:<interface> = 'work'

"switch to my work channel"
  → updates active_channel:<interface> = 'work'

"what channel am I on?"
  → returns active_channel for current interface

"list my channels"
  → SELECT DISTINCT channel FROM memory WHERE channel NOT LIKE 'p:%'

"list my pastes"
  → SELECT DISTINCT channel FROM memory WHERE channel LIKE 'p:%'

"rename this channel to project_x"
  → UPDATE memory SET channel='project_x' WHERE channel=currentChannel
  → UPDATE summaries SET channel='project_x' WHERE channel=currentChannel
  → UPDATE settings WHERE value=currentChannel
```

---

## 7. Settings System

All parameters stored in `settings` table, changeable via natural language. Gateway intercepts these before sending to LLM — no LLM call made.

### Global Settings

| Key | Default | Example Command |
|---|---|---|
| `recent_messages_limit` | `10` | `"increase my short term memory to 20 messages"` |
| `summary_update_frequency` | `5` | `"summarize every 10 messages"` |
| `semantic_search_top_k` | `5` | `"give me more context"` → sets to 10 |
| `summarization_model` | `"ollama/qwen3:8b"` | `"use phi4 for summaries"` |
| `memory_decay_halflife_days` | `90` | `"make older memories fade faster"` → sets to 30, `"never forget anything"` → sets to 0 (disables decay) |

### Per-Channel Settings

Stored with key format `setting_name:channel`:

```
"search only my work and resume collections"
  → active_collections:work = 'work,resume'

"add my personal collection to the search"
  → appends 'personal' to active_collections for current channel

"search all collections"
  → DELETE active_collections key for current channel

"what collections are you searching?"
  → reads active_collections for current channel
```

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

2. CHECK MESSAGE SIZE
   Count tokens in message.
   If tokens > 8000:
     → Auto-ingest to paste collection p:<channel> (see Section 11)
     → Store short reference in memory: '[Large paste — collection: p:<channel>]'
     → Respond: "That looked like a large paste. I've saved and indexed it in 
                 your p:<channel> collection. What would you like to know about it?"
     → STOP. No LLM call.
   If tokens <= 8000: continue.

3. STORE IMMEDIATELY
   Insert full message into memory BEFORE any LLM call.
   type='M', channel=currentChannel, speaker='U'
   Generate one embedding → insert into memory_embeddings.

4. CHECK FOR COMMAND
   Pattern-match against known natural language commands (Sections 6 and 7).
   If matched: execute, respond directly, STOP. No LLM call.

5. BUILD CONTEXT
   Assemble in this exact order:

   a) MEMORY.md
      Read from WORKSPACE/MEMORY.md. Always included.
      Rarely changes → prompt cache checkpoint here.

   b) Rolling summary
      Load from summaryCache for current channel.
      Omit if empty. Changes every N messages → prompt cache checkpoint here.

   c) Rolling summary
      Covers messages 11–30 (the middle band).
      Load from summaryCache for current channel.
      Omit if fewer than 11 messages exist. Changes every 20 messages.

   d) Semantic search results
      Run search() with current message as query.
      Scoped to messages 11+ (intentionally overlaps summary band).
      Memory: scoped to current channel only.
      RAG: scoped to active_collections for current channel.
      Returns top_k=5 results with source labels, decay applied.
      Semantic search overlaps the summary band deliberately — the summary
      is lossy and may drop specific details. Semantic search acts as a
      safety net, surfacing exact content the summary may have compressed away.
      Changes per query — not cached.

   e) Last 10 messages verbatim
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
   Send to primary LLM with prompt caching applied (see Section 13).

8. STORE RESPONSE — WITH SANITIZATION
   Sanitize the LLM response before storing it.
   Strip all injected context markers so they don't get stored as if
   the LLM said them, creating a pollution loop in future searches.
   Then insert into memory.
   type='M', channel=currentChannel, speaker='A'
   Generate one embedding → insert into memory_embeddings.

9. CHECK SUMMARY TRIGGER
   If new message count >= summary_update_frequency:
     → Fire background summarization (non-blocking, fire and forget)

10. DELIVER RESPONSE
    Return to Telegram or Open WebUI.
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

### Update

The summary covers **messages 11–30** — the middle band between the verbatim window and deep history. Triggered in background every 20 messages. Never blocks response delivery. If it fails, log and continue.

```typescript
async function updateSummary(channel: string): Promise<void> {
  // Fetch messages 11–30 (the middle band)
  const middleBand = getMessageRange(channel, 11, 30)
  if (middleBand.length === 0) return

  const prompt = `You are summarizing a band of conversation history (messages 11–30).
This summary will be injected into context alongside the last 10 verbatim messages,
so do not repeat anything likely still in the recent window.
Focus on: decisions made, facts established, topics covered, user preferences expressed.
Write as a single cohesive paragraph. Be concise but complete.

Messages to summarize:
${middleBand.map(m => `${m.speaker === 'U' ? 'User' : 'Assistant'}: ${m.chunk_text}`).join('\n')}

Summary:`

  const newSummary = await callLLM(prompt, { model: getSetting('summarization_model') })
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

Together they cover each other's blind spots. The merge weights are 70% vector + 30% BM25, matching OpenClaw's native implementation.

### FTS5 Schema Addition

Add to the database schema (alongside the existing tables):

```sql
-- Full-text search index for BM25 keyword search
-- content= makes it a content table — no duplicate storage, reads from memory table
-- content_rowid= links it to memory.id
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    chunk_text,
    content='memory',
    content_rowid='id'
);

-- Keep FTS index in sync with memory table via triggers
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
```

The `content=` option means FTS5 does not duplicate the text — it reads from the `memory` table directly. No storage overhead. Triggers keep the index automatically in sync.

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
  k = 60,              // RRF constant — dampens the impact of rank position
  halfLifeDays = 90    // temporal decay half-life — configurable via settings
): SearchResult[] {
  const scores = new Map<number, number>()

  // Build a lookup of all results by id for decay access
  const allById = new Map<number, SearchResult>()
  ;[...vectorResults, ...bm25Results].forEach(r => allById.set(r.id, r))

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

  // Merge all unique results, sorted by combined score descending
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

After merging results, enrich RAG chunks (type='R') with one paragraph of surrounding context from neighboring chunks in the same document. This gives the LLM enough context to understand what came before and after the matching passage, without injecting entire neighboring chunks which could be very large.

**Why one paragraph, not the full neighboring chunk:**
SemanticChunker chunks can be large and variable in size. Returning full neighboring chunks on top of the match could easily inject 2000+ tokens per result × 5 results = 10,000+ tokens of RAG context before conversation history is even added. One paragraph is bounded (~100-150 tokens) regardless of chunk size.

```typescript
async function enrichWithContext(results: SearchResult[]): Promise<SearchResult[]> {
  return Promise.all(results.map(async (result) => {
    // Only enrich RAG chunks — conversation messages need no surrounding context
    if (result.type !== 'R' || !result.doc_id) return result

    // Get the previous chunk in the same document (by id, ordered)
    const prevChunk = db.prepare(`
      SELECT chunk_text FROM memory 
      WHERE doc_id = ? AND id < ? AND type = 'R'
      ORDER BY id DESC LIMIT 1
    `).get(result.doc_id, result.id) as { chunk_text: string } | undefined

    // Get the next chunk in the same document
    const nextChunk = db.prepare(`
      SELECT chunk_text FROM memory 
      WHERE doc_id = ? AND id > ? AND type = 'R'
      ORDER BY id ASC LIMIT 1
    `).get(result.doc_id, result.id) as { chunk_text: string } | undefined

    // Extract last paragraph of previous chunk
    const prevParagraph = prevChunk
      ? prevChunk.chunk_text.split('\n\n').filter(Boolean).at(-1) ?? null
      : null

    // Extract first paragraph of next chunk
    const nextParagraph = nextChunk
      ? nextChunk.chunk_text.split('\n\n').filter(Boolean).at(0) ?? null
      : null

    return { ...result, prev_paragraph: prevParagraph, next_paragraph: nextParagraph }
  }))
}
```

### Context Formatting for Prompt

Translate compact values, group by type, show paragraph context with visual separators:

```
--- Relevant conversation history ---
User: We decided to use PostgreSQL for the main database.
Assistant: Good choice. PostgreSQL handles concurrent writes better than MySQL...

--- Relevant documents ---
[resume.pdf — collection: resume]
...previously discussing education background...
─────
Experienced backend engineer with 8 years of TypeScript and distributed
systems experience. Led migration of monolithic Rails app to microservices,
reducing p99 latency by 60%.
─────
...continues with list of technical skills...
```

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
// upload.ts — called after user confirms collection choice
import { execFile } from 'child_process'
import path from 'path'

export function runIngestion(filePath: string, collection: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [path.join(__dirname, '../../../scripts/ingest.py'), filePath, collection],
      { env: { ...process.env } },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message))
        else resolve(stdout.trim())  // e.g. "Ingested 47 chunks from resume.pdf"
      }
    )
  })
}
```

Python holds a brief SQLite write lock only while inserting each chunk. Node reads freely the rest of the time. SQLite's file-level locking handles concurrent access safely.

### Supported File Types

All file parsing happens inside `ingest.py`:

| Extension | Python Library |
|---|---|
| `.pdf` | `pypdf` |
| `.docx` | `python-docx` |
| `.txt`, `.md` | plain read |
| `.html` | `beautifulsoup4` |
| `.jpg`, `.png` | `pytesseract` + `Pillow` |

### Semantic Chunking — LangChain SemanticChunker

**Do not use fixed-size or sentence-boundary chunking.** Use LangChain's `SemanticChunker` from `langchain_experimental`, which splits documents at natural topic boundaries by analyzing the semantic similarity between adjacent sentences. This produces far more meaningful chunks for RAG than arbitrary splits.

```python
from langchain_experimental.text_splitter import SemanticChunker
from langchain_community.embeddings import FasembedEmbeddings

# BGE-M3 via fastembed — same model used everywhere in this system
embeddings = FasembedEmbeddings(model_name="BAAI/bge-m3")

chunker = SemanticChunker(
    embeddings,
    breakpoint_threshold_type="percentile",  # split at the most semantically distinct boundaries
    breakpoint_threshold_amount=95           # top 5% of dissimilarity = chunk boundary
)

chunks = chunker.create_documents([document_text])
```

**Breakpoint threshold types** (choose based on document type):
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
from datetime import datetime

from langchain_experimental.text_splitter import SemanticChunker
from langchain_community.embeddings import FasembedEmbeddings
import requests  # for Ollama summarization

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
    """Call Ollama to generate a one-paragraph document summary."""
    try:
        excerpt = text[:8000]  # first ~2000 tokens
        response = requests.post('http://localhost:11434/api/generate', json={
            'model': model,
            'prompt': f"Summarize this document in one paragraph, describing what it contains and what it would be useful for:\n\n{excerpt}",
            'stream': False
        }, timeout=30)
        return response.json().get('response', '').strip() or None
    except Exception as e:
        print(f"Warning: description generation failed: {e}", file=sys.stderr)
        return None


def embed_to_bytes(vector: list[float]) -> bytes:
    """Pack float list to little-endian bytes for sqlite-vec."""
    return struct.pack(f'{len(vector)}f', *vector)


def ingest(file_path: str, collection: str):
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")  # safe concurrent access with Node

    # Load sqlite-vec extension
    db.enable_load_extension(True)
    db.load_extension("vec0")

    # Get settings
    model = db.execute(
        "SELECT value FROM settings WHERE key='summarization_model'"
    ).fetchone()
    summarization_model = (model[0] if model else 'qwen3:8b').replace('ollama/', '')

    # Extract text
    print(f"Reading {file_path}...")
    text = extract_text(file_path)

    # Generate description
    print("Generating description...")
    description = generate_description(text, summarization_model)

    # Register document
    file_name = Path(file_path).name
    rel_path = f"collections/{collection}/"
    cursor = db.execute(
        "INSERT INTO documents (name, collection, file_path, description) VALUES (?, ?, ?, ?)",
        (file_name, collection, rel_path, description)
    )
    doc_id = cursor.lastrowid

    # Semantic chunking with LangChain SemanticChunker + BGE-M3
    print("Chunking document semantically...")
    embeddings = FasembedEmbeddings(model_name="BAAI/bge-m3")
    chunker = SemanticChunker(
        embeddings,
        breakpoint_threshold_type="percentile",
        breakpoint_threshold_amount=95
    )
    docs = chunker.create_documents([text])
    chunks = [d.page_content for d in docs]

    # Embed and store each chunk
    print(f"Embedding {len(chunks)} chunks...")
    chunk_embeddings = embeddings.embed_documents([c for c in chunks])

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

    # Update chunk count
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

### Document Commands (handled in `commands.ts`)

```
"what documents are in my work collection?"
  → SELECT name, description, ingested_at, chunk_count FROM documents WHERE collection='work'

"delete resume.pdf"
  → DELETE FROM documents WHERE name='resume.pdf' (cascades to memory rows)
  → Confirm with user before deleting file from disk

"list all collections"
  → SELECT DISTINCT collection FROM documents WHERE collection NOT LIKE 'p:%'
```

---

## 13. File Upload Flow (Telegram & Open WebUI)

Users attach files using native UI buttons — the paperclip in Telegram, the `+` button in Open WebUI. No slash commands needed. The bot intercepts the upload and asks which collection to add the file to, presenting existing collections as tappable/clickable options.

### Telegram — Inline Keyboard Buttons

Telegram supports native `InlineKeyboardButton` — tappable buttons rendered directly in the chat. This is the best possible UX: no typing required for common collections.

**Complete flow:**

```
1. User taps paperclip → sends file (PDF, DOCX, image, etc.)

2. Bot receives document message.
   Downloads file to a temp location: /tmp/openclaw_upload/<filename>

3. Bot queries existing collections:
   SELECT DISTINCT collection FROM documents WHERE collection NOT LIKE 'p:%'

4. Bot sends message with inline keyboard:

   "Which collection should I add resume.pdf to?"

   [ work ]  [ research ]  [ resume ]
   [ ➕ New collection ]

5a. User taps an existing collection button:
    → Callback query fires with collection name
    → Bot acknowledges: "Got it, adding to [work]..."
    → Moves file: collections/work/resume.pdf
    → Spawns: python3 scripts/ingest.py collections/work/resume.pdf work
    → On completion: "✅ Ingested resume.pdf into [work] — 47 chunks indexed."

5b. User taps "New collection":
    → Bot replies: "What would you like to call the new collection?"
    → User types name (e.g. "clients")
    → Bot confirms: "Got it, adding to [clients]..."
    → Creates directory: collections/clients/
    → Moves file, runs ingestion as above
```

**TypeScript implementation (`upload.ts`):**

```typescript
import TelegramBot from 'node-telegram-bot-api'
import { execFile } from 'child_process'
import path from 'path'
import fs from 'fs'
import { db } from './db'

// State map: tracks users mid-upload awaiting collection choice
const pendingUploads = new Map<number, { filePath: string; fileName: string }>()
const awaitingNewCollection = new Map<number, { filePath: string; fileName: string }>()

export async function handleFileUpload(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id
  const doc = msg.document ?? msg.photo?.[msg.photo.length - 1]
  if (!doc) return

  // Download file from Telegram
  const fileLink = await bot.getFileLink((doc as any).file_id)
  const fileName = (msg.document?.file_name) ?? `image_${Date.now()}.jpg`
  const tmpPath = `/tmp/openclaw_upload/${fileName}`
  fs.mkdirSync('/tmp/openclaw_upload', { recursive: true })
  await downloadFile(fileLink, tmpPath)

  // Store pending state
  pendingUploads.set(chatId, { filePath: tmpPath, fileName })

  // Get existing collections
  const rows = db.prepare(
    `SELECT DISTINCT collection FROM documents WHERE collection NOT LIKE 'p:%'`
  ).all() as { collection: string }[]
  const collections = rows.map(r => r.collection)

  // Build inline keyboard — max 3 per row, then "New collection" button
  const collectionButtons = collections.map(c => ([{ text: c, callback_data: `ingest:${c}` }]))
  const keyboard = [
    ...chunk(collections.map(c => ({ text: c, callback_data: `ingest:${c}` })), 3),
    [{ text: '➕ New collection', callback_data: 'ingest:__new__' }]
  ]

  await bot.sendMessage(chatId,
    `Which collection should I add *${fileName}* to?`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }
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

export async function handleNewCollectionName(bot: TelegramBot, msg: TelegramBot.Message) {
  const chatId = msg.chat.id
  const pending = awaitingNewCollection.get(chatId)
  if (!pending) return false  // not waiting for a collection name

  const collection = msg.text!.trim().toLowerCase().replace(/\s+/g, '_')
  awaitingNewCollection.delete(chatId)
  await runIngestion(bot, chatId, pending.filePath, pending.fileName, collection)
  return true
}

async function runIngestion(
  bot: TelegramBot, chatId: number,
  tmpPath: string, fileName: string, collection: string
) {
  const destDir = path.join(COLLECTIONS_PATH, collection)
  const destPath = path.join(destDir, fileName)
  fs.mkdirSync(destDir, { recursive: true })
  fs.renameSync(tmpPath, destPath)

  await bot.sendMessage(chatId, `Got it — ingesting *${fileName}* into [${collection}]...`, 
    { parse_mode: 'Markdown' })

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

**Gateway wiring** — in the main Telegram message handler:

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

// Otherwise normal message flow...
```

---

### Open WebUI — File Upload via Pipeline

Open WebUI's `+` button allows file attachments in the chat. The Filter Pipeline's `inlet` function receives the full request body including any attached files.

**Important UX difference from Telegram:** Open WebUI cannot render interactive buttons — it's a plain chat interface. So instead of tappable buttons, the bot replies with a numbered text list and the user types their choice.

```
Bot: "I received resume.pdf. Which collection should I add it to?

Your collections:
  1. work
  2. research
  3. resume
  4. New collection (type a name)

Reply with a number or a new collection name."
```

**Pipeline implementation:**

```python
class Pipeline:
    def __init__(self):
        self.pending_uploads: dict = {}  # user_id → {file_path, file_name}

    async def inlet(self, body: dict, user: dict) -> dict:
        user_id = user.get('id', 'default')
        messages = body.get('messages', [])
        last = messages[-1] if messages else {}

        # Check for file attachment in the message
        file_data = self._extract_file(last)
        if file_data:
            self.pending_uploads[user_id] = file_data
            collections = self._get_collections()
            collection_list = '\n'.join(
                f"  {i+1}. {c}" for i, c in enumerate(collections)
            )
            response_text = (
                f"I received **{file_data['name']}**. "
                f"Which collection should I add it to?\n\n"
                f"Your collections:\n{collection_list}\n"
                f"  {len(collections)+1}. New collection (type a name)\n\n"
                f"Reply with a number or a new collection name."
            )
            # Short-circuit — return response without hitting LLM
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

        # Normal message — inject memory context as usual
        query = last.get('content', '')
        channel = self._get_setting('active_channel:owui') or 'D'
        context = self._build_context(query, channel)
        body['messages'].insert(0, {'role': 'system', 'content': context})
        return body
```

---

### Comparison

| Feature | Telegram | Open WebUI |
|---|---|---|
| File upload button | ✅ Paperclip | ✅ Plus (+) button |
| Collection picker | ✅ Tappable inline buttons | ⚠️ Numbered text list |
| New collection | ✅ Button → type name | ✅ Type

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

## 14. Source Files

### `db.ts`
Opens SQLite connection, runs schema on startup, exports `db` singleton, `getSetting`, `updateSetting`.

### `embed.ts`
Wraps BGE-M3 ONNX (primary) and Gemini API (fallback). Auto-detects based on available RAM. Exports `embed(text): Promise<Float32Array>`. Supports batch embedding.

### `store.ts`
Exports `storeMessage(iface, channel, speaker, text)`. Checks token count — routes to large message handler if > 8000. For assistant responses (speaker='A'), sanitizes text before storing. Stores message + embedding atomically. Tracks message count for summary trigger. Manages `summaryCache`. Exports `getSummary`, `updateSummary`.

**Sanitization function** — strips all context injection markers from LLM responses before storage, preventing feedback loops where injected RAG content gets re-stored as new memories:

```typescript
const INJECTION_MARKERS = [
  /^---\s+Relevant conversation history\s+---\n?/gm,
  /^---\s+Relevant documents\s+---\n?/gm,
  /^## Conversation Summary\n/gm,
  /^## Relevant Context\n/gm,
  /^## Recent Conversation\n/gm,
  /^\[.+? — collection: .+?\]\n?/gm,   // [filename — collection: name]
  /^\.\.\..*?\.\.\.\n?/gm,             // ...surrounding paragraph context...
  /^─────\n?/gm,                        // visual separators
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
Exports `search(query, options)`. Runs vector and BM25 queries in parallel, merges via Reciprocal Rank Fusion (70/30 default weights), enriches RAG results with one paragraph of surrounding context from neighboring chunks. Exports `formatContext(results)` — translates U/A, groups by type, renders paragraph context with visual separators for LLM-ready output.

### `ingest.ts`
Exports `ingestDocument(filePath, collection)`. Handles all file types, semantic chunking, embedding, document registration, description generation. Also handles large paste ingestion.

### `commands.ts`
Exports `handleCommand(iface, channel, text): Promise<string | null>`. Returns response if command matched, `null` otherwise. Simple keyword/pattern matching — no LLM call. Covers channel, settings, collection, and sync commands.

### `index.ts`
```typescript
export { storeMessage, getSummary, updateSummary } from './store'
export { search, formatContext } from './search'
export { ingestDocument } from './ingest'
export { getSetting, updateSetting } from './db'
export { handleCommand } from './commands'
```

---

## 15. Gateway Integration

```typescript
import {
  storeMessage, search, formatContext,
  handleCommand, getSummary, getSetting
} from './memory'
import * as fs from 'fs'

async function handleMessage(iface: 'tg' | 'owui', userText: string): Promise<string> {
  const channel = getSetting(`active_channel:${iface}`) ?? 'D'
  
  // Store + handle large pastes
  const storeResult = await storeMessage(iface, channel, 'U', userText)
  if (storeResult === 'LARGE_PASTE') {
    return `That looked like a large paste. I've saved and indexed it in your p:${channel} collection. What would you like to know about it?`
  }
  
  // Natural language commands
  const commandResult = await handleCommand(iface, channel, userText)
  if (commandResult !== null) return commandResult
  
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
    summary   ? `## Conversation Summary\n${summary}` : '',
    context   ? `## Relevant Context\n${context}` : '',
    recentText ? `## Recent Conversation\n${recentText}` : ''
  ].filter(Boolean).join('\n\n---\n\n')
  
  const response = await callLLM(systemPrompt, userText)
  
  await storeMessage(iface, channel, 'A', response)
  checkAndUpdateSummary(channel)  // fire and forget
  
  return response
}
```

---

## 16. Open WebUI Integration

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

## 17. Configuration in `openclaw.json`

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
    "summary_update_frequency": 5,
    "semantic_search_top_k": 5,
    "large_message_token_threshold": 8000
  }
}
```

Values in `openclaw.json` are startup defaults only. Once changed via natural language, the `settings` table takes precedence.

---

## 18. Dependencies

### Node/TypeScript
```
better-sqlite3          # SQLite driver with sync API
sqlite-vec              # vector search extension
@xenova/transformers    # BGE-M3 ONNX embeddings
compromise              # sentence tokenization for semantic chunking
pdf-parse               # PDF text extraction
mammoth                 # DOCX text extraction
cheerio                 # HTML text extraction
tesseract.js            # OCR for images
```

### Python (ingestion script + Open WebUI pipeline)
```
langchain-experimental  # SemanticChunker — semantic document splitting
langchain-community     # FasembedEmbeddings — LangChain wrapper for fastembed
fastembed               # BGE-M3 ONNX embeddings (used by both LangChain wrapper and pipeline directly)
sqlite-vec              # sqlite-vec Python bindings
pypdf                   # PDF text extraction
python-docx             # DOCX text extraction
pytesseract             # OCR for images
Pillow                  # image handling
beautifulsoup4          # HTML text extraction
requests                # Ollama API calls for description generation
```

### System
```
ollama                  # local LLM serving
tesseract-ocr           # apt install tesseract-ocr
```

---

## 19. Migration & Backup

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

## 20. Implementation Notes for LLM

1. **Schema first.** Create and verify schema before writing any business logic. Test insert + retrieval before proceeding.

2. **sqlite-vec rowid contract.** The rowid in `memory_embeddings` MUST equal the `id` in `memory`. Insert `memory` first, capture `lastInsertRowid`, use it explicitly for `memory_embeddings`. Never let these get out of sync.

3. **Compact values are DB-only.** `U`, `A`, `D`, `p:channel`, `tg`, `owui` are storage conventions. Always translate to full human-readable values when assembling prompts or responding to users.

4. **Embedding dimensions must match everywhere.** If switching from BGE-M3 (1024) to Gemini (768), update the `vec0` table definition AND all embedding generation code.

5. **Startup sequence:** open DB → run schema → load summaryCache → load settingsCache → init embedding model → ready.

6. **Background summarization** must never block response delivery. Fire and forget. Log failures silently.

7. **Command detection** uses simple keyword/pattern matching — never an LLM call. Fast and deterministic.

8. **RAG sentinel channel.** Use `'__rag__'` for all RAG chunk channel values. Search scopes RAG via collection filter, not channel.

9. **Relative file paths.** Store path without filename. Reconstruct: `path.join(WORKSPACE, doc.file_path, doc.name)`.

10. **Semantic chunking threshold** of 0.7 is a starting point. Tune based on observed chunk sizes.

11. **Build incrementally:** (a) store message + embedding → (b) retrieve with search → (c) assemble prompt → (d) LLM response → (e) store response. Only then add RAG, ingestion, and commands.

12. **Match OpenClaw's language.** Check existing gateway language (TypeScript/JavaScript) and follow its conventions throughout.
