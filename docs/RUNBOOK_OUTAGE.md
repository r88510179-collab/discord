# Runbook: Bot Outage Diagnosis

When the bot appears down — buttons fail, slash commands time out, no recent log activity, or "This interaction failed" in Discord — work through this runbook **before** deploying code, rotating tokens, or restarting machines. Most "outages" are upstream and resolve on their own; the wrong action wastes 30+ minutes and can mask the real cause.

## Decision tree

```
Symptom: "buttons broken" / "interaction failed" / "/health quick" hangs
  │
  ├─ Step 1: Is the bot machine running?
  │     └─ fly status -a bettracker-discord-bot
  │
  ├─ Step 2: Is Discord up for everyone?
  │     └─ curl https://discord.com/api/v10/gateway/bot
  │
  ├─ Step 3: Is Discord up for Fly's iad IPs?
  │     └─ Spin a temp curl machine in iad (see below)
  │
  ├─ Step 4: Is the bot's WebSocket gateway connected?
  │     └─ grep recent logs for processing activity
  │
  └─ Step 5: Is the handler firing on click?
        └─ Click button, grep logs at click time
```

Each step rules out one class of failure. Don't skip ahead.

## Step 1 — Is the machine running?

```
fly status -a bettracker-discord-bot
```

- `STATE: started` → continue to Step 2
- `STATE: stopped` → start it: `fly machine start <id> -a bettracker-discord-bot`
- `STATE: started` but `LAST UPDATED` minutes ago in a tight loop → crash loop. Check logs for the error:
  ```
  fly logs -a bettracker-discord-bot --no-tail 2>&1 | tail -50
  ```

If logs show repeating `HTTPError: Service Unavailable` on `/api/v10/gateway/bot` — that's a Cloudflare/Discord block. Continue to Step 2.

## Step 2 — Is Discord up for everyone?

```
curl -s -o /dev/null -w "gateway/bot: %{http_code}\n" https://discord.com/api/v10/gateway/bot
curl -s -o /dev/null -w "gateway:     %{http_code}\n" https://discord.com/api/v10/gateway
curl -s -o /dev/null -w "users/@me:   %{http_code}\n" -H "Authorization: Bot fake" https://discord.com/api/v10/users/@me
curl -s -o /dev/null -w "discord.com: %{http_code}\n" https://discord.com/
```

Expected when healthy: `401, 200, 401, 200`.

When the **authenticated bot endpoints** (gateway/bot, users/@me) return 503 but the public endpoints (gateway, discord.com) return 200, that is a **partial Discord outage**. Discord's status page often does not reflect this — it has happened twice on 2026-05-08 alone, both times unmarked on discordstatus.com.

Pattern observed: 503s come from Cloudflare's edge (`server: cloudflare`, `cf-ray:` header present), not Discord origin. Verify with:

```
curl -sv -H "Authorization: Bot fake" https://discord.com/api/v10/gateway/bot 2>&1 | grep -iE "^< HTTP|^< server:|^< cf-"
```

If the source is Cloudflare, **wait it out**. Typical recovery: 5–30 min. Do not deploy, do not rotate the token, do not destroy machines.

While waiting, run a polling monitor:

```
while true; do
  code=$(curl -s -o /dev/null -w "%{http_code}" https://discord.com/api/v10/gateway/bot)
  echo "$(date '+%H:%M:%S') gateway/bot: $code"
  sleep 30
done
```

When 401s sustain for 5+ consecutive minutes, the outage is over.

## Step 3 — Is Discord up for Fly's iad IPs specifically?

A 401 from your Mac does not prove the bot machine sees the same. Cloudflare's edge selection means your laptop (Miami edge) and Fly iad (Ashburn edge) hit different POPs. To test from inside Fly's network without restarting the bot:

```
fly machine run --rm -a bettracker-discord-bot --region iad alpine/curl:latest -- sh -c 'while true; do code=$(curl -s -o /dev/null -w "%{http_code}" https://discord.com/api/v10/gateway/bot); echo "$(date +%H:%M:%S) iad: $code"; sleep 30; done'
```

This spins a tiny throwaway VM in iad that polls Discord every 30s. Watch its logs:

```
fly logs -a bettracker-discord-bot --no-tail 2>&1 | grep "<temp_machine_id>" | tail -10
```

When `iad: 401` sustains for 5+ minutes, Cloudflare is no longer blocking Fly. Destroy the temp machine:

```
fly machine destroy <temp_machine_id> -a bettracker-discord-bot --force
```

Then restart the real bot if needed.

## Step 4 — Is the bot's WebSocket gateway connected?

Sometimes the HTTP login succeeds but the WebSocket connection doesn't establish, or breaks silently after partial outages. The bot stays up, eats CPU, but never receives gateway events. Discord interactions silently fail.

Test by looking for **recent activity in logs that requires a live gateway**: AI grading cycles, tweet ingestion, command handlers firing.

```
fly logs -a bettracker-discord-bot --no-tail 2>&1 | grep "<machine_id>" | tail -30
```

Healthy signs (any of these means gateway is up):
- `[AI Grader] Parlay leg ...`
- `[TwitterHandler] Processing ... tweet(s)`
- `[API] Mobile ingest received` followed by `staged 1`
- `[Migrator] Schema is up to date` followed by *any* later activity

Hung-login signature (gateway never connected):
- Logs end at `[SYSTEM] Health check server listening on 0.0.0.0:8080`
- No HTTPError, no Bot is ready, just silence
- Process is up but Discord shows the bot offline

If hung, force a clean restart:

```
fly machine stop <id> -a bettracker-discord-bot
sleep 15
fly machine start <id> -a bettracker-discord-bot
sleep 30
fly logs -a bettracker-discord-bot --no-tail 2>&1 | grep -iE "Bot is ready|HTTPError" | tail -5
```

## Step 5 — Is the handler firing on click?

If the bot is genuinely up (Step 4 confirms gateway), test whether the **interaction itself** is broken:

```
date -u "+%H:%M:%S"
```

Note the time. Click an approve or reject button in war-room. Wait 5 seconds. Then:

```
fly logs -a bettracker-discord-bot --no-tail 2>&1 | grep "<machine_id>" | grep -iE "war_|interaction|button|approve|reject|TypeError" | tail -20
```

Three outcomes:
- **Logs show a stack trace at click time** → real handler bug. Triage.
- **Logs show the handler firing but no error** → it's running but Discord didn't get the ACK in 3s. Slow handler. Check for blocking I/O.
- **Logs show nothing at click time** → gateway dropped the interaction. Restart the bot per Step 4.

## Lessons learned (2026-05-08)

1. **Two Discord outages today were unmarked on discordstatus.com.** Don't trust the status page as the only signal.
2. **Cloudflare's response from Fly iad and from your Mac can differ for ~5–10 minutes during partial recovery.** Always check from inside Fly before declaring recovery.
3. **`fly logs --no-tail | tail -N` is unreliable during crash loops.** The buffer fills with restart noise and pushes real signal off-screen. Filter by machine ID and look for activity-based signals (AI calls, tweet processing) rather than waiting for "Bot is ready" which scrolls away.
4. **`HTTPError 503 on /api/v10/gateway/bot` is upstream until proven otherwise.** Token rotation, code deploys, and machine destroy are all wrong responses.
5. **A bot running but with a dead WebSocket gateway looks identical to a bot processing tweets but failing on Discord interactions.** Step 4's log-based gateway check distinguishes them.
6. **Volumes pin machines to a region.** `fly machine clone --region <other>` will fail. If we ever need a region change for IP-block reasons, plan a volume migration first.

## What NOT to do during an apparent outage

- Do not deploy code. The crash loop will continue.
- Do not rotate `DISCORD_TOKEN`. Could mask root cause.
- Do not `fly machine destroy` the bot machine. Loses state, doesn't change IP block.
- Do not run `fly deploy`. Builds a new image and re-encounters the same upstream block.
- Do not panic-restart in a tight loop. After 10 failed restarts Fly stops auto-restarting; you have to manually intervene anyway.

## Recovery checklist (post-outage)

After Discord/Cloudflare recovers and bot is back online:

1. `/health quick` — confirm bot self-reports healthy
2. Click an approve and a reject button in war-room — verify interaction handlers
3. Check `fly logs` for any unflushed errors during the outage that need separate triage
4. Note the outage start/end times for the BACKLOG if it's the first occurrence of a new pattern
