#!/usr/bin/env python3
"""
scripts/ingest.py — Document ingestion pipeline.
Usage: python3 ingest.py <file_path> <collection_name>

Processes a file using LangChain SemanticChunker (meaning-based splits),
generates BGE-M3 embeddings for each chunk, and writes to memory.db.

Run on-demand via Node child_process — never as a daemon.
"""

import sys
import os
import json
import sqlite3
import struct
import argparse
from pathlib import Path

# ── WORKSPACE RESOLUTION ──────────────────────────────────────────────────────

WORKSPACE = os.environ.get(
    'OPENCLAW_WORKSPACE',
    os.path.join(os.path.expanduser('~'), '.openclaw/workspace')
)
DB_PATH = os.path.join(WORKSPACE, 'memory.db')
COLLECTIONS_PATH = os.path.join(WORKSPACE, 'collections')


# ── EMBEDDING ─────────────────────────────────────────────────────────────────

def get_embedder():
    from fastembed import TextEmbedding
    return TextEmbedding(model_name="BAAI/bge-m3")


def embed_texts(texts: list[str], embedder) -> list[list[float]]:
    """Embed a list of texts, returning list of float arrays."""
    embeddings = list(embedder.embed(texts))
    return [e.tolist() for e in embeddings]


def floats_to_blob(floats: list[float]) -> bytes:
    """Pack float list into binary blob for sqlite-vec."""
    return struct.pack(f'{len(floats)}f', *floats)


# ── CHUNKING ──────────────────────────────────────────────────────────────────

def chunk_text(text: str, embedder) -> list[str]:
    """
    Use LangChain SemanticChunker to split text at natural topic boundaries.
    Falls back to fixed-size chunking if LangChain is unavailable.
    """
    try:
        from langchain_experimental.text_splitter import SemanticChunker
        from langchain_community.embeddings import FasembedEmbeddings

        lc_embeddings = FasembedEmbeddings(model_name="BAAI/bge-m3")
        chunker = SemanticChunker(
            lc_embeddings,
            breakpoint_threshold_type="percentile",
            breakpoint_threshold_amount=95
        )
        docs = chunker.create_documents([text])
        chunks = [d.page_content for d in docs if d.page_content.strip()]
        print(f"[ingest] SemanticChunker produced {len(chunks)} chunks", file=sys.stderr)
        return chunks
    except ImportError:
        print("[ingest] langchain-experimental not found, using fixed-size chunking", file=sys.stderr)
        return fixed_chunk(text)


def fixed_chunk(text: str, size: int = 1500, overlap: int = 200) -> list[str]:
    """Fallback: fixed character-based chunking with overlap."""
    chunks = []
    start = 0
    while start < len(text):
        end = start + size
        chunks.append(text[start:end])
        start = end - overlap
    return [c.strip() for c in chunks if c.strip()]


# ── FILE READING ──────────────────────────────────────────────────────────────

def read_file(file_path: str) -> str:
    """Extract text from PDF, DOCX, or plain text files."""
    ext = Path(file_path).suffix.lower()

    if ext == '.pdf':
        try:
            import pdfplumber
            with pdfplumber.open(file_path) as pdf:
                return '\n\n'.join(
                    page.extract_text() or ''
                    for page in pdf.pages
                )
        except ImportError:
            print("[ingest] pdfplumber not installed, trying pypdf2", file=sys.stderr)
            import pypdf
            reader = pypdf.PdfReader(file_path)
            return '\n\n'.join(page.extract_text() or '' for page in reader.pages)

    elif ext in ('.docx', '.doc'):
        import docx
        doc = docx.Document(file_path)
        return '\n\n'.join(p.text for p in doc.paragraphs if p.text.strip())

    else:
        # Plain text, markdown, code, etc.
        with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
            return f.read()


# ── DATABASE ──────────────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")

    # Load sqlite-vec extension
    vec_paths = [
        '/usr/local/lib/vec0.so',
        '/usr/lib/sqlite3/vec0.so',
        os.path.join(os.path.expanduser('~'), '.local/lib/vec0.so'),
    ]
    for p in vec_paths:
        if os.path.exists(p):
            conn.enable_load_extension(True)
            conn.load_extension(p)
            break

    return conn


# ── INGESTION PIPELINE ────────────────────────────────────────────────────────

def ingest(file_path: str, collection: str) -> None:
    print(f"[ingest] Processing: {file_path} → collection: {collection}", file=sys.stderr)

    # Copy file to collections folder
    os.makedirs(os.path.join(COLLECTIONS_PATH, collection), exist_ok=True)
    filename = Path(file_path).name
    dest_path = os.path.join(COLLECTIONS_PATH, collection, filename)
    if file_path != dest_path:
        import shutil
        shutil.copy2(file_path, dest_path)

    # Relative path for portability
    rel_path = os.path.relpath(
        os.path.join(COLLECTIONS_PATH, collection),
        WORKSPACE
    ) + '/'

    # Extract text
    text = read_file(file_path)
    if not text.strip():
        print(f"[ingest] Warning: no text extracted from {file_path}", file=sys.stderr)
        return

    # Initialize embedder
    embedder = get_embedder()

    # Chunk text
    chunks = chunk_text(text, embedder)
    if not chunks:
        print("[ingest] Warning: no chunks produced", file=sys.stderr)
        return

    print(f"[ingest] Embedding {len(chunks)} chunks...", file=sys.stderr)

    # Generate embeddings in batch
    embeddings = embed_texts(chunks, embedder)

    # Write to database
    conn = get_db()
    try:
        with conn:
            # Register document
            cursor = conn.execute(
                """INSERT INTO documents (name, collection, file_path, chunk_count)
                   VALUES (?, ?, ?, ?)""",
                (filename, collection, rel_path, len(chunks))
            )
            doc_id = cursor.lastrowid

            # Insert chunks and embeddings
            for chunk_text_val, embedding in zip(chunks, embeddings):
                cursor = conn.execute(
                    """INSERT INTO memory (type, channel, doc_id, chunk_text)
                       VALUES ('R', '__rag__', ?, ?)""",
                    (doc_id, chunk_text_val)
                )
                memory_id = cursor.lastrowid

                blob = floats_to_blob(embedding)
                conn.execute(
                    "INSERT INTO memory_embeddings (rowid, embedding) VALUES (?, ?)",
                    (memory_id, blob)
                )

        print(f"[ingest] Done. {len(chunks)} chunks stored for doc_id={doc_id}", file=sys.stderr)
        print(json.dumps({"status": "ok", "doc_id": doc_id, "chunks": len(chunks)}))

    except Exception as e:
        print(f"[ingest] Database error: {e}", file=sys.stderr)
        raise
    finally:
        conn.close()


# ── ENTRY POINT ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Ingest a file into memory.db')
    parser.add_argument('file_path', help='Path to the file to ingest')
    parser.add_argument('collection', help='Collection name')
    args = parser.parse_args()

    if not os.path.exists(args.file_path):
        print(f"[ingest] Error: file not found: {args.file_path}", file=sys.stderr)
        sys.exit(1)

    ingest(args.file_path, args.collection)
