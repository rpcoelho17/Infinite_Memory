# AntiGravityClaw Infinite Memory — Implementation Specification V5

> **For the implementing LLM:** This document is a complete, self-contained blueprint for the memory and RAG subsystem. Read it fully before writing any code. Every architectural decision has been validated and tested. Your job is to implement exactly what is described here.

---

## 1. Overview

**Infinite Memory** is a persistent, unified memory and RAG (Retrieval-Augmented Generation) module for AntiGravityClaw (formerly OpenClaw). It runs **inside** the main project — not as a separate service — and is called via direct function imports.

### Core Capabilities
- Stores every conversation message (Telegram) permanently in SQLite
- Organizes documents into named RAG collections with semantic search
- Assembles intelligent context for the LLM on every message: MEMORY.md + rolling summary + semantic search + recent messages
- Manages multiple named channels — each with isolated memory and configurable collection scope
- All settings and channel management configurable via natural language — handled by LLM tools, not regex
- **Pre-execution confirmation for all state-changing commands**
- **Deep Memory Search** — exhaustive cross-collection research with automatic two-pass synthesis fallback

### Design Principles
- **Two-process architecture** — Node/TypeScript for runtime (always running), Python for GPU embedding server (auto-launched) and ingestion (spawned on demand). They share `memory.db` via WAL mode.
- **Single command startup** — `npm run dev` auto-launches the embedding server; no separate processes to manage.
- **Python writes directly to SQLite** — The ingestion script opens `memory.db`, loads the `vec0` extension, and inserts chunks + embeddings directly. **No temp files, no JSON handoff, no cross-process file passing.**
- **Portable brain** — copy `memory.db` + `collections/` folder to move everything to a new machine.
- **Local GPU acceleration** — Embeddings run on the user's GPU via `sentence-transformers` + CUDA. Gemini fallback is **disabled** by design to prevent vector space inconsistencies.
- **Compact storage** — abbreviated values in DB (`U`/`A`, `D`, `p:`) to minimize database growth.

---

## 2. Infrastructure

| Component | Solution | Notes |
|---|---|---|
| Host | Windows PC with NVIDIA GPU (RTX 4060 or similar) | Tested on Windows 11, Python 3.13 |
| LLM (primary) | `arcee-ai/trinity-large-preview:free` via OpenRouter | Free |
| Embeddings | `BAAI/bge-base-en-v1.5` via local GPU server | 768 dimensions, ~440MB model |
| Embedding Server | `scripts/embed_server.py` on `localhost:11435` | Auto-launched by `npm run dev` |
| Vector Search | SQLite + `sqlite-vec` (`vec0` extension) | Loaded in both Node.js and Python |
| LLM (fallback) | `gemini-2.5-flash-lite` via Google AI API | Free tier |
| Bot | Telegram via `grammy` | Long-polling, no webhook |
| Runtime | Node.js + TypeScript (`tsx watch`) | Hot-reload in dev |

### Windows Host Requirements

- **Python 3.13** with CUDA-compatible PyTorch: `pip install torch --index-url https://download.pytorch.org/whl/cu124`
- **sentence-transformers**: `pip install sentence-transformers`
- **Console Encoding:** Set `PYTHONIOENCODING=utf-8` in all spawn calls to avoid `UnicodeEncodeError`.
- **Path handling:** Always quote paths in subprocess calls — Windows paths with spaces break unquoted arguments.

### Embedding Model — BGE-Base-en-v1.5

**Model:** `BAAI/bge-base-en-v1.5` stored locally at `models/bge-base-en-v1.5/`
- **768 dimensions** — set `EMBEDDING_DIM = 768` throughout
- ~440MB model files (both `model.safetensors` and `pytorch_model.bin`)
- Local-only inference via `SentenceTransformer(model_path, device="cuda", local_files_only=True)`
- Normalized embeddings (`normalize_embeddings=True`)
- CLS pooling mode (configured in `1_Pooling/config.json`)

**Fallback:** Disabled (strictly local-only to prevent vector space mismatches).

**Why BGE-Base over BGE-Large:** BGE-Base is 2-3x faster with only marginally lower quality. On an RTX 4060, it embeds ~984 chunks from a 700-page book in ~40 seconds (31 batches × 32 chunks).

### 2.1 Model Drift & Migration Management

Because vector search depends on stable dimensions and model-specific vector spaces, any change to the embedding model requires a coordinated migration.

**1. Detection (Drift Check)**
On every startup, `sync.ts` compares the **Model Metadata** (from the running server's `/health` endpoint) against the **Database Metadata** (stored in the `settings` table as `embedding_model` and `embedding_dimension`). If they do not match, the system enters **MIGRATION MODE**.

**2. Migration Mode (Safeguard)**
While in migration mode, the LLM is restricted via a specialized system prompt:
- **Search is Disabled:** No context from `memory.db` is provided to the prompt.
- **RESTRICTED Tools:** Only migration tools (`propose_model_migration`, `propose_reingest_collections`) and core tools (`get_current_time`) are available.
- **Mandatory Notification:** The LLM MUST notify the user: *"I've detected that your default embedding model has changed. Should I switch to the new model? This will wipe clean your memory.db and all the ingestions! Respond by typing Yes or no."*

**3. Step 1: Schema Migration (`propose_model_migration`)**
Upon user confirmation ("Yes"), the system executes Step 1:
- Wipes the `memory`, `documents`, and `summaries` tables.
- Wipes the `memory_fts` (BM25) table.
- **Drops and Recreates** the `memory_embeddings` virtual table with the NEW dimension (e.g., 768 or 1024).
- Updates the `embedding_model` and `embedding_dimension` settings in the DB.

**4. Step 2: Content Re-ingestion (`propose_reingest_collections`)**
After the schema is ready, the system prompts the user to re-ingest:
- The tool loops through all sub-directories in `workspace/collections/`.
- For every file found, it spawns `scripts/ingest.py` to re-extract and re-embed.
- **Progress Reporting:** Sends real-time Telegram updates (`✅ [X/Total] Filename`) so the user can track the process without watching terminal logs.
- Links all re-ingested collections back to the `Default` (D) channel.

---

## 3. Directory Structure

```
AntiGravityClaw/
├── workspace/                      ← ALL DATA lives here
│   ├── memory.db                   ← Entire brain (chunks, embeddings, metadata)
│   ├── MEMORY.md                   ← Curated facts about user
│   └── collections/                ← Original RAG source files
│       ├── Lean6Sigma/
│       │   └── Certified Six Sigma Black Belt Handbook-ASQ (2009).pdf
│       └── Articles/
│           └── article.pdf
│
├── models/                         ← Local embedding models (offline)
│   └── bge-base-en-v1.5/          ← Complete model files
│       ├── config.json             ← hidden_size: 768
│       ├── model.safetensors
│       ├── pytorch_model.bin
│       ├── tokenizer.json
│       ├── tokenizer_config.json
│       ├── modules.json
│       └── 1_Pooling/
│           └── config.json         ← pooling_mode_cls_token: true
│
├── scripts/
│   ├── embed_server.py             ← Persistent GPU embedding HTTP server
│   └── ingest.py                   ← Document ingestion (direct-to-SQLite)
│
├── src/
│   ├── index.ts                    ← Entry point — auto-launches embed server
│   ├── bot.ts                      ← Telegram bot setup
│   ├── config.ts                   ← Environment config
│   ├── llm.ts                      ← LLM provider wrapper
│   ├── test_local_ingest.ts        ← Ingestion test script
│   └── memory/
│       ├── db.ts                   ← SQLite connection + schema + settings
│       ├── embed.ts                ← Embedding provider (local + Gemini fallback)
│       ├── ingest.ts               ← Node wrapper for Python ingestion
│       ├── store.ts                ← Message storage
│       ├── search.ts               ← Hybrid semantic search
│       └── deep-search.ts          ← Deep memory search tool
│
└── node_modules/
    └── sqlite-vec-windows-x64/
        └── vec0.dll                ← sqlite-vec native extension (loaded by both Node & Python)
```

### Portability

To copy your brain to another machine:
```bash
cp workspace/memory.db ~/backup/memory.db
cp -r workspace/collections ~/backup/collections
cp -r models/ ~/backup/models
```
All `file_path` values in `documents` table are stored as **relative paths** (e.g. `collections/Lean6Sigma/`).

---

## 4. Database Schema

> **Implement this schema exactly.** Run on first startup if tables do not exist.

```sql
-- ============================================================
-- memory.db — Complete Schema
-- ============================================================

-- ── MEMORY TABLE ─────────────────────────────────────────────
-- Stores ALL chunks: conversation messages (type='M') and
-- RAG document chunks (type='R').
CREATE TABLE IF NOT EXISTS memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL CHECK(type IN ('M', 'R')),
    channel     TEXT NOT NULL,          -- 'D' = default, '__rag__' for RAG chunks
    doc_id      INTEGER REFERENCES documents(doc_id) ON DELETE CASCADE,
    chunk_text  TEXT NOT NULL,
    speaker     TEXT CHECK(speaker IN ('U', 'A') OR speaker IS NULL),
    embedding_status TEXT DEFAULT 'ok' CHECK(embedding_status IN ('ok', 'failed')),
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memory_channel ON memory(channel);
CREATE INDEX IF NOT EXISTS idx_memory_type_channel ON memory(type, channel);
CREATE INDEX IF NOT EXISTS idx_memory_doc_id ON memory(doc_id);
CREATE INDEX IF NOT EXISTS idx_memory_timestamp ON memory(timestamp);

-- ── VECTOR EMBEDDINGS (sqlite-vec) ───────────────────────────
-- Linked by rowid — rowid in memory_embeddings MUST match id in memory.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
    embedding FLOAT[768]                -- BGE-Base dimensions
);

-- ── DOCUMENTS TABLE ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
    doc_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,          -- filename: "resume.pdf"
    collection  TEXT NOT NULL,          -- collection name: "resume"
    file_path   TEXT NOT NULL,          -- relative path: "collections/resume/"
    description TEXT,                   -- LLM-generated summary (nullable)
    status      TEXT DEFAULT 'pending', -- 'pending' | 'ingesting' | 'ready'
    ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    chunk_count INTEGER DEFAULT 0,
    UNIQUE(name, collection)
);

-- ── SUMMARIES TABLE ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS summaries (
    channel     TEXT PRIMARY KEY,
    summary     TEXT NOT NULL,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── PENDING CONFIRMATIONS TABLE ──────────────────────────────
CREATE TABLE IF NOT EXISTS pending_confirmations (
    interface       TEXT PRIMARY KEY,   -- 'tg' or 'owui'
    tool_name       TEXT NOT NULL,
    tool_params     TEXT NOT NULL,      -- JSON-encoded
    prompt_shown    TEXT NOT NULL,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── SETTINGS TABLE ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL
);

-- ── FULL TEXT SEARCH (BM25) ──────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    chunk_text,
    content='memory',
    content_rowid='id'
);

-- FTS sync triggers
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
INSERT OR IGNORE INTO settings (key, value) VALUES
    ('recent_messages_limit',               '20'),
    ('summary_update_frequency',            '10'),
    ('semantic_search_top_k',               '5'),
    ('summarization_model',                 'ollama/qwen3:8b'),
    ('vector_weight',                       '0.7'),
    ('bm25_weight',                         '0.3'),
    ('memory_decay_halflife_days',          '90'),
    ('deep_memory_search_token_threshold',  '4000'),
    ('active_channel:tg',                   'D'),
    ('active_channel:owui',                 'D');
```

### Concurrent Access — WAL Mode + Busy Timeout

Both Node runtime and Python ingestion access `memory.db` simultaneously. **Both must set:**

```typescript
// Node.js (db.ts)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')
```

```python
# Python (ingest.py)
conn.execute("PRAGMA journal_mode = WAL")
conn.execute("PRAGMA busy_timeout = 5000")
```

### Document Status Lifecycle

| Status | Meaning |
|--------|---------|
| `pending` | Registered but not yet processed (default) |
| `ingesting` | Currently being chunked and embedded |
| `ready` | Complete — chunks and embeddings stored |

If ingestion crashes, the document stays in `ingesting` and can be detected on restart for re-processing.

---

## 5. Embedding Server — `scripts/embed_server.py`

A persistent HTTP server that loads the BGE-Base model once on startup and serves embedding requests over HTTP. This avoids the 35-second model load penalty on every ingestion.

### Architecture

```
┌──────────────────────────────────────────────┐
│  embed_server.py (persistent, GPU)           │
│                                              │
│  Loads: models/bge-base-en-v1.5              │
│  Device: CUDA (RTX 4060) or CPU fallback     │
│  Port: 11435                                 │
│                                              │
│  POST /embed  →  {"texts": [...]}            │
│            ←  {"embeddings": [[...]], ...}    │
│                                              │
│  GET /health   →  {"status":"ok", ...}       │
└──────────────────────────────────────────────┘
         ▲                       ▲
         │                       │
    embed.ts (Node)         ingest.py (Python)
    (runtime queries)       (batch ingestion)
```

### Auto-Launch from `npm run dev`

The embed server is spawned automatically by `src/index.ts` on startup:

```typescript
function startEmbedServer(retryCount = 0): void {
    const scriptPath = path.join(process.cwd(), "scripts", "embed_server.py");
    const pythonCmd = process.platform === "win32"
        ? "C:\\Python313\\python.exe" : "python3";
    
    embedServerProcess = spawn(cmd, [], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        shell: true,
    });
    
    // Detect readiness
    embedServerProcess.stdout?.on("data", (data) => {
        if (msg.includes("Embedding server running")) {
            setTimeout(() => refreshLocalAvailability(), 2000);
        }
    });
    
    // Auto-retry on crash (up to 3 attempts)
    embedServerProcess.on("exit", (code) => {
        if (code !== 0 && retryCount < 2) {
            setTimeout(() => startEmbedServer(retryCount + 1), 5000);
        }
    });
}
```

### Graceful Shutdown

When the Node process exits (Ctrl+C or SIGTERM), it kills the embed server child process:

```typescript
function shutdown(signal: string) {
    if (embedServerProcess?.pid) {
        embedServerProcess.kill();  // TerminateProcess on Windows
        embedServerProcess = null;
    }
    bot.stop();
    process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
```

### Server Startup Output

The server prints to **stdout** (captured by Node.js):
```
INFO: Loading models/bge-base-en-v1.5...
GPU: Using GPU: NVIDIA GeForce RTX 4060 (8.0 GB VRAM)
SUCCESS: Model loaded in 4.2s — dimension=768, device=cuda
INFO: Embedding server running on http://127.0.0.1:11435
```

---

## 6. Document Ingestion — `scripts/ingest.py`

### Architecture — Direct-to-SQLite

Python handles the **entire** pipeline end-to-end. No temp files, no JSON handoff to Node:

```
Node.js (ingest.ts)                    Python (ingest.py)
     │                                      │
     ├── exec(python ingest.py ...)         │
     │   --db workspace/memory.db           ├── 1. Extract PDF text
     │   --collection Lean6Sigma            ├── 2. Structural chunking
     │   --vec-ext vec0                     ├── 3. HTTP → embed_server.py (GPU)
     │                                      ├── 4. sqlite3.connect(memory.db)
     │   ◄── stderr: progress stream       ├── 5. load_extension(vec0.dll)
     │   ◄── stdout: {"status":"ok",...}    └── 6. INSERT chunks + embeddings
     │
     └── Optional: LLM summary generation
```

### Command-Line Interface

```bash
python ingest.py <file_path> --db <memory.db_path> --collection <name> --vec-ext <vec0_path>
```

Node.js calls it via `exec()`:
```typescript
const cmd = `"${pythonExe}" "${scriptPath}" "${filePath}" --db "${dbPath}" --collection "${collection}" --vec-ext "${vecExtPath}"`;
exec(cmd, { env: { ...process.env, PYTHONIOENCODING: "utf-8" }, maxBuffer: 10 * 1024 * 1024 });
```

### Progress Streaming

Python prints progress to **stderr** (streamed to console and optionally to Telegram):
```
EXTRACTING: Extracting text from big_book.pdf...
EXTRACTING: Done in 24.2s (1182629 chars)
CHUNKING: 376 paragraphs detected
CHUNKING: Created 984 final chunks
EMBEDDING: Embedding 984 chunks via GPU server...
EMBEDDING: Batch 1/31 (32 chunks)...
...
EMBEDDING: Batch 31/31 (24 chunks)...
STORING: Inserting 984 chunks into memory.db (doc_id=1)...
STORED: 984 chunks + embeddings saved to DB
SUCCESS: Finished in 65.2s (984 chunks)
```

On **stdout**, only a small JSON status is printed for Node to parse:
```json
{"status": "ok", "file_name": "big_book.pdf", "chunks": 984, "time": 65.2, "collection": "Lean6Sigma"}
```

### Supported File Types

| Extension | Python Library |
|---|---|
| `.pdf` | `pypdf` |
| `.docx` | `python-docx` |
| `.txt`, `.md` | plain read (UTF-8 with UTF-16 fallback) |
| `.html` | `beautifulsoup4` |

### Structural Chunking (Not Semantic)

We use **structural chunking** — a pure text-analysis approach that splits at document structure boundaries (headings, sections, paragraphs) without requiring embedding calls during chunking.

**Why Structural over Recursive Splitting:**
- **Recursive Splitting (LangChain):** Splits blindly at string lengths, often breaking sentences or paragraphs mid-thought, relying on "overlap" to fix it.
- **Structural Chunking (Current):** Splits based on the document's own DNA (headings, paragraphs). This results in "cleaner" chunks that are semantically complete, improving retrieval precision significantly without needing high overlap.
- **Speed:** Structural splitting is O(N) where N is text length; no embeddings needed during the split phase.

#### Chunking Algorithm

**Constants (Dynamically calculated based on `max_seq_length`):**
```python
# For a typical 512-token context model (1 token ≈ 4 chars):
TARGET_CHUNK_SIZE = 1433    # target chars per chunk (max * 4 * 0.7)
MAX_CHUNK_SIZE = 1843       # hard max before forced split (max * 4 * 0.9)
MIN_CHUNK_SIZE = 80         # static minimum - ignore tiny fragments
OVERLAP_SIZE = 100          # static - chars of overlap between consecutive chunks
```

**Phase 1 — Paragraph splitting:**
Split text at double newlines (`\n\n`) and form feeds (`\f`).

**Phase 2 — Heading detection:**
Identify section boundaries using regex patterns:
```python
HEADING_PATTERNS = [
    r'^#{1,6}\s',                           # Markdown headers
    r'^[A-Z][A-Z\s]{4,}$',                  # ALL CAPS lines (5+ chars)
    r'^\d+(\.\d+)*\.?\s+[A-Z]',             # Numbered headings: "1.2 Title"
    r'^(Chapter|Section|Part|Appendix)\s',   # Named sections
]
```

**Phase 3 — Chunk assembly:**
1. If a paragraph starts with a heading → flush current chunk, start new one
2. If current chunk exceeds `TARGET_CHUNK_SIZE` → flush and start new
3. If final chunk is below `MIN_CHUNK_SIZE` → discard

**Phase 4 — Oversized chunk splitting:**
Chunks exceeding `MAX_CHUNK_SIZE` are split at sentence boundaries (`.!?` followed by `\s+[A-Z]`).

**Phase 5 — Overlap injection:**
For retrieval continuity, each chunk (except the first) is prepended with the last 100 characters of the previous chunk.

### Direct SQLite Storage

Python loads `vec0.dll` and writes directly to the database:

```python
def store_in_db(db_path, vec_ext_path, file_name, collection, text_preview, chunks, embeddings):
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.enable_load_extension(True)
    conn.load_extension(vec_ext_path)  # Loads vec0.dll
    conn.enable_load_extension(False)
    
    # Self-sufficient: creates tables if they don't exist
    # (so Python works even if Node hasn't initialized the DB yet)
    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS documents (...);
        CREATE TABLE IF NOT EXISTS memory (...);
    """)
    cursor.execute("CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(...)")
    
    # Insert or re-ingest document
    cursor.execute("INSERT OR IGNORE INTO documents (..., status) VALUES (?, ..., 'ingesting')")
    
    # Insert all chunks + embeddings
    for chunk, emb in zip(chunks, embeddings):
        cursor.execute("INSERT INTO memory (...) VALUES ('R', '__rag__', ?, ?, NULL)", ...)
        row_id = cursor.lastrowid
        emb_bytes = struct.pack(f'<{len(emb)}f', *emb)  # little-endian float32
        cursor.execute("INSERT INTO memory_embeddings (rowid, embedding) VALUES (?, ?)", (row_id, emb_bytes))
    
    cursor.execute("UPDATE documents SET chunk_count=?, status='ready' WHERE doc_id=?", ...)
    conn.commit()
```

**Embedding binary format:** Little-endian `float32` bytes, e.g. 768 floats × 4 bytes = 3,072 bytes per embedding. This matches what `sqlite-vec` expects and what Node.js produces via `Float32Array`.

### Node.js Wrapper — `src/memory/ingest.ts`

A thin wrapper that spawns Python, streams progress messages, and reads the JSON status:

```typescript
export async function runIngestion(
    filePath: string, collection: string, onProgress?: (msg: string) => void
): Promise<string> {
    const cmd = `"${pythonExe}" "${scriptPath}" "${filePath}" --db "${dbPath}" --collection "${collection}" --vec-ext "${vecExtPath}"`;
    
    return new Promise((resolve, reject) => {
        const child = exec(cmd, { env, maxBuffer: 10MB, timeout: 30min });
        
        // Stream stderr progress
        child.stderr?.on('data', (data) => {
            if (onProgress) {
                if (line.startsWith('EXTRACTING:')) onProgress(`📄 ${line}`);
                else if (line.startsWith('EMBEDDING:')) onProgress(`🧠 ${line}`);
                else if (line.startsWith('STORING:')) onProgress(`💾 ${line}`);
            }
        });
        
        child.on('close', async (code) => {
            const result = JSON.parse(stdout.trim());
            if (result.status === "ok") {
                // Optional: Generate LLM summary
                resolve(`Ingested ${result.chunks} chunks in ${result.time}s`);
            }
        });
    });
}
```

---

## 7. Runtime Embedding — `src/memory/embed.ts`

For runtime queries (search, message embedding), Node.js calls the same GPU server:

```typescript
const LOCAL_EMBED_URL = "http://127.0.0.1:11435";

async function embedLocal(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${LOCAL_EMBED_URL}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts }),
    });
    const data = await res.json();
    return data.embeddings.map(e => new Float32Array(e));
}
```

**Fallback:** The system intentionally disables fallback to the Gemini embedding API to prevent vector space inconsistencies. `embed.ts` strictly requires `isLocalEmbeddingAvailable()` before proceeding.

**Buffer conversion for sqlite-vec:**
```typescript
export function embeddingToBuffer(embedding: Float32Array): Buffer {
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}
```

---

## 8. Semantic Search — Hybrid Vector + BM25

### Reciprocal Rank Fusion

Every search runs **two queries simultaneously** and merges via RRF:
- **Vector search** (70% weight): finds semantically similar content
- **BM25 keyword search** (30% weight): finds exact term matches

**Temporal decay:** Conversation memories (`type='M'`) decay over time (90-day half-life). RAG document chunks (`type='R'`) never decay.

### SQL — Vector Query
```sql
SELECT m.*, e.distance, d.name AS doc_name, d.collection
FROM memory_embeddings e
JOIN memory m ON m.id = e.rowid
LEFT JOIN documents d ON d.doc_id = m.doc_id
WHERE e.embedding MATCH :queryVector AND k = :topK
  AND ((m.type = 'M' AND m.channel = :channel)
    OR (m.type = 'R' AND (:collections IS NULL OR d.collection IN (:collections))))
ORDER BY e.distance ASC;
```

### 8.3 Search Scoping & Isolation

To ensure privacy and research focus, the system enforces strict logical isolation between channels:

1.  **Linked Collections:** Each channel can be explicitly linked to one or more document collections via the `channel_collections:[CHANNELNAME]` setting (comma-separated).
2.  **Paste Isolation:** Every channel has an automatic, exclusive paste collection called `p:[CHANNELNAME]`. Pastes from "Channel A" are never visible in "Channel B".
3.  **Default Scope:** If a user searches without specifying a collection, the system automatically scopes the search to:
    -   All explicitly linked collections.
    -   The channel's own paste collection (`p:[CHANNELNAME]`).
    -   The channel's conversation history (`type='M'`).

### 8.4 Deep Memory Search (Exhaustive/Recursive)

For complex research questions requiring a holistic view across the channel's entire "brain," the system provides the `deepMemorySearch` tool:

1.  **Fan-out:** The system identifies all target sources (History, Linked Collections, Channel Pastes).
2.  **History Pass:** A dedicated synthesis pass is performed over the last N relevant conversation messages (`type='M'`).
3.  **Collection Passes:** A full hybrid search (Vector + BM25) is performed against every linked collection independently.
4.  **Recursive Synthesis:** 
   - **Pass 1 (Detection):** If total findings are small (<4000 tokens), they are all injected into the prompt directly.
   - **Pass 2 (Synthesis):** If findings are large, the system **recursively summarizes** each source's findings first, then passes the summaries to the LLM for final synthesis.
5.  **Benefit:** This ensures that every document and memory point is "read" by the system, even if there are hundreds of documents that would normally overflow the context window.

---

## 9. Compact Value Conventions

| Concept | DB Value | Prompt Value |
|---|---|---|
| Default channel | `D` | `Default` |
| Speaker: user | `U` | `User` |
| Speaker: assistant | `A` | `Assistant` |
| RAG chunk channel | `__rag__` | n/a |
| Paste collection | `p:D`, `p:work` | n/a |
| Interface: Telegram | `tg` | n/a |

---

## 10. Channel System

Channels isolate conversation memory. Every message belongs to a channel. Semantic search is scoped to the current channel.

- **Default channel:** `D` — used until user creates a new one.
- **Per-interface active channel:** `active_channel:tg` and `active_channel:owui` — tracked independently.
- **RAG chunks use `__rag__` channel** — filtered by collection, not channel.

---

## 11. LLM Tools

All state-changing operations go through **propose → confirm → execute** flow. Tools whose names begin with `propose_` write to `pending_confirmations` and return a confirmation prompt. Execution happens only after the user confirms.

**Tools:**
| Tool Name                      | Description                                            |
|:-------------------------------|:-------------------------------------------------------|
| `propose_switch_channel`       | Propose switching to a different channel.              |
| `propose_rename_channel`       | Propose renaming the current channel.                  |
| `propose_sync_channels`        | Propose syncing two channels (merging their history).  |
| `propose_delete_channel`       | Propose deleting a channel and its history.            |
| `propose_change_setting`       | Propose updating system settings (top_k, decay, etc.). |
| `propose_link_collection`      | Link an external collection to the current channel.    |
| `propose_unlink_collection`    | Remove a collection from the current channel's scope.  |
| `propose_delete_document`      | Delete a document from a collection (file + DB).       |
| `propose_reingest_collections` | Re-index all documents with the current embedding model. Sends real-time progress messages to Telegram. |
| `propose_model_migration`      | Migrate to a new embedding model (wipes memory.db).   |

**Read-only tools (no confirmation):** `list_channels`, `get_current_channel`, `list_collections`, `list_documents`, `get_channel_info`, `deep_memory_search`

### `[DIRECT_SENT]` Mechanism

Some read-only tools (e.g., `list_collections`) need deterministic, pre-formatted output that the LLM must not rephrase. These tools send messages **directly** to the user via `bot.api.sendMessage()` and return `"[DIRECT_SENT]"`. The agent loop in `agent.ts` detects this marker and:
1. Sets `finalResponse` to an empty string.
2. Breaks out of the tool-call loop immediately (no further LLM iteration).
3. `bot.ts` skips `ctx.reply()` when the response is empty.

This ensures the user receives exactly one message — the tool's formatted output — with no LLM-generated duplicate.

### Telegram Slash Commands

These commands are handled directly in `bot.ts` and bypass the LLM agent loop entirely:

| Command          | Description                                           |
|:-----------------|:------------------------------------------------------|
| `/start`         | Welcome message and bot status.                       |
| `/help`          | Help guide with all available commands.               |
| `/settings`      | View current system settings table.                   |
| `/documents`     | List all ingested documents with collection and link status. |
| `/collections`   | List all available document collections.              |
| `/clear`         | Wipe history for the current channel.                 |
| `/global_reset`  | Wipe everything across all channels.                  |

---

## 12. Message Flow

```
1. MESSAGE ARRIVES → identify interface ('tg'), get active channel
2. CHECK SLASH COMMANDS → /documents, /collections, /settings handled directly (no LLM)
3. CHECK PENDING CONFIRMATION → route to confirmation handler if exists
4. CHECK MESSAGE SIZE → if >8000 tokens, auto-ingest as paste
5. STORE USER MESSAGE → type='M', speaker='U', embed immediately
6. BUILD CONTEXT:
   a) MEMORY.md (stable, cached)
   b) Rolling summary (messages 11-30)
   c) Semantic search results (current query)
   d) Last 20 messages verbatim
7. SEND TO LLM with tools registered
8. HANDLE TOOL CALLS:
   a) propose_* tools → halt loop, return confirmation prompt
   b) [DIRECT_SENT] tools → halt loop, return empty (tool already messaged user)
   c) Normal tools → append result, continue loop
9. STORE ASSISTANT RESPONSE → type='M', speaker='A' (sanitized, skip if empty)
10. CHECK SUMMARY TRIGGER → fire background summarization if needed
11. DELIVER RESPONSE (skip if empty — tool already sent directly)
```

---

## 13. Dependencies

### Node.js / TypeScript
```
better-sqlite3          # SQLite driver with sync API
sqlite-vec              # Vector search extension (vec0.dll)
@google/generative-ai   # Gemini API client
grammy                  # Telegram bot framework
tsx                     # TypeScript execution + hot reload
cross-env               # Cross-platform env vars
```

### Python
```
torch                   # PyTorch with CUDA (pip install torch --index-url cu124)
sentence-transformers   # Model loading + inference
pypdf                   # PDF text extraction
python-docx             # DOCX text extraction
beautifulsoup4          # HTML text extraction
```
Note: Python uses only built-in `sqlite3`, `http.client`, `json`, `struct` — no external DB or HTTP libraries needed.

---

## 14. Startup Sequence

```
npm run dev
  └── tsx watch src/index.ts
        ├── 1. Open memory.db (db.ts)
        │     ├── Load sqlite-vec extension
        │     ├── Run schema (CREATE TABLE IF NOT EXISTS...)
        │     ├── createEmbeddingTable(dim) — dynamic vec0 dimension
        │     ├── Run migrations (ALTER TABLE for old schemas)
        │     └── Load settings cache
        ├── 2. Start embed server (index.ts)
        │     ├── spawn("python.exe", "scripts/embed_server.py")
        │     ├── Wait for "Embedding server running" on stdout
        │     └── Call refreshLocalAvailability() after detection
        ├── 3. Check model drift (sync.ts)
        │     ├── Compare DB model/dim vs .env and server /health
        │     ├── If mismatch → Enable restricted **MIGRATION MODE**
        │     ├── Notify user via Telegram (Mandatory drift message)
        │     └── If user confirms "Yes" → Call `propose_model_migration`
        ├── 4. Finalize Migration (Optional)
        │     └── Prompt user to re-ingest collections via `propose_reingest_collections`
        ├── 5. Start Telegram bot (long-polling)
        └── 6. Ready — processing messages (Migration Mode cleared if synced)
```

---

## 15. Implementation Notes

1. **`EMBEDDING_DIM = 768`** everywhere. Both `vec0` table definition and all embedding code must match.

2. **sqlite-vec rowid contract.** Rowid in `memory_embeddings` MUST equal `id` in `memory`. Insert `memory` first, capture `lastInsertRowid`, use it for `memory_embeddings`.

3. **Python self-sufficiency.** `ingest.py` creates tables if they don't exist, so it works even if Node hasn't started first.

4. **vec0 extension path.** Python receives it as `--vec-ext` argument. On Windows: `node_modules/sqlite-vec-windows-x64/vec0` (without `.dll` — SQLite adds it automatically).

5. **Embedding binary format.** Little-endian `float32` bytes. Python: `struct.pack('<768f', *values)`. Node: `Buffer.from(Float32Array.buffer)`.

6. **No temp files.** Python writes directly to SQLite. The only cross-process communication is stderr (progress) and stdout (small JSON status).

7. **Background summarization** must never block response delivery. Fire and forget.

8. **Propose tools never execute.** All `propose_*` tools only write to `pending_confirmations`. Execution is in `executeConfirmedAction`.

9. **RAG sentinel channel.** Use `'__rag__'` for all RAG chunk channel values. Search scopes RAG via collection filter, not channel.

10. **Duplicate prevention.** `UNIQUE(name, collection)` in `documents` table. On re-ingestion, Python clears old chunks and re-inserts.

11. **Model Drift Detection.** `sync.ts` checks the embedding server metadata on startup. If the model or dimension changes, it performs a migration that automatically wipes the `memory`, `documents`, and `summaries` tables to prevent vector space corruption.

12. **Re-ingestion progress messages.** `propose_reingest_collections` sends real-time Telegram messages via `bot.api.sendMessage()`: a start announcement, per-document completion updates (`✅ [1/5] col/file.pdf`), and a final summary.

13. **`createEmbeddingTable(dim)`.** `db.ts` exports a function that drops and recreates `memory_embeddings` with the specified dimension. Used at startup and during model migration.

14. **Null safety in migration.** `performMigration()` uses `?? 768` / `?? 512` defaults for `dimension` and `max_seq_length` to prevent crashes when server metadata is incomplete.

---

## 16. Test Command

```bash
npm run test:ingest
# Runs: cross-env NODE_OPTIONS=--max-old-space-size=4096 tsx src/test_local_ingest.ts
# Test file: workspace/collections/Lean6Sigma/Certified Six Sigma Black Belt Handbook-ASQ (2009).pdf
# Expected: ~984 chunks, ~65s total, exit code 0
```
