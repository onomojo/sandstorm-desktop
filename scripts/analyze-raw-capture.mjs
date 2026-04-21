#!/usr/bin/env node
/**
 * analyze-raw-capture.mjs — summarise a raw-api-capture session dir (#299).
 *
 * Usage:
 *   node scripts/analyze-raw-capture.mjs <path-to-session-dir>
 *
 * A session dir is created under:
 *   <userData>/raw-api-capture/<sessionStartIso>/
 * with one `index.jsonl` and one `NNNN-<tab>-turnN-subM-req.json` per
 * outbound API request.
 *
 * The script answers: "where is the token bloat coming from?" by breaking
 * down each request's body into system-prompt chunks, tools schemas, and
 * messages, then diffing adjacent requests so growth drivers are obvious.
 *
 * Pure Node, no deps. Runs outside the app.
 */

import fs from 'fs';
import path from 'path';

const SKILL_CATALOG_MARKER = 'The following skills are available for use with the Skill tool';

function die(msg) {
  console.error(`analyze-raw-capture: ${msg}`);
  process.exit(1);
}

function byteLen(v) {
  if (v == null) return 0;
  if (typeof v === 'string') return Buffer.byteLength(v, 'utf-8');
  return Buffer.byteLength(JSON.stringify(v), 'utf-8');
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function pad(s, w, right = false) {
  const str = String(s);
  if (str.length >= w) return str.slice(0, w);
  const fill = ' '.repeat(w - str.length);
  return right ? fill + str : str + fill;
}

function deltaStr(n) {
  if (n === 0) return '   0';
  const sign = n > 0 ? '+' : '-';
  return `${sign}${formatBytes(Math.abs(n))}`;
}

function loadDumps(dir) {
  const entries = fs
    .readdirSync(dir)
    .filter((f) => /-req\.json$/.test(f))
    .sort();
  const dumps = [];
  for (const f of entries) {
    const full = path.join(dir, f);
    try {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf-8'));
      dumps.push({ file: f, ...parsed });
    } catch (e) {
      console.warn(`warn: could not parse ${f}: ${e.message}`);
    }
  }
  return dumps;
}

function summarizeBody(body) {
  // Anthropic /v1/messages request shape:
  //   { model, max_tokens, system?: string | Array, messages: [], tools?: [] }
  const out = {
    model: undefined,
    systemChunks: [],
    systemBytes: 0,
    messageCount: 0,
    messagesBytes: 0,
    toolsCount: 0,
    toolsBytes: 0,
    firstUserSnippet: '',
    skillCatalogBytes: 0,
    skillCatalogPresent: false,
  };
  if (!body || typeof body !== 'object') return out;
  out.model = body.model;

  const sys = body.system;
  if (Array.isArray(sys)) {
    for (const entry of sys) {
      const text = typeof entry === 'string' ? entry : entry?.text;
      const bytes = byteLen(text ?? entry);
      out.systemChunks.push({ bytes, head: (text ?? '').slice(0, 80) });
      out.systemBytes += bytes;
      if (typeof text === 'string' && text.includes(SKILL_CATALOG_MARKER)) {
        out.skillCatalogPresent = true;
        out.skillCatalogBytes += bytes;
      }
    }
  } else if (typeof sys === 'string') {
    out.systemChunks.push({ bytes: byteLen(sys), head: sys.slice(0, 80) });
    out.systemBytes = byteLen(sys);
    if (sys.includes(SKILL_CATALOG_MARKER)) {
      out.skillCatalogPresent = true;
      out.skillCatalogBytes = byteLen(sys);
    }
  }

  if (Array.isArray(body.messages)) {
    out.messageCount = body.messages.length;
    out.messagesBytes = byteLen(body.messages);
    const firstUser = body.messages.find((m) => m.role === 'user');
    if (firstUser) {
      const text = extractFirstText(firstUser.content);
      out.firstUserSnippet = text.replace(/\s+/g, ' ').slice(0, 60);
    }
  }

  if (Array.isArray(body.tools)) {
    out.toolsCount = body.tools.length;
    out.toolsBytes = byteLen(body.tools);
  }

  return out;
}

function extractFirstText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    if (typeof block?.text === 'string') return block.text;
  }
  return '';
}

function printTable(rows, columns) {
  const widths = columns.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => String(r[c.key] ?? '').length))
  );
  const header = columns.map((c, i) => pad(c.header, widths[i], c.right)).join(' │ ');
  const sep = widths.map((w) => '─'.repeat(w)).join('─┼─');
  console.log(header);
  console.log(sep);
  for (const r of rows) {
    console.log(
      columns.map((c, i) => pad(r[c.key] ?? '', widths[i], c.right)).join(' │ ')
    );
  }
}

function main() {
  const arg = process.argv[2];
  if (!arg) die('usage: analyze-raw-capture.mjs <session-dir>');
  const dir = path.resolve(arg);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    die(`not a directory: ${dir}`);
  }

  const dumps = loadDumps(dir);
  if (dumps.length === 0) {
    console.log(`(no -req.json files in ${dir})`);
    return;
  }

  const summaries = dumps.map((d) => ({
    seq: d.seq,
    turn: d.turnIndex,
    sub: d.subTurnSeq,
    bodyBytes: d.bodyBytes,
    ...summarizeBody(d.body),
    tabId: d.tabId,
  }));

  console.log(`\n=== Summary (${summaries.length} request${summaries.length === 1 ? '' : 's'}) ===\n`);
  printTable(
    summaries.map((s) => ({
      seq: s.seq,
      turn: s.turn,
      sub: s.sub,
      model: s.model ?? '(n/a)',
      body: formatBytes(s.bodyBytes),
      msgs: s.messageCount,
      tools: s.toolsCount,
      sysChunks: s.systemChunks.length,
      skillCat: s.skillCatalogPresent ? `YES ${formatBytes(s.skillCatalogBytes)}` : '-',
      firstUser: s.firstUserSnippet || '-',
    })),
    [
      { header: 'seq', key: 'seq', right: true },
      { header: 'turn', key: 'turn', right: true },
      { header: 'sub', key: 'sub', right: true },
      { header: 'model', key: 'model' },
      { header: 'body', key: 'body', right: true },
      { header: 'msgs', key: 'msgs', right: true },
      { header: 'tools', key: 'tools', right: true },
      { header: 'sysChunks', key: 'sysChunks', right: true },
      { header: 'skillCatalog', key: 'skillCat' },
      { header: 'firstUser', key: 'firstUser' },
    ]
  );

  console.log('\n=== Per-request system-prompt composition ===\n');
  for (const s of summaries) {
    console.log(`[seq=${s.seq} turn=${s.turn}.${s.sub}] system total=${formatBytes(s.systemBytes)}, ${s.systemChunks.length} chunks`);
    s.systemChunks
      .slice()
      .sort((a, b) => b.bytes - a.bytes)
      .forEach((c, i) => {
        const tag = c.head.includes(SKILL_CATALOG_MARKER) ? '  [SKILL CATALOG]' : '';
        console.log(`    #${i + 1}: ${pad(formatBytes(c.bytes), 8, true)}  ${c.head.replace(/\s+/g, ' ')}${tag}`);
      });
  }

  if (summaries.length > 1) {
    console.log('\n=== Net deltas between adjacent requests ===\n');
    for (let i = 1; i < summaries.length; i++) {
      const a = summaries[i - 1];
      const b = summaries[i];
      const dBody = b.bodyBytes - a.bodyBytes;
      const dSys = b.systemBytes - a.systemBytes;
      const dTools = b.toolsBytes - a.toolsBytes;
      const dMsgs = b.messagesBytes - a.messagesBytes;
      const dMsgCount = b.messageCount - a.messageCount;
      console.log(
        `seq ${pad(a.seq, 3, true)}→${pad(b.seq, 3, true)}  body ${pad(deltaStr(dBody), 10, true)}` +
        `  system ${pad(deltaStr(dSys), 10, true)}` +
        `  tools ${pad(deltaStr(dTools), 10, true)}` +
        `  messages ${pad(deltaStr(dMsgs), 10, true)} (+${dMsgCount} msgs)`
      );
    }
  }

  // Tool-schema inventory — flag additions / removals across turns.
  console.log('\n=== Tool inventory ===\n');
  const toolNamesByReq = dumps.map((d) => {
    const tools = Array.isArray(d.body?.tools) ? d.body.tools : [];
    return tools.map((t) => t?.name ?? '?');
  });
  for (let i = 0; i < toolNamesByReq.length; i++) {
    const cur = toolNamesByReq[i];
    const prev = i > 0 ? toolNamesByReq[i - 1] : null;
    const added = prev ? cur.filter((t) => !prev.includes(t)) : cur;
    const removed = prev ? prev.filter((t) => !cur.includes(t)) : [];
    const tags = [];
    if (added.length) tags.push(`+${added.join(',')}`);
    if (removed.length) tags.push(`-${removed.join(',')}`);
    console.log(`[seq=${dumps[i].seq}] ${cur.length} tools${tags.length ? '  (' + tags.join('; ') + ')' : ''}`);
  }

  // Observations
  console.log('\n=== Observations ===');
  const anyCatalog = summaries.some((s) => s.skillCatalogPresent);
  if (anyCatalog) {
    const totalCatalog = summaries.reduce((acc, s) => acc + s.skillCatalogBytes, 0);
    console.log(`  • Skill catalog system-reminder present in at least one request. Total bytes across captured requests: ${formatBytes(totalCatalog)}.`);
    console.log(`    Consider disabling Claude Code's plugin auto-advertisement if it's not needed.`);
  }
  const maxBody = Math.max(...summaries.map((s) => s.bodyBytes));
  const maxBodyReq = summaries.find((s) => s.bodyBytes === maxBody);
  console.log(`  • Largest request: seq=${maxBodyReq.seq} turn=${maxBodyReq.turn}.${maxBodyReq.sub} at ${formatBytes(maxBody)}.`);
  if (summaries.length > 1) {
    const growth = summaries[summaries.length - 1].bodyBytes - summaries[0].bodyBytes;
    console.log(`  • Growth from first to last request: ${deltaStr(growth)}.`);
  }
  console.log('');
}

main();
