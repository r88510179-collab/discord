# Repo Edit & Deploy Workflows

How each repo is edited and shipped. Rule: no hand-editing — every change goes
through the Code tab on a Mac clone (agent opens a PR / commits and stops; Smokke
merges/deploys manually). Code-tab prompt files live in
`~/Documents/discord/prompts/`. See PREFLIGHT.md for prompt conventions.

## discord  (main bot — bettracker-discord-bot on Fly)
- Mac clone: `~/Documents/discord`  (remote: r88510179-collab/discord)
- Edit: Code tab on the Mac clone. Agent opens a PR and STOPS.
- Merge: manual, after CI is green (branch protection on `main`).
- Deploy: MANUAL — Fly does NOT auto-deploy.
    `fly deploy --local-only --yes --no-cache -a bettracker-discord-bot`
    (`--no-cache` always)
- Verify: docs/DEPLOY_CHECKLIST.md (all 8 steps).

## zonetracker-scraper  (Twitter scraper — Surface Pro, PM2)
- Mac clone: `~/Desktop/zonetracker-scraper`  (remote: r88510179-collab/zonetracker-scraper)
- Runtime: Surface Pro `/home/tracker/zonetracker-scraper`,
  PM2 process `zonetracker-scraper` (fork mode; watch&reload OFF).
- Edit: Code tab on the Mac clone -> commit + push.
- Deploy: on Surface Pro ->
    `cd ~/zonetracker-scraper && git pull && pm2 restart zonetracker-scraper`
  No build step. Restart is REQUIRED (watch&reload off) to load changes.

## zonetracker-dubclub  (DubClub email->Discord bridge — Surface Pro, PM2)   [VERIFY paths]
- Mac clone: `~/Documents/zonetracker-dubclub`  (remote: r88510179-collab/zonetracker-dubclub)
- Runtime: Surface Pro `~/zonetracker-dubclub`, PM2.
