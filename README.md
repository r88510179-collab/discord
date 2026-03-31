🎰 ZoneTracker — Discord Sportsbook & Economy
An AI-powered betting hub and virtual sportsbook built natively for Discord. ZoneTracker ingests bet slips via image OCR, routes them for admin approval, allows the community to tail/fade with a virtual bankroll, and autonomously grades the results using Google's Gemini AI.

Uses SQLite (zero-config, lightning fast) with persistent storage on Fly.io.

✨ The ZoneTracker Economy (How it Works)
Submission (Inbox Zero): A capper drops a screenshot of a slip into #submit-picks. The AI reads the sport, odds, and description, deletes the original message to keep the channel clean, and stages it.

The War Room: Admins review the staged bet in #war-room. They can click [Edit] to fix AI typos via a 5-field UI Modal, or [Approve] to push it live.

Skin in the Game: Once live in #bet-dashboard, users can click [🔥 Tail]. A modal asks how many units they want to risk from their virtual 100.00u bankroll.

Autonomous Grading: Every 15 minutes, Gemini 2.0 searches the web for live scores/results for any bet older than 4 hours.

The Payout: When graded (WIN/LOSS/PUSH/VOID), the bot automatically calculates Vegas odds payouts, updates all tailer bankrolls, and posts a Live Ticker receipt.

💻 Commands & UI
User Commands:

!bankroll — View your current virtual unit balance.

!mystats — View your tailing record (W-L-P) and your most profitable capper.

!leaderboard — Ranked capper board sorted by total profit.

Admin Commands:

!status — X-Ray view of the database (total pending bets, breakdown by sport).

!pending — Generates a downloadable .txt file containing the full backlog.

!reset_season — Crowns the monthly top 3 cappers, archives all graded bets, and resets all bankrolls to 100.00u.

⚙️ Setup & Deployment (Fly.io)
1. Discord & API Keys

Create a Bot at discord.com/developers/applications (Enable Message Content Intent).

Get your Google Gemini API Key: aistudio.google.com

Copy your .env.example to .env and insert your keys and Channel IDs (War Room, Dashboard, Submit Picks).

2. Launching Locally

Bash
npm install
npm start
3. Deploying to Fly.io (Production)
ZoneTracker uses SQLite. To ensure data isn't lost when the server restarts, you must use a persistent volume.

Bash
fly volumes create bettracker_data --region iad --size 1
fly deploy
(Ensure your fly.toml includes the [mounts] block pointing /data to bettracker_data).

🧹 Maintenance & Cron Jobs
Daily Recap (8:00 AM): AI-written daily performance recap posted to the dashboard.

90-Day Purge (3:30 AM): Deletes archived bets older than 90 days, cleans orphaned records, and runs VACUUM to prevent database bloat.

🚀 Future Roadmap (Phase 7)
X/Twitter Tracking: Auto-import picks from specific cappers on X.

Supabase Migration: Upscale the SQLite database to a managed Postgres instance via Supabase when the community outgrows the local file.
