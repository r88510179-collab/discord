#!/bin/bash
# Apr 16 afternoon verification block
# Run this when at computer. Paste outputs back to Claude.

echo "=== 1. v283 auto-void verification ==="
fly ssh console -a bettracker-discord-bot -C "node -e \"const db=require('better-sqlite3')('/data/bettracker.db'); const v=db.prepare(\\\"SELECT COUNT(*) c FROM bets WHERE review_status='auto_void_unscoped_bet'\\\").get(); const g=db.prepare(\\\"SELECT COUNT(*) c FROM bets WHERE graded_at > datetime('now','-30 minutes')\\\").get(); const s=db.prepare(\\\"SELECT grading_state, COUNT(*) c FROM bets WHERE result='pending' GROUP BY grading_state\\\").all(); console.log('Auto-voided unscoped all-time:', v.c); console.log('Graded last 30min:', g.c); console.log('Pending states:', s);\""

echo ""
echo "=== 2. v283 fired in logs ==="
fly logs -a bettracker-discord-bot --no-tail | grep -iE "Auto-void unscoped" | tail -10

echo ""
echo "=== 3. Current /admin snapshot backend state ==="
fly logs -a bettracker-discord-bot --no-tail | grep -iE "\[Search\]|\[ESPN" | tail -20

echo ""
echo "=== 4. Surface Pro resources ==="
ssh tracker@tracker-surface-pro 'echo "---RAM---"; free -h; echo "---DISK---"; df -h /; echo "---MODELS---"; ollama list; echo "---LOADED---"; ollama ps; echo "---OLLAMA SVC---"; systemctl is-active ollama'

echo ""
echo "=== 5. Surface Pro PM2 + Tailscale ==="
ssh tracker@tracker-surface-pro 'echo "---PM2---"; pm2 status; echo "---TAILSCALE---"; tailscale status | head -5'

echo ""
echo "=== 6. Code Tab prompt templates inventory ==="
ls -la ~/Documents/discord/.code-prompts/ 2>/dev/null || echo "Directory does not exist yet"

echo ""
echo "=== 7. BACKLOG current state ==="
wc -l ~/Documents/discord/docs/BACKLOG.md
git -C ~/Documents/discord log --oneline -5

echo ""
echo "=== 8. Bot version + uptime ==="
fly status -a bettracker-discord-bot | head -15
