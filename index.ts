// infinite-memory/index.ts — OpenClaw Infinite Memory Plugin
// Single-file plugin. Drop this alongside openclaw.plugin.json,
// scripts/embed.py, and scripts/ingest.py.

import Database from 'better-sqlite3'
import { execFile } from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface SearchResult {
  id: number
  type: 'M' | 'R'
  channel: string
  chunk_text: string
  prev_paragraph: string | null
  next_paragraph: string | null
  speaker: 'U' | 'A' | null
  timestamp: string
  distance: number
  doc_name: string | null
  file_path: string | null
  collection: string | null
  doc_id: number | null
}

type Iface = 'tg' | 'owui'

// ═══════════════════════════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════════════════════════

let _db: Database.Database | null = null

function initDb(workspacePath: string): Database.Database {
  if (_db) return _db

  const dbPath = path.join(workspacePath, 'memory.db')
  fs.mkdirSync(workspacePath, { recursive: true })

  _db = new Database(dbPath)
  _db.pragma('journal_mode = WAL')
  _db.pragma('synchronous = NORMAL')
  _db.pragma('foreign_keys = ON')

  // Load sqlite-vec for vector search
  const vecPaths = [
    '/usr/local/lib/vec0.so',
    '/usr/lib/sqlite3/vec0.so',
    path.join(os.homedir(), '.local/lib/vec0.so'),
  ]
  for (const p of vecPaths) {
    if (fs.existsSync(p)) {
      try { _db.loadExtension(p) } catch {}
      break
    }
  }

  applySchema(_db)
  return _db
}

function db(): Database.Database {
  if (!_db) throw new Error('[infinite-memory] DB not initialized')
  return _db
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL CHECK(type IN ('M','R')),
      channel    TEXT NOT NULL,
      doc_id     INTEGER REFERENCES documents(doc_id) ON DELETE CASCADE,
      chunk_text TEXT NOT NULL,
      speaker    TEXT CHECK(speaker IN ('U','A')),
      timestamp  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_memory_channel   ON memory(channel);
    CREATE INDEX IF NOT EXISTS idx_memory_type_ch   ON memory(type, channel);
    CREATE INDEX IF NOT EXISTS idx_memory_timestamp ON memory(timestamp);

    CREATE TABLE IF NOT EXISTS documents (
      doc_id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      collection  TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      description TEXT,
      ingested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      chunk_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS summaries (
      channel    TEXT PRIMARY KEY,
      summary    TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      chunk_text, content='memory', content_rowid='id'
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

    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('recent_messages_limit',      '10'),
      ('summary_update_frequency',   '20'),
      ('semantic_search_top_k',      '5'),
      ('summarization_model',        'ollama/qwen3:8b'),
      ('vector_weight',              '0.7'),
      ('bm25_weight',                '0.3'),
      ('memory_decay_halflife_days', '90'),
      ('active_channel:tg',          'D'),
      ('active_channel:owui',        'D');
  `)

  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(embedding FLOAT[1024]);`)
  } catch {
    console.warn('[infinite-memory] sqlite-vec not loaded — vector search disabled')
  }
}

// ── Settings helpers ──────────────────────────────────────────

function getSetting(key: string): string | null {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as any
  return row?.value ?? null
}

function setSetting(key: string, value: string): void {
  db().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

function getSettingInt(key: string, fallback: number): number {
  const v = getSetting(key); return v ? (parseInt(v, 10) || fallback) : fallback
}

function getSettingFloat(key: string, fallback: number): number {
  const v = getSetting(key); return v ? (parseFloat(v) || fallback) : fallback
}

function getActiveChannel(iface: string): string {
  return getSetting(`active_channel:${iface}`) ?? 'D'
}

function setActiveChannel(iface: string, channel: string): void {
  setSetting(`active_channel:${iface}`, channel)
}

// ═══════════════════════════════════════════════════════════════
// EMBEDDING
// ═══════════════════════════════════════════════════════════════

let embedScriptPath = ''

function embed(text: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    execFile('python3', [embedScriptPath, '--embed', '--text', text],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`embed failed: ${stderr || err.message}`))
        try { resolve(new Float32Array(JSON.parse(stdout.trim()))) }
        catch { reject(new Error(`embed parse error: ${stdout}`)) }
      }
    )
  })
}

function embeddingToBuffer(e: Float32Array): Buffer {
  return Buffer.from(e.buffer)
}

function countTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ═══════════════════════════════════════════════════════════════
// SEARCH  (hybrid vector + BM25 with RRF + temporal decay)
// ═══════════════════════════════════════════════════════════════

function temporalDecay(timestamp: string, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1.0
  const ageDays = (Date.now() - new Date(timestamp).getTime()) / 86_400_000
  return Math.exp(-ageDays / halfLifeDays)
}

function rrf(
  vectorResults: SearchResult[],
  bm25Results: SearchResult[],
  vw: number, bw: number,
  halfLife: number,
  k = 60
): SearchResult[] {
  const scores = new Map<number, number>()

  vectorResults.forEach((r, i) => {
    const decay = r.type === 'M' ? temporalDecay(r.timestamp, halfLife) : 1.0
    scores.set(r.id, (scores.get(r.id) ?? 0) + vw * (1 / (k + i + 1)) * decay)
  })
  bm25Results.forEach((r, i) => {
    const decay = r.type === 'M' ? temporalDecay(r.timestamp, halfLife) : 1.0
    scores.set(r.id, (scores.get(r.id) ?? 0) + bw * (1 / (k + i + 1)) * decay)
  })

  const all = [...new Map([...vectorResults, ...bm25Results].map(r => [r.id, r])).values()]
  return all.sort((a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
}

function enrichWithContext(results: SearchResult[]): SearchResult[] {
  return results.map(r => {
    if (r.type !== 'R' || !r.doc_id) return r

    const prev = db().prepare(
      `SELECT chunk_text FROM memory WHERE doc_id=? AND id<? AND type='R' ORDER BY id DESC LIMIT 1`
    ).get(r.doc_id, r.id) as any

    const next = db().prepare(
      `SELECT chunk_text FROM memory WHERE doc_id=? AND id>? AND type='R' ORDER BY id ASC LIMIT 1`
    ).get(r.doc_id, r.id) as any

    return {
      ...r,
      prev_paragraph: prev ? prev.chunk_text.split('\n\n').filter(Boolean).at(-1) ?? null : null,
      next_paragraph: next ? next.chunk_text.split('\n\n').filter(Boolean).at(0) ?? null : null,
    }
  })
}

async function search(
  query: string,
  options: { channel: string; collections?: string[]; minMessageIndex?: number }
): Promise<SearchResult[]> {
  const topK = getSettingInt('semantic_search_top_k', 5)
  const vw = getSettingFloat('vector_weight', 0.7)
  const bw = getSettingFloat('bm25_weight', 0.3)
  const halfLife = getSettingFloat('memory_decay_halflife_days', 90)
  const { channel, collections } = options

  // Resolve minimum message id for scoping to messages 11+
  let minId: number | null = null
  if (options.minMessageIndex !== undefined) {
    const row = db().prepare(
      `SELECT id FROM memory WHERE type='M' AND channel=? ORDER BY id ASC LIMIT 1 OFFSET ?`
    ).get(channel, options.minMessageIndex - 1) as any
    minId = row?.id ?? null
  }

  const colFilter = collections?.length
    ? `AND d.collection IN (${collections.map(() => '?').join(',')})`
    : ''
  const colParams = collections ?? []
  const msgFilter = minId !== null ? `AND m.id >= ${minId}` : ''

  // Vector search
  let vectorResults: SearchResult[] = []
  try {
    const buf = embeddingToBuffer(await embed(query))
    vectorResults = db().prepare(`
      SELECT m.id, m.type, m.channel, m.chunk_text, m.speaker, m.timestamp,
             e.distance, d.name AS doc_name, d.file_path, d.collection, d.doc_id,
             NULL AS prev_paragraph, NULL AS next_paragraph
      FROM memory_embeddings e
      JOIN memory m ON m.id = e.rowid
      LEFT JOIN documents d ON d.doc_id = m.doc_id
      WHERE e.embedding MATCH ? AND k = ${topK * 3}
        AND ((m.type='M' AND m.channel=? ${msgFilter}) OR (m.type='R' ${colFilter}))
      ORDER BY e.distance ASC
    `).all(buf, channel, ...colParams) as SearchResult[]
  } catch { /* sqlite-vec not loaded */ }

  // BM25 search
  let bm25Results: SearchResult[] = []
  try {
    const q = query.replace(/['"*]/g, ' ').trim()
    if (q) {
      bm25Results = db().prepare(`
        SELECT m.id, m.type, m.channel, m.chunk_text, m.speaker, m.timestamp,
               bm25(memory_fts) AS distance, d.name AS doc_name, d.file_path, d.collection, d.doc_id,
               NULL AS prev_paragraph, NULL AS next_paragraph
        FROM memory_fts
        JOIN memory m ON m.id = memory_fts.rowid
        LEFT JOIN documents d ON d.doc_id = m.doc_id
        WHERE memory_fts MATCH ?
          AND ((m.type='M' AND m.channel=? ${msgFilter}) OR (m.type='R' ${colFilter}))
        ORDER BY bm25(memory_fts) ASC LIMIT ${topK * 3}
      `).all(q, channel, ...colParams) as SearchResult[]
    }
  } catch (err) { console.warn('[infinite-memory] BM25 failed:', err) }

  const merged = rrf(vectorResults, bm25Results, vw, bw, halfLife).slice(0, topK)
  return enrichWithContext(merged)
}

function formatResults(results: SearchResult[]): string {
  if (!results.length) return ''
  return '## Relevant Context\n\n' + results.map(r => {
    if (r.type === 'M') {
      return `[${r.speaker === 'U' ? 'User' : 'Assistant'} — ${r.timestamp.split('T')[0]}]\n${r.chunk_text}`
    }
    const prev = r.prev_paragraph ? `...${r.prev_paragraph}...\n─────\n` : ''
    const next = r.next_paragraph ? `\n─────\n...${r.next_paragraph}...` : ''
    return `[${r.doc_name} — collection: ${r.collection}]\n${prev}${r.chunk_text}${next}`
  }).join('\n\n---\n\n')
}

// ═══════════════════════════════════════════════════════════════
// STORE  (messages, sanitization, rolling summary)
// ═══════════════════════════════════════════════════════════════

const INJECTION_MARKERS = [
  /^## Relevant Context\n/gm,
  /^## Conversation Summary\n/gm,
  /^## Recent Conversation\n/gm,
  /^\[.+? — collection: .+?\]\n?/gm,
  /^\.\.\..+?\.\.\.\n?/gm,
  /^─────\n?/gm,
  /^---\n?/gm,
  /^\[(?:User|Assistant) — \d{4}-\d{2}-\d{2}\]\n?/gm,
]

function sanitize(text: string): string {
  let out = text
  for (const re of INJECTION_MARKERS) out = out.replace(re, '')
  return out.trim()
}

const summaryCache = new Map<string, string>()
const msgCounts = new Map<string, number>()

function loadSummaryCache(): void {
  const rows = db().prepare('SELECT channel, summary FROM summaries').all() as any[]
  rows.forEach(r => summaryCache.set(r.channel, r.summary))
}

function getMsgCount(channel: string): number {
  if (!msgCounts.has(channel)) {
    const row = db().prepare(`SELECT COUNT(*) as n FROM memory WHERE type='M' AND channel=?`).get(channel) as any
    msgCounts.set(channel, row.n)
  }
  return msgCounts.get(channel)!
}

async function storeMessage(channel: string, speaker: 'U' | 'A', text: string): Promise<void> {
  const storedText = speaker === 'A' ? sanitize(text) : text
  if (!storedText) return

  const embedding = await embed(storedText)
  const buf = embeddingToBuffer(embedding)

  db().transaction(() => {
    const r = db().prepare(`INSERT INTO memory (type, channel, chunk_text, speaker) VALUES ('M',?,?,?)`).run(channel, storedText, speaker)
    try { db().prepare(`INSERT INTO memory_embeddings (rowid, embedding) VALUES (?,?)`).run(r.lastInsertRowid, buf) } catch {}
  })()

  const count = getMsgCount(channel) + 1
  msgCounts.set(channel, count)

  if (count >= 11 && count % getSettingInt('summary_update_frequency', 20) === 0) {
    updateSummary(channel).catch(err => console.warn('[infinite-memory] summary failed:', err))
  }
}

function getRecentMessages(channel: string, limit: number) {
  return (db().prepare(
    `SELECT speaker, chunk_text FROM memory WHERE type='M' AND channel=? ORDER BY id DESC LIMIT ?`
  ).all(channel, limit) as any[]).reverse()
}

function getMessageRange(channel: string, start: number, end: number) {
  return db().prepare(
    `SELECT speaker, chunk_text FROM memory WHERE type='M' AND channel=? ORDER BY id ASC LIMIT ? OFFSET ?`
  ).all(channel, end - start + 1, start - 1) as any[]
}

async function updateSummary(channel: string): Promise<void> {
  const band = getMessageRange(channel, 11, 30)
  if (!band.length) return

  const model = (getSetting('summarization_model') ?? 'ollama/qwen3:8b').replace('ollama/', '')
  const messages = band.map((m: any) => `${m.speaker === 'U' ? 'User' : 'Assistant'}: ${m.chunk_text}`).join('\n')

  const prompt = `You are summarizing conversation messages 11–30.
This summary sits alongside the last 10 verbatim messages, so skip anything likely still in the recent window.
Focus on: decisions made, facts established, topics covered, preferences expressed.
Write as a single cohesive paragraph. Be concise but complete.

Messages:
${messages}

Summary:`

  const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
  const res = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false }),
  })
  if (!res.ok) throw new Error(`Ollama ${res.status}`)

  const { response } = await res.json() as { response: string }
  summaryCache.set(channel, response.trim())
  db().prepare(`INSERT OR REPLACE INTO summaries (channel, summary, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)`)
    .run(channel, response.trim())
}

// ═══════════════════════════════════════════════════════════════
// COMMANDS  (intercepted before LLM — no LLM call made)
// ═══════════════════════════════════════════════════════════════

function getActiveCollections(channel: string): string[] | undefined {
  const v = getSetting(`active_collections:${channel}`)
  return v ? v.split(',').map(c => c.trim()) : undefined
}

function handleCommand(msg: string, iface: Iface, channel: string): { handled: boolean; response?: string } {
  const m = msg.toLowerCase().trim()

  // Channel switching
  const createMatch = m.match(/(?:create|make).*?channel.*?called\s+(\w+)/i)
    ?? m.match(/switch to.*?(\w+)\s+channel/i)
    ?? m.match(/(?:go to|use).*?(\w+)\s+channel/i)
  if (createMatch) {
    setActiveChannel(iface, createMatch[1].toLowerCase())
    return { handled: true, response: `Switched to channel **${createMatch[1].toLowerCase()}**.` }
  }

  if (/what channel|which channel|current channel/i.test(m))
    return { handled: true, response: `You're on channel **${channel}**.` }

  if (/list.*channels?/i.test(m) && !/pastes?/i.test(m)) {
    const rows = db().prepare(`SELECT DISTINCT channel FROM memory WHERE type='M' AND channel NOT LIKE 'p:%' ORDER BY channel`).all() as any[]
    return { handled: true, response: `Channels:\n${rows.map(r => `- ${r.channel === 'D' ? 'Default (D)' : r.channel}`).join('\n') || '(none)'}` }
  }

  if (/list.*pastes?/i.test(m)) {
    const rows = db().prepare(`SELECT DISTINCT channel FROM memory WHERE type='M' AND channel LIKE 'p:%' ORDER BY channel`).all() as any[]
    return { handled: true, response: `Paste collections:\n${rows.map(r => `- ${r.channel}`).join('\n') || '(none)'}` }
  }

  const renameMatch = m.match(/rename.*?channel.*?to\s+(\w+)/i)
  if (renameMatch) {
    const n = renameMatch[1].toLowerCase()
    db().prepare(`UPDATE memory SET channel=? WHERE channel=?`).run(n, channel)
    db().prepare(`UPDATE summaries SET channel=? WHERE channel=?`).run(n, channel)
    setActiveChannel(iface, n)
    return { handled: true, response: `Channel renamed to **${n}**.` }
  }

  if (/sync.*telegram.*(?:open ?web ?ui|owui)/i.test(m)) {
    setActiveChannel('owui', getActiveChannel('tg'))
    return { handled: true, response: `Open WebUI synced to Telegram channel: **${getActiveChannel('tg')}**.` }
  }
  if (/sync.*(?:open ?web ?ui|owui).*telegram/i.test(m)) {
    setActiveChannel('tg', getActiveChannel('owui'))
    return { handled: true, response: `Telegram synced to Open WebUI channel: **${getActiveChannel('owui')}**.` }
  }

  // Settings
  const recentMatch = m.match(/(?:short[- ]?term memory|recent messages?).*?(\d+)/i) ?? m.match(/remember.*?(\d+)\s+messages?/i)
  if (recentMatch) { setSetting('recent_messages_limit', recentMatch[1]); return { handled: true, response: `Short-term memory set to **${recentMatch[1]} messages**.` } }

  const freqMatch = m.match(/summarize.*?(?:every|each)\s+(\d+)/i)
  if (freqMatch) { setSetting('summary_update_frequency', freqMatch[1]); return { handled: true, response: `Summary frequency set to every **${freqMatch[1]} messages**.` } }

  if (/more context|increase.*context|more results/i.test(m)) {
    const n = String(Math.min(getSettingInt('semantic_search_top_k', 5) + 3, 15))
    setSetting('semantic_search_top_k', n)
    return { handled: true, response: `Context retrieval increased to **${n} results**.` }
  }

  const modelMatch = m.match(/(?:use|summarize with|switch to)\s+(\S+)\s+for summaries?/i)
  if (modelMatch) { setSetting('summarization_model', `ollama/${modelMatch[1]}`); return { handled: true, response: `Summarization model set to **${modelMatch[1]}**.` } }

  if (/fade faster|forget faster|decay faster/i.test(m)) { setSetting('memory_decay_halflife_days', '30'); return { handled: true, response: `Decay set to 30-day half-life.` } }
  if (/never forget|no decay|disable.*decay|don't forget/i.test(m)) { setSetting('memory_decay_halflife_days', '0'); return { handled: true, response: `Memory decay disabled. Nothing forgotten.` } }

  // Collections
  if (/list.*collections?|what collections?/i.test(m)) {
    const rows = db().prepare(`SELECT collection, COUNT(*) as n FROM documents GROUP BY collection ORDER BY collection`).all() as any[]
    return { handled: true, response: `Collections:\n${rows.map(r => `- **${r.collection}** (${r.n} chunks)`).join('\n') || '(none)'}` }
  }

  const colMatch = m.match(/search only\s+(.+?)(?:\s+collections?)?$/i)
  if (colMatch) {
    const cols = colMatch[1].split(/\s+and\s+|\s*,\s*/).map((c: string) => c.trim().toLowerCase())
    setSetting(`active_collections:${channel}`, cols.join(','))
    return { handled: true, response: `Now searching collections: **${cols.join(', ')}**.` }
  }

  if (/search all collections?/i.test(m)) {
    db().prepare(`DELETE FROM settings WHERE key=?`).run(`active_collections:${channel}`)
    return { handled: true, response: `Now searching all collections.` }
  }

  if (/what collections.*searching|which collections/i.test(m)) {
    const f = getSetting(`active_collections:${channel}`)
    return { handled: true, response: f ? `Searching: **${f}**.` : `Searching **all collections**.` }
  }

  return { handled: false }
}

// ═══════════════════════════════════════════════════════════════
// CONTEXT ASSEMBLY  (three-band model)
// ═══════════════════════════════════════════════════════════════

async function buildContext(channel: string, query: string): Promise<string> {
  const parts: string[] = []

  // Band 2: summary of messages 11–30
  const summary = summaryCache.get(channel)
  if (summary) parts.push(`## Conversation Summary\n${summary}`)

  // Band 3 (overlapping): semantic search from message 11 onwards
  const collections = getActiveCollections(channel)
  const results = await search(query, { channel, collections, minMessageIndex: 11 })
  if (results.length) parts.push(formatResults(results))

  // Band 1: last N messages verbatim
  const limit = getSettingInt('recent_messages_limit', 10)
  const recent = getRecentMessages(channel, limit)
  if (recent.length) {
    const verbatim = recent.map((m: any) => `${m.speaker === 'U' ? 'User' : 'Assistant'}: ${m.chunk_text}`).join('\n')
    parts.push(`## Recent Conversation\n${verbatim}`)
  }

  return parts.join('\n\n')
}

// ═══════════════════════════════════════════════════════════════
// PLUGIN REGISTRATION
// ═══════════════════════════════════════════════════════════════

export default function register(api: any) {
  const config = api.config?.plugins?.entries?.['infinite-memory']?.config ?? {}

  const workspacePath = config.workspacePath
    ?? process.env.OPENCLAW_WORKSPACE
    ?? path.join(os.homedir(), '.openclaw/workspace')

  const pluginDir = path.resolve(__dirname)
  embedScriptPath = path.join(pluginDir, 'scripts', 'embed.py')
  const ingestScript = path.join(pluginDir, 'scripts', 'ingest.py')

  initDb(workspacePath)
  loadSummaryCache()

  // ── before_agent_start ───────────────────────────────────────
  // Runs before every LLM call.
  // Handles commands, large pastes, stores user message, injects context.

  api.registerHook('before_agent_start', async (ctx: any) => {
    try {
      const iface: Iface = (ctx?.session?.channelId ?? '').includes('telegram') ? 'tg' : 'owui'
      const channel = getActiveChannel(iface)
      const userMessage: string = ctx.message?.text ?? ctx.userMessage ?? ''
      if (!userMessage) return

      // Intercept commands — no LLM needed
      const cmd = handleCommand(userMessage, iface, channel)
      if (cmd.handled) {
        ctx.abort = true
        ctx.abortResponse = cmd.response
        return
      }

      // Auto-ingest large pastes — no LLM needed
      if (countTokens(userMessage) > 8000) {
        const pasteCol = `p:${channel}`
        const tmp = `/tmp/paste_${Date.now()}.txt`
        fs.writeFileSync(tmp, userMessage)
        await new Promise<void>((res, rej) =>
          execFile('python3', [ingestScript, tmp, pasteCol], (e, _, se) => e ? rej(new Error(se)) : res())
        )
        fs.unlinkSync(tmp)
        await storeMessage(channel, 'U', `[Large paste — indexed in collection: ${pasteCol}]`)
        ctx.abort = true
        ctx.abortResponse = `That looked like a large paste. I've indexed it in \`${pasteCol}\`. What would you like to know about it?`
        return
      }

      // Store user message
      await storeMessage(channel, 'U', userMessage)

      // Build and inject three-band memory context
      const context = await buildContext(channel, userMessage)
      if (context) ctx.systemPromptExtra = (ctx.systemPromptExtra ?? '') + '\n\n' + context

    } catch (err) {
      console.error('[infinite-memory] before_agent_start error:', err)
      // Graceful degradation — never block the agent
    }
  }, {
    name: 'infinite-memory.before-agent-start',
    description: 'Inject persistent memory context before LLM call',
  })

  // ── agent_end ────────────────────────────────────────────────
  // Stores the assistant response after every LLM reply.
  // Sanitization strips injected context markers before storage.

  api.registerHook('agent_end', async (ctx: any) => {
    try {
      const iface: Iface = (ctx?.session?.channelId ?? '').includes('telegram') ? 'tg' : 'owui'
      const channel = getActiveChannel(iface)
      const response: string = ctx.response?.text ?? ctx.assistantMessage ?? ''
      if (response) await storeMessage(channel, 'A', response)
    } catch (err) {
      console.error('[infinite-memory] agent_end error:', err)
      // Never block response delivery
    }
  }, {
    name: 'infinite-memory.agent-end',
    description: 'Store assistant response in persistent memory',
  })

  // ── Agent tools ───────────────────────────────────────────────

  api.registerTool('memory_search', {
    description: 'Search your long-term memory and document collections.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        collections: { type: 'array', items: { type: 'string' } }
      },
      required: ['query']
    },
    run: async (params: any, ctx: any) => {
      const iface: Iface = (ctx?.session?.channelId ?? '').includes('telegram') ? 'tg' : 'owui'
      const channel = getActiveChannel(iface)
      const results = await search(params.query, { channel, collections: params.collections })
      return formatResults(results) || 'No relevant memories found.'
    }
  })

  api.registerTool('memory_ingest', {
    description: 'Ingest a file into a named document collection.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        collection: { type: 'string' }
      },
      required: ['filePath', 'collection']
    },
    run: (params: any) => new Promise((resolve, reject) =>
      execFile('python3', [ingestScript, params.filePath, params.collection],
        (err, _, se) => err ? reject(new Error(se)) : resolve(`Ingested into collection: ${params.collection}`)
      )
    )
  })

  // ── CLI commands ──────────────────────────────────────────────

  api.registerCli(({ program }: any) => {
    const mem = program.command('memory').description('Infinite Memory management')

    mem.command('search <query>')
      .option('-c, --channel <ch>', 'Channel', 'D')
      .option('--collections <cols>', 'Comma-separated filter')
      .action(async (query: string, opts: any) => {
        const cols = opts.collections?.split(',').map((c: string) => c.trim())
        const results = await search(query, { channel: opts.channel, collections: cols })
        console.log(formatResults(results) || 'No results.')
      })

    mem.command('ingest <file> <collection>')
      .action((file: string, col: string) => {
        console.log(`Ingesting ${file} → ${col}...`)
        execFile('python3', [ingestScript, file, col], (err, _, se) => {
          if (err) console.error('Error:', se)
          else console.log('Done.')
        })
      })

    mem.command('stats').action(() => {
      const msgs = (db().prepare(`SELECT COUNT(*) as n FROM memory WHERE type='M'`).get() as any).n
      const chunks = (db().prepare(`SELECT COUNT(*) as n FROM memory WHERE type='R'`).get() as any).n
      const docs = (db().prepare(`SELECT COUNT(*) as n FROM documents`).get() as any).n
      console.log(`Messages: ${msgs}\nRAG chunks: ${chunks}\nDocuments: ${docs}`)
    })
  })
}
