# AGENTS.md

## Project goal
Maintain a single Node.js Discord betting bot that runs locally or on Fly.io.

## Source of truth
- Use this repo as the only active runtime.
- Treat the older Python/Jarvis material as reference only unless a task explicitly ports a feature.

## Commands
- Install: `npm install`
- Syntax check: `npm run check`
- Register commands: `npm run deploy`
- Run bot: `npm start`
- Dev mode: `npm run dev`
- Migration scaffold: `npm run migrate`

## Rules for edits
- Keep the runtime Node.js-based unless explicitly told to re-platform.
- Prefer small focused changes over broad rewrites.
- Preserve SQLite compatibility unless the task explicitly migrates to Supabase.
- Any Fly change must keep `fly.toml`, `Dockerfile`, and runtime port behavior aligned.
- Keep environment variable names documented in `.env.example` and `README.md`.

## Areas that need extra care
- `services/grading.js`: results logic is intentionally simple and can mis-grade complex props/parlays.
- `services/ai.js`: provider routing must fail gracefully when keys are missing.
- `handlers/messageHandler.js`: avoid loops, double-processing, or broad auto-parse triggers.
- `services/database.js`: schema compatibility matters; do additive changes where possible.

## Definition of done
- `npm run check` passes.
- Docs reflect any new environment variables or commands.
- Deployment instructions remain accurate for Fly.io.
