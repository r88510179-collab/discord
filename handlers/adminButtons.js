// handlers/adminButtons.js — Button dispatch for /admin pipeline-trace and pipeline-drops-24h
// Mirrors handlers/gradeButtons.js pattern. Owner-only, ephemeral, re-queries DB on click.
//
// CustomId formats (parsed below):
//   admin_trace_file:i:<ingest_id>   — ingest-anchored .txt
//   admin_trace_raw:i:<ingest_id>    — ingest-anchored code-block repost
//   admin_trace_file:b:<full_bet_id> — bet-anchored .txt (UNION render)
//   admin_trace_raw:b:<full_bet_id>  — bet-anchored code-block repost
//   admin_drops_file:<hours>         — drops aggregation .txt
//   admin_drops_raw:<hours>          — drops aggregation code-block repost

const { AttachmentBuilder, MessageFlags } = require('discord.js');
const { renderTraceByIngestId, renderTraceByBet, renderPipelineDrops } = require('../services/pipelineRender');

function safeShortId(s) {
  return String(s || 'trace').slice(0, 16).replace(/[^a-zA-Z0-9_-]/g, '');
}

async function handleAdminButtonInteraction(interaction) {
  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith('admin_')) return;

  // Owner gate — mirrors process.env.OWNER_ID check used across /admin subcommands.
  if (process.env.OWNER_ID && interaction.user.id !== process.env.OWNER_ID) {
    return interaction.reply({ content: '🚫 Owner only.', flags: MessageFlags.Ephemeral });
  }

  const [prefix, ...rest] = interaction.customId.split(':');

  // ── Trace buttons ──
  if (prefix === 'admin_trace_file' || prefix === 'admin_trace_raw') {
    const kind = rest[0]; // 'i' or 'b'
    const key = rest.slice(1).join(':'); // ingest_id may contain underscores; rejoin is safe
    if (!kind || !key) {
      return interaction.reply({ content: '❌ Malformed customId.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ ephemeral: true });

    let rendered;
    try {
      if (kind === 'b') {
        rendered = renderTraceByBet(key);
      } else {
        rendered = renderTraceByIngestId(key);
      }
    } catch (err) {
      return interaction.editReply(`❌ Error querying pipeline_events: \`${err.message}\``);
    }

    if (rendered.eventCount === 0) {
      const hint = kind === 'b' ? ` (bet=${key.slice(0, 8)})` : ` (ingest=${key})`;
      return interaction.editReply(`No pipeline events found${hint}.`);
    }

    const innerText = rendered.headerLine + '\n' + rendered.lines.join('\n');
    const noteLine = rendered.note ? rendered.note + '\n' : '';

    if (prefix === 'admin_trace_file') {
      const shortId = safeShortId(key);
      const iso = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `pipeline-trace-${shortId}-${iso}.txt`;
      const file = new AttachmentBuilder(Buffer.from(innerText, 'utf8'), { name: fileName });
      const summary = `${rendered.eventCount} events, terminal drop: ${rendered.terminalDrop || 'none'}.`;
      return interaction.editReply({ content: noteLine + summary, files: [file] });
    }

    // admin_trace_raw — repost trimmed to first 1990 chars in a code block
    const codeBlock = '```\n' + innerText + '\n```';
    const trimmed = codeBlock.length <= 1990
      ? codeBlock
      : codeBlock.slice(0, 1986) + '\n```';
    return interaction.editReply({ content: noteLine + trimmed });
  }

  // ── Drops buttons ──
  if (prefix === 'admin_drops_file' || prefix === 'admin_drops_raw') {
    const hoursRaw = rest[0];
    const hours = Number(hoursRaw);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
      return interaction.reply({ content: '❌ Malformed customId (bad hours).', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ ephemeral: true });

    let rendered;
    try {
      rendered = renderPipelineDrops(hours);
    } catch (err) {
      return interaction.editReply(`❌ Error querying pipeline_events: \`${err.message}\``);
    }

    if (prefix === 'admin_drops_file') {
      const iso = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `pipeline-drops-${rendered.hours}h-${iso}.txt`;
      const filePlain = rendered.headerLines.join('\n').replace(/\*\*/g, '') + '\n\n' + rendered.tblLines.join('\n');
      const file = new AttachmentBuilder(Buffer.from(filePlain, 'utf8'), { name: fileName });
      const summary = `${rendered.dropCountH}/${rendered.eventCountH} drop events in ${rendered.hours}h window.`;
      return interaction.editReply({ content: summary, files: [file] });
    }

    // admin_drops_raw — repost as code block (header + table)
    const headerBlock = rendered.headerLines.join('\n');
    const tableBlock = '```\n' + rendered.tblLines.join('\n') + '\n```';
    const full = headerBlock + '\n' + tableBlock;
    const trimmed = full.length <= 1990
      ? full
      : (headerBlock + '\n```\n' + rendered.tblLines.join('\n').slice(0, 1990 - headerBlock.length - 10) + '\n```');
    return interaction.editReply({ content: trimmed });
  }

  // Unknown admin button — be permissive (don't reply if someone else handles it).
}

module.exports = { handleAdminButtonInteraction };
