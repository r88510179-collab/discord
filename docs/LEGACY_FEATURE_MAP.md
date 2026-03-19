# LEGACY_FEATURE_MAP.md

## Purpose
This file maps useful concepts from prior Jarvis and Python materials into the current Node/Fly/SQLite project context.

## Legacy areas that influenced the current direction
- broader sportsbook and betting-domain intent
- richer grading ambitions
- OCR and slip-reading workflow concepts
- sports-specific matching ideas
- automation-oriented bot behavior
- stronger planning around future analytics

## What carried over conceptually
### 1. Betting ingestion as a first-class workflow
Earlier materials emphasized that message ingestion, slip parsing, and pick tracking are central.
That idea remains core in the current Node bot.

### 2. Reliability before feature sprawl
The legacy snapshots had many feature ideas but uneven production readiness.
The consolidated repo intentionally prioritized reliability and validation first.

### 3. Future analytics potential
The older materials suggested expansion toward:
- better capper analytics
- richer grading logic
- model-assisted classification and parsing
- more automated reporting

Those remain viable future roadmap items, not immediate merge targets.

## What was not ported directly
- Python runtime and module layout
- placeholder or incomplete admin code
- any cross-runtime duplication that would make the repo harder to maintain
- experimental grading or ML concepts without validation

## How to use legacy material going forward
Use earlier Jarvis and Python ideas only as:
- reference for feature ideas
- comparison material for missing functionality
- planning input for future roadmap discussions

Do not use them as an alternate source of truth for the active app unless a specific feature is intentionally ported in a scoped PR.
