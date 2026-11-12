# AntiGravityClaw 🛡️🦅

**Lean, secure, and private personal AI agent.**

AntiGravityClaw is a locally-hosted AI agent designed for privacy-conscious users who want powerful agentic capabilities without relying on fully cloud-managed solutions. It combines a Telegram interface with an OpenRouter/Gemini backend and a local embedding server for persistent, searchable memory.

## 🚀 Key Features

- **Private Ingestion**: Local Python-based embedding server (BGE-base-en-v1.5) ensures your documents aren't sent to embedding APIs.
- **Hybrid Memory**: Vector-based semantic search + Full-Text Search (BM25) via `sqlite-vec`.
- **Three-Band Context Model**: Sophisticated prompt management using long-term memory, rolling summaries, and recent message history.
- **Telegram Interface**: Interact with your agent from anywhere with multi-channel support.
- **Agentic Tools**: File management, web search, and memory introspection tools.
- **Windows Optimized**: Specifically tuned for Windows paths, Unicode, and CUDA execution.

## 🛠️ Tech Stack

- **Runtime**: Node.js (TypeScript) + tsx
- **Database**: SQLite with `sqlite-vec` extension
- **LLM**: OpenRouter (Primary) / Google Gemini (Fallback)
- **Embeddings**: BGE-base-en-v1.5 (SentenceTransformers) on Python/CUDA
- **AI Framework**: custom agentic loop with tool registry

## 📦 Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/rpcoelho17/AntiGravityClaw.git
   cd AntiGravityClaw
   ```

2. **Install Node.js dependencies**:
   ```bash
   npm install
   ```

3. **Install Python dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure Environment**:
   Copy `.env.example` to `.env` and fill in your API keys and Telegram ID.

5. **Run the local embedding server**:
   ```bash
   python scripts/embed_server.py
   ```

6. **Start the Bot**:
   ```bash
   npm run dev
   ```

## 📜 Documentation

- [User Manual](AntiGravityClaw_UserManual.md)
- [Infinite Memory Specification](OPENCLAW_INFINITE_MEMORY_SPEC_V4.md)

## ⚖️ License

MIT
