# MERGE_DECISIONS.md

## Source-of-truth decision
The final handoff was normalized around the **Node.js + Fly.io + SQLite** implementation.

### Why
- The fresh GitHub/Fly export was the most complete and coherent runtime.
- It included the actual deploy path (`fly.toml`, `Dockerfile`, `package.json`, bot runtime files).
- Earlier Python/Jarvis materials were useful for ideas and feature comparison, but they represented an alternate runtime rather than the best deployment base.

## What was kept
- Node.js Discord bot runtime
- Fly.io deployment path
- Docker-based deploy model
- SQLite persistence model
- Existing slash-command structure
- Existing grading / parsing architecture, improved incrementally rather than rewritten

## What was treated as reference only
- Older Python/Jarvis bot snapshots
- Experimental/placeholder modules from earlier uploads
- Cross-runtime concepts that were not production-ready to merge directly

## Consolidation strategy
The project was intentionally moved toward:
- one repo
- one runtime
- one deployment target
- one set of repo instructions for Codex

This was done to avoid split-brain maintenance between:
- Python vs Node
- local-only vs Fly deployment
- multiple overlapping bot versions

## Guiding rules used during consolidation
- Do not re-platform.
- Prefer small, additive fixes over broad rewrites.
- Preserve SQLite compatibility.
- Keep Fly configuration, Dockerfile, and runtime behavior aligned.
- Improve reliability first: ingestion, dedupe, grading correctness, validation.

## Result
The repo is now in a much better state for:
- Codex implementation work
- Gemini project planning
- small PR-based iteration
- reliable handoff to future contributors or agents
