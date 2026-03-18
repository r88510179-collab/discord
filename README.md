# BetTracker Discord Bot

Discord bot for logging bets, scanning slips, grading completed wagers, tracking cappers, and posting recap/dashboard updates.

This repo is normalized around the **Node/Fly.io implementation** and prepared for a **Codex handoff**.

## What is in this repo

- One primary runtime: **Node.js 20**
- One deployment path: **Docker + Fly.io**
- One local database path: **SQLite on `/data`**
- One health endpoint for Fly: `GET /healthz`
- One set of Codex instructions: `AGENTS.md`

## Quick start

```bash
npm install
cp .env.example .env
# fill in your keys
npm run deploy
npm start
```

## Commands

- `/bet` — parse natural-language bets
- `/slip` — scan a bet slip image
- `/stats` — show performance stats
- `/leaderboard` — rank cappers
- `/bankroll` — set or view bankroll settings
- `/grade auto` — auto-grade pending bets
- `/grade manual` — manually grade the latest pending bet
- `/track add` — track a Twitter/X account
- `/track list` — show tracked Twitter/X accounts
- `/recap` — generate an AI recap

## Environment

Configure at least one AI provider key:

- `GROQ_API_KEY`
- `GEMINI_API_KEY`
- `MISTRAL_API_KEY`
- `OPENROUTER_API_KEY`

Other important values:

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID` for fast dev command registration
- `ODDS_API_KEY` for auto-grading by scores
- `DB_PATH` defaults to `/data/bettracker.db`
- `PICKS_CHANNEL_IDS` for auto-parse channels
- `DASHBOARD_CHANNEL_ID` for bot event posts
- `TWITTER_CAPPER_MAP` / `CAPPER_CHANNEL_MAP` for fixed attribution

## Local checks

```bash
npm run check
```

This runs syntax checks across the bot files.

## Fly.io deploy

This repo ships with `fly.toml` and `Dockerfile`.

### Why the Fly config was adjusted

The earlier Fly config exposed an HTTP service but the bot did not listen on the configured port. Fly expects `internal_port` to match a real listener, and apps with no `services` or `http_service` are treated as private/internal-only apps.

This repo now includes a lightweight health server in `bot.js` and keeps the machine running by setting `auto_stop_machines = "off"`, since Fly can otherwise stop or suspend machines when idle.

### Volume

SQLite persistence is mounted at `/data` via the `[mounts]` section. Fly mounts require a `source` volume name and a `destination` path.

Create the volume before first deploy if needed:

```bash
fly volumes create bettracker_data --region iad
```

Deploy:

```bash
fly deploy
```

## Codex handoff

OpenAI’s Codex guidance emphasizes a configured repo, reliable run/test commands, and `AGENTS.md` instructions within the repo tree.

This repo includes:

- `AGENTS.md` — repo instructions for Codex
- `TASKS.md` — prioritized backlog
- `docs/MERGE_DECISIONS.md` — what was consolidated and why
- `docs/CODE_REVIEW.md` — issues fixed and issues still open
- `docs/LEGACY_FEATURE_MAP.md` — what came from the older Python/Jarvis material

## Known gaps

- Auto-grading is strongest for sides/totals/moneylines and still limited for props/parlays.
- OCR quality depends on the configured AI provider and the slip quality.
- Twitter/X polling depends on a working bearer token and current API access.
- Supabase migration exists as a scaffold and is not fully productionized.
