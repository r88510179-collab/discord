// services/pipelineRender.js — shared rendering for /admin pipeline-trace and pipeline-drops
// Used by commands/admin.js (slash) and handlers/adminButtons.js (button regen) so
// click-to-rerender yields identical output to the original slash response.

const fmtTime = (ts) => {
  const d = new Date(Number(ts) * 1000);
  if (isNaN(d.getTime())) return '????-??-?? ??:??:??';
  return d.toISOString().replace('T', ' ').slice(0, 19);
};
const fmtHms = (ts) => fmtTime(ts).slice(11);
const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');

function renderTraceLines(rows, { ingestId, betId }) {
  if (rows.length === 0) {
    return { headerLine: null, lines: [], eventCount: 0, terminalDrop: null };
  }

  const head = rows[0];
  const sourceDesc = head.source_type === 'twitter' && head.source_ref
    ? `twitter / tweet=${head.source_ref}`
    : head.source_type === 'discord' && head.source_ref
      ? `discord / msg=${head.source_ref}`
      : `${head.source_type || '?'} / ${head.source_ref || '-'}`;

  let headerLine;
  if (betId) {
    const ingPart = ingestId || '(none — bet has no source_message_id)';
    headerLine = `bet=${betId.slice(0, 8)} ingest=${ingPart} (${sourceDesc} / first=${fmtTime(head.created_at)})`;
  } else {
    headerLine = `${ingestId} (${sourceDesc} / ${fmtTime(head.created_at)})`;
  }

  const lines = [];
  let terminalDrop = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const isLast = i === rows.length - 1;
    const prefix = isLast ? '└─' : '├─';
    let label = r.stage;
    if (r.event_type === 'DROP' || r.stage === 'DROPPED') {
      label = `DROPPED (reason=${r.drop_reason || 'UNKNOWN'})`;
      terminalDrop = r.drop_reason || 'UNKNOWN';
    } else if (r.event_type === 'ERROR') {
      label = 'ERROR';
    } else {
      terminalDrop = null;
    }
    let payloadStr = '';
    if (r.payload) {
      try {
        const p = JSON.parse(r.payload);
        payloadStr = ` payload=${JSON.stringify(p).slice(0, 180)}`;
      } catch (_) {
        payloadStr = ` payload=${String(r.payload).slice(0, 180)}`;
      }
    }
    const betStr = r.bet_id ? ` bet=${r.bet_id.slice(0, 8)}` : '';
    lines.push(`${prefix} ${fmtHms(r.created_at)} ${label}${betStr}${payloadStr}`);
  }

  return { headerLine, lines, eventCount: rows.length, terminalDrop };
}

// Strict ingest-id-only query — preserves legacy /admin pipeline-trace happy path.
function renderTraceByIngestId(ingestId) {
  const { db } = require('./database');
  const rows = db.prepare(`
    SELECT ingest_id, bet_id, source_type, source_ref, stage, event_type, drop_reason, payload, created_at, id
    FROM pipeline_events
    WHERE ingest_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(ingestId);
  return renderTraceLines(rows, { ingestId, betId: null });
}

// Bet-anchored UNION query — ingest-side events (ingest_id) + grading-side events (bet_id).
// Spec text 23: ingest-side events have bet_id NULL; grading-side events have ingest_id NULL.
// If bet has no source_message_id, fall through to grading-side-only (bet_id) query.
function renderTraceByBet(fullBetId) {
  const { db } = require('./database');
  const bet = db.prepare('SELECT id, source_message_id, source FROM bets WHERE id = ?').get(fullBetId);
  if (!bet) {
    return { headerLine: null, lines: [], eventCount: 0, terminalDrop: null, note: `Bet \`${fullBetId.slice(0, 8)}\` not found.` };
  }

  let rows;
  let ingestId = null;
  let note = null;
  if (bet.source_message_id) {
    ingestId = `disc_${bet.source_message_id}`;
    rows = db.prepare(`
      SELECT ingest_id, bet_id, source_type, source_ref, stage, event_type, drop_reason, payload, created_at, id
      FROM pipeline_events
      WHERE ingest_id = ? OR bet_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(ingestId, fullBetId);
  } else {
    rows = db.prepare(`
      SELECT ingest_id, bet_id, source_type, source_ref, stage, event_type, drop_reason, payload, created_at, id
      FROM pipeline_events
      WHERE bet_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(fullBetId);
    note = `⚠️ Bet has no \`source_message_id\` — showing grading-side events only.`;
  }

  const rendered = renderTraceLines(rows, { ingestId, betId: fullBetId });
  rendered.note = note;
  rendered.ingestId = ingestId;
  rendered.betId = fullBetId;
  return rendered;
}

// Pipeline drops aggregation — hours window + 7d reference (omitted when hours=168).
function renderPipelineDrops(hoursRaw) {
  const { db } = require('./database');
  const hours = Math.max(1, Math.min(168, Number(hoursRaw) || 24));
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoffH = nowSec - hours * 3600;
  const cutoff7d = nowSec - 168 * 3600;
  const showSecondary = hours !== 168;

  const totalH = db.prepare('SELECT COUNT(*) AS n FROM pipeline_events WHERE created_at >= ?').get(cutoffH)?.n || 0;
  const total7d = showSecondary
    ? (db.prepare('SELECT COUNT(*) AS n FROM pipeline_events WHERE created_at >= ?').get(cutoff7d)?.n || 0)
    : totalH;

  const dropRowsH = db.prepare(`
    SELECT drop_reason, COUNT(*) AS n FROM pipeline_events
    WHERE event_type = 'DROP' AND drop_reason IS NOT NULL AND created_at >= ?
    GROUP BY drop_reason
  `).all(cutoffH);
  const dropRows7d = showSecondary
    ? db.prepare(`
        SELECT drop_reason, COUNT(*) AS n FROM pipeline_events
        WHERE event_type = 'DROP' AND drop_reason IS NOT NULL AND created_at >= ?
        GROUP BY drop_reason
      `).all(cutoff7d)
    : dropRowsH;

  const dropsTotalH = dropRowsH.reduce((s, r) => s + r.n, 0);
  const dropsTotal7d = dropRows7d.reduce((s, r) => s + r.n, 0);

  const reasons = {};
  for (const r of dropRowsH) {
    if (!reasons[r.drop_reason]) reasons[r.drop_reason] = { h: 0, w: 0 };
    reasons[r.drop_reason].h = r.n;
  }
  for (const r of dropRows7d) {
    if (!reasons[r.drop_reason]) reasons[r.drop_reason] = { h: 0, w: 0 };
    reasons[r.drop_reason].w = r.n;
  }
  const sorted = Object.entries(reasons).sort(([a, ca], [b, cb]) => (cb.h - ca.h) || (cb.w - ca.w) || a.localeCompare(b));

  const pct = (n, t) => t > 0 ? `${((n / t) * 100).toFixed(1)}%` : '—';
  const hLabel = `${hours}h`;

  const headerLines = [];
  if (showSecondary) {
    headerLines.push(`**Pipeline drops — last ${hLabel} (vs 7d reference)**`);
    headerLines.push(`${hLabel.padEnd(3)} total events: ${fmtNum(totalH)} | drops: ${fmtNum(dropsTotalH)} (${pct(dropsTotalH, totalH)})`);
    headerLines.push(`7d  total events: ${fmtNum(total7d)} | drops: ${fmtNum(dropsTotal7d)} (${pct(dropsTotal7d, total7d)})`);
  } else {
    headerLines.push(`**Pipeline drops — last 7d**`);
    headerLines.push(`7d total events: ${fmtNum(total7d)} | drops: ${fmtNum(dropsTotal7d)} (${pct(dropsTotal7d, total7d)})`);
  }

  const reasonColWidth = 34;
  const numCol = 6;
  const tblLines = [];
  if (showSecondary) {
    tblLines.push(`${'DROP_REASON'.padEnd(reasonColWidth)}  ${hLabel.padStart(numCol)}  ${'7d'.padStart(numCol)}`);
    for (const [reason, c] of sorted) {
      const r = reason.length > reasonColWidth ? reason.slice(0, reasonColWidth - 1) + '…' : reason.padEnd(reasonColWidth);
      tblLines.push(`${r}  ${fmtNum(c.h).padStart(numCol)}  ${fmtNum(c.w).padStart(numCol)}`);
    }
  } else {
    tblLines.push(`${'DROP_REASON'.padEnd(reasonColWidth)}  ${hLabel.padStart(numCol)}`);
    for (const [reason, c] of sorted) {
      const r = reason.length > reasonColWidth ? reason.slice(0, reasonColWidth - 1) + '…' : reason.padEnd(reasonColWidth);
      tblLines.push(`${r}  ${fmtNum(c.h).padStart(numCol)}`);
    }
  }
  if (sorted.length === 0) tblLines.push('(no drops in window)');

  return {
    hours,
    showSecondary,
    headerLines,
    tblLines,
    eventCountH: totalH,
    eventCount7d: total7d,
    dropCountH: dropsTotalH,
    dropCount7d: dropsTotal7d,
  };
}

module.exports = {
  renderTraceByIngestId,
  renderTraceByBet,
  renderPipelineDrops,
};
