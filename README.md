# 🎰 ZoneTracker — Discord Bot

**AI-powered betting hub** that tracks, analyzes, grades, and ranks bets automatically.
Uses **SQLite** (zero-config, free) — migrates to Supabase when you're ready.

---

## Commands

| Command | What It Does |
|---------|-------------|
| `/bet` | Log bets in natural language — AI parses sport, odds, units |
| `/slip` | Upload a bet slip photo → AI reads it (DraftKings, FanDuel, Hard Rock, etc.) |
| `/stats` | Full analytics — record, win %, ROI, bankroll, recent bets |
| `/leaderboard` | Ranked capper board sorted by profit, ROI, or win % |
| `/bankroll` | Set/view bankroll & unit size with auto P/L tracking |
| `/grade auto` | Auto-grade pending bets using live scores |
| `/grade manual` | Manually grade your latest bet |
| `/track add` | Track a Twitter/X capper — picks auto-imported via AI |
| `/recap` | AI-written daily performance recap |

**Auto-features:** Picks channel auto-detection, auto-grading every 15 min, Twitter polling every 5 min.

---

## Setup (4 Steps)

### 1. Create a Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **"New Application"** → name it (e.g. `ZoneTracker`)
3. **Bot** tab → click **"Reset Token"** → copy it → this is your `DISCORD_TOKEN`
4. Same page → enable **Message Content Intent**
5. **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Permissions: Send Messages, Embed Links, Attach Files, Read Message History, Add Reactions, Use Slash Commands
6. Copy generated URL → open in browser → add to your server

Your **Client ID** is on the **General Information** page.

### 2. Get API Keys

| Service | Link | Notes |
|---------|------|-------|
| **Anthropic** | [console.anthropic.com](https://console.anthropic.com) | Powers all AI features |
| **The Odds API** | [the-odds-api.com](https://the-odds-api.com) | 500 free requests/month |
| **Twitter/X** *(optional)* | [developer.x.com](https://developer.x.com) | Only if tracking cappers |

### 3. Configure

```bash
cd bettracker-discord
npm install

cp .env.example .env
# Edit .env with your keys
```

**To get your Server/Channel IDs:** Discord Settings → Advanced → Developer Mode ON, then right-click → Copy ID.

### 4. Launch

```bash
npm run deploy   # Register slash commands
npm run check    # Validate key runtime files
npm start        # Start the bot
```

---

## Auto-Parse: Picks Channel

Set `PICKS_CHANNEL_ID` in `.env`. Any message in that channel that looks like a bet gets auto-detected and logged. The bot needs 2+ signals to trigger (odds pattern, unit notation, pick keywords, bet type keywords, capper emojis like 🔒🔥💰).

---

## Migrating to Supabase (Later)

When ZoneTracker is ready:

1. `npm install @supabase/supabase-js`
2. Add `SUPABASE_URL` and `SUPABASE_KEY` to `.env`
3. Run `supabase-setup.sql` in Supabase SQL Editor
4. `npm run migrate` — copies all SQLite data to Supabase
5. Swap `services/database.js` to the Supabase version

Your SQLite file stays intact as a backup.

---

## Hosting

| Option | Cost | Notes |
|--------|------|-------|
| **Your Mac** | Free | Just keep terminal open |
| **Railway.app** | ~$5/mo | Easiest cloud deploy |
| **Render.com** | Free tier | Good budget option |
| **VPS** | $4-6/mo | Full control |

---

## Project Structure

```
bettracker-discord/
├── bot.js                    # Entry point — client, cron jobs
├── deploy-commands.js        # Register slash commands
├── migrate-to-supabase.js    # Future migration script
├── bettracker.db             # SQLite database (auto-created)
├── commands/
│   ├── bet.js                # /bet — natural language logging
│   ├── slip.js               # /slip — bet slip OCR
│   ├── stats.js              # /stats — analytics
│   ├── leaderboard.js        # /leaderboard — rankings
│   ├── bankroll.js           # /bankroll — bankroll mgmt
│   ├── grade.js              # /grade — auto & manual
│   ├── track.js              # /track — Twitter tracking
│   └── recap.js              # /recap — AI daily summary
├── services/
│   ├── database.js           # SQLite layer (all data ops)
│   ├── ai.js                 # Claude AI — parsing, OCR, grading
│   ├── grading.js            # Auto-grade engine + Odds API
│   └── twitter.js            # Twitter polling + pick detection
├── handlers/
│   └── messageHandler.js     # Auto-parse picks channel
└── utils/
    └── embeds.js             # Discord embed formatting
```
