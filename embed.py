#!/usr/bin/env python3
"""
scripts/embed.py — Embedding helper called by the Node plugin via execFile.
Usage: python3 embed.py --embed --text "text to embed"
Returns: JSON array of floats on stdout.

Also used by ingest.py directly as a module.
"""

import sys
import json
import argparse

_model = None

def get_model():
    global _model
    if _model is None:
        from fastembed import TextEmbedding
        _model = TextEmbedding(model_name="BAAI/bge-m3")
    return _model

def embed_text(text: str) -> list[float]:
    model = get_model()
    embeddings = list(model.embed([text]))
    return embeddings[0].tolist()

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--embed', action='store_true')
    parser.add_argument('--text', type=str, default='')
    args = parser.parse_args()

    if args.embed:
        result = embed_text(args.text)
        print(json.dumps(result))
    else:
        print("Usage: embed.py --embed --text 'your text'", file=sys.stderr)
        sys.exit(1)
