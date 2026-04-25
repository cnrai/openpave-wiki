#!/usr/bin/env node
/**
 * openpave-wiki - LLM-maintained wiki over PAVE session history
 *
 * Filesystem layout:
 *   ~/.pave/state/session/<sid>.json        session metadata
 *   ~/.pave/state/message/<sid>/<mid>.json  messages
 *   ~/.pave/state/part/<sid>/<mid>/<pid>.json  parts
 *   ~/.pave/wiki/                           markdown wiki (managed by LLM)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.HOME || os.homedir();
const STATE = path.join(HOME, '.pave', 'state');
const WIKI = path.join(HOME, '.pave', 'wiki');
const SESSION_DIR = path.join(STATE, 'session');
const MESSAGE_DIR = path.join(STATE, 'message');
const PART_DIR = path.join(STATE, 'part');
const LOG_PATH = path.join(WIKI, 'log.md');

// ---------- arg parsing ----------
// Options that always take a string value, even if it starts with '-'
const VALUE_OPTIONS = new Set([
  'content', 'content-file', 'path', 'limit', 'since', 'dir',
  'max-chars', 'category', 'kind', 'summary', 'session'
]);

function parseArgs(argv) {
  const out = { command: null, positional: [], options: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) { out.options[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined) { out.options[key] = true; continue; }
      if (VALUE_OPTIONS.has(key)) { out.options[key] = next; i++; continue; }
      if (!next.startsWith('-')) { out.options[key] = next; i++; continue; }
      out.options[key] = true;
    } else if (a.startsWith('-') && a.length > 1 && !/^-?\d/.test(a)) {
      out.options[a.slice(1)] = true;
    } else {
      if (out.command === null) out.command = a;
      else out.positional.push(a);
    }
  }
  return out;
}

// ---------- helpers ----------
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function lsSafe(p) { try { return fs.readdirSync(p); } catch { return []; } }
function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

function emit(s) { console.log(s); }
function err(s) { (console.error || console.log)(s); }

function output(args, data, fallbackText) {
  if (args.options.json) emit(JSON.stringify(data, null, 2));
  else emit(fallbackText);
}

function fail(msg, code = 1) { err(`error: ${msg}`); process.exit(code); }

function loadProcessedIds() {
  const log = safeRead(LOG_PATH) || '';
  const ids = new Set();
  // matches "ses_id" tokens of ULID-like 26-char base32 - PAVE uses ULIDs
  const re = /\b(0[0-9A-HJKMNP-TV-Z]{25})\b/g;
  let m;
  while ((m = re.exec(log)) !== null) ids.add(m[1]);
  return ids;
}

// ---------- commands ----------

function cmdListSessions(args) {
  const limit = parseInt(args.options.limit || '50', 10);
  const since = args.options.since ? Date.parse(args.options.since) : null;
  const dirFilter = args.options.dir;
  const onlyUnprocessed = !!args.options.unprocessed;
  const processed = onlyUnprocessed ? loadProcessedIds() : null;

  const files = lsSafe(SESSION_DIR).filter(f => f.endsWith('.json'));
  const rows = [];
  for (const f of files) {
    let s;
    try { s = readJSON(path.join(SESSION_DIR, f)); } catch { continue; }
    if (since && (s.time?.updated || 0) < since) continue;
    if (dirFilter && !(s.directory || '').includes(dirFilter)) continue;
    if (processed && processed.has(s.id)) continue;
    rows.push({
      id: s.id,
      title: s.title || '(untitled)',
      directory: s.directory,
      created: s.time?.created,
      updated: s.time?.updated,
      compactedInPlace: !!s.compactedInPlace
    });
  }
  rows.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const top = rows.slice(0, limit);
  const text = top.map(r =>
    `${r.id}  ${isoDate(r.updated || r.created || 0)}  ${(r.title || '').slice(0, 60).padEnd(60)}  ${r.directory || ''}`
  ).join('\n');
  output(args, { count: top.length, total: rows.length, sessions: top }, text);
}

function loadSessionData(sid, opts = {}) {
  const sessionFile = path.join(SESSION_DIR, `${sid}.json`);
  if (!fs.existsSync(sessionFile)) return null;
  const session = readJSON(sessionFile);

  const msgDir = path.join(MESSAGE_DIR, sid);
  const msgFiles = lsSafe(msgDir).filter(f => f.endsWith('.json'));
  const messages = [];
  for (const f of msgFiles) {
    try { messages.push(readJSON(path.join(msgDir, f))); } catch {}
  }
  // ULIDs are sortable lexicographically
  messages.sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));

  for (const m of messages) {
    const partDir = path.join(PART_DIR, sid, m.id);
    const partFiles = lsSafe(partDir).filter(f => f.endsWith('.json'));
    const parts = [];
    for (const f of partFiles) {
      try { parts.push(readJSON(path.join(partDir, f))); } catch {}
    }
    parts.sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
    m.parts = parts;
  }
  return { session, messages };
}

function truncate(s, max) {
  if (typeof s !== 'string') return s;
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}

function partToMarkdown(p, maxChars, skipTools) {
  if (!p) return '';
  switch (p.type) {
    case 'text':
    case 'reasoning':
      return `**[${p.type}]**\n\n${truncate(p.text || '', maxChars)}`;
    case 'tool': {
      if (skipTools) return `**[tool: ${p.tool || '?'}]** (omitted)`;
      const inp = p.state?.input ? '```json\n' + truncate(JSON.stringify(p.state.input, null, 2), maxChars) + '\n```' : '';
      const out = p.state?.output ? '```\n' + truncate(typeof p.state.output === 'string' ? p.state.output : JSON.stringify(p.state.output, null, 2), maxChars) + '\n```' : '';
      const status = p.state?.status || '?';
      return `**[tool: ${p.tool || '?'}]** (${status})\n\n_input:_\n${inp}\n_output:_\n${out}`;
    }
    case 'file':
      return `**[file]** ${p.filename || p.url || '?'} (${p.mime || '?'})`;
    case 'step-start':
    case 'step-finish':
      return `_[${p.type}]_`;
    default:
      return `**[${p.type}]** ${truncate(JSON.stringify(p), maxChars)}`;
  }
}

function cmdReadSession(args) {
  const sid = args.positional[0];
  if (!sid) fail('session-id required');
  const maxChars = parseInt(args.options['max-chars'] || '4000', 10);
  const skipTools = !!args.options['skip-tools'];
  const data = loadSessionData(sid);
  if (!data) fail(`session not found: ${sid}`);

  if (args.options.json) { emit(JSON.stringify(data, null, 2)); return; }

  const { session, messages } = data;
  const lines = [];
  lines.push(`# Session ${session.id}`);
  lines.push('');
  lines.push(`- **Title:** ${session.title || '(untitled)'}`);
  lines.push(`- **Directory:** ${session.directory || '?'}`);
  lines.push(`- **Created:** ${session.time?.created ? new Date(session.time.created).toISOString() : '?'}`);
  lines.push(`- **Updated:** ${session.time?.updated ? new Date(session.time.updated).toISOString() : '?'}`);
  lines.push(`- **Compacted:** ${session.compactedInPlace ? 'yes' : 'no'}`);
  lines.push(`- **Messages:** ${messages.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const m of messages) {
    const role = m.role || '?';
    const agent = m.agent ? ` agent=${m.agent}` : '';
    const model = m.modelID ? ` model=${m.providerID || ''}/${m.modelID}` : '';
    const tokens = m.tokens ? ` tokens(in=${m.tokens.input || 0} out=${m.tokens.output || 0})` : '';
    const created = m.time?.created ? new Date(m.time.created).toISOString() : '';
    lines.push(`## ${role}${agent}${model} — ${m.id}`);
    lines.push(`_${created}${tokens}_`);
    lines.push('');
    for (const p of (m.parts || [])) {
      lines.push(partToMarkdown(p, maxChars, skipTools));
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }
  emit(lines.join('\n'));
}

function walkWiki(dir, base = WIKI) {
  const out = [];
  for (const entry of lsSafe(dir)) {
    const full = path.join(dir, entry);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) out.push(...walkWiki(full, base));
    else if (entry.endsWith('.md')) {
      let rel = full.startsWith(base) ? full.slice(base.length) : full;
      if (rel.startsWith('/')) rel = rel.slice(1);
      out.push(rel);
    }
  }
  return out;
}

function cmdListPages(args) {
  const cat = args.options.category;
  let pages = walkWiki(WIKI);
  if (cat) pages = pages.filter(p => p.startsWith(cat));
  pages.sort();
  output(args, { count: pages.length, pages }, pages.join('\n'));
}

function cmdReadPage(args) {
  const rel = args.positional[0];
  if (!rel) fail('path required');
  const full = path.join(WIKI, rel);
  if (!full.startsWith(WIKI)) fail('path escapes wiki dir');
  const content = safeRead(full);
  if (content === null) fail(`page not found: ${rel}`);
  emit(content);
}

function cmdWritePage(args) {
  const rel = args.positional[0];
  if (!rel) fail('path required');
  const full = path.join(WIKI, rel);
  if (!full.startsWith(WIKI)) fail('path escapes wiki dir');
  let content = args.options.content;
  if (content === undefined || content === true) {
    // stdin not available in sandbox; allow --content-file as fallback
    if (args.options['content-file']) content = fs.readFileSync(args.options['content-file'], 'utf8');
    else fail('--content TEXT or --content-file PATH required');
  }
  ensureDir(path.dirname(full));
  const bytes = (typeof Buffer !== 'undefined' && Buffer.byteLength) ? Buffer.byteLength(content) : content.length;
  if (args.options.append && fs.existsSync(full)) {
    fs.appendFileSync(full, content);
  } else {
    fs.writeFileSync(full, content);
  }
  output(args, { path: rel, bytes, action: args.options.append ? 'append' : 'write' },
    `${args.options.append ? 'appended' : 'wrote'} ${rel} (${bytes} bytes)`);
}

function cmdAppendLog(args) {
  const kind = args.options.kind || 'note';
  const summary = args.options.summary || '';
  const session = args.options.session || '';
  if (!summary) fail('--summary required');
  const date = new Date().toISOString().slice(0, 10);
  const ref = session ? ` | ${session}` : '';
  const line = `## [${date}] ${kind}${ref} | ${summary}\n`;
  ensureDir(WIKI);
  fs.appendFileSync(LOG_PATH, line);
  output(args, { date, kind, session, summary }, line.trim());
}

function cmdProcessed(args) {
  const sid = args.positional[0];
  if (!sid) fail('session-id required');
  const processed = loadProcessedIds();
  const yes = processed.has(sid);
  output(args, { sessionId: sid, processed: yes }, yes ? 'yes' : 'no');
  process.exit(yes ? 0 : 2);
}

function cmdSearch(args) {
  const pattern = args.positional[0];
  if (!pattern) fail('pattern required');
  const cat = args.options.category;
  let pages = walkWiki(WIKI);
  if (cat) pages = pages.filter(p => p.startsWith(cat));
  const re = new RegExp(pattern, 'i');
  const hits = [];
  for (const rel of pages) {
    const txt = safeRead(path.join(WIKI, rel)) || '';
    const lines = txt.split('\n');
    lines.forEach((line, i) => {
      if (re.test(line)) hits.push({ page: rel, line: i + 1, text: line.trim().slice(0, 200) });
    });
  }
  output(args, { count: hits.length, hits },
    hits.map(h => `${h.page}:${h.line}: ${h.text}`).join('\n'));
}

function cmdStats(args) {
  const sessions = lsSafe(SESSION_DIR).filter(f => f.endsWith('.json')).length;
  let messages = 0, parts = 0;
  for (const sid of lsSafe(MESSAGE_DIR)) {
    messages += lsSafe(path.join(MESSAGE_DIR, sid)).filter(f => f.endsWith('.json')).length;
  }
  for (const sid of lsSafe(PART_DIR)) {
    for (const mid of lsSafe(path.join(PART_DIR, sid))) {
      parts += lsSafe(path.join(PART_DIR, sid, mid)).filter(f => f.endsWith('.json')).length;
    }
  }
  const pages = walkWiki(WIKI).length;
  const processed = loadProcessedIds().size;
  const data = { sessions, messages, parts, wikiPages: pages, processedSessions: processed, unprocessed: sessions - processed };
  output(args, data,
    `sessions: ${sessions}\nmessages: ${messages}\nparts: ${parts}\nwiki pages: ${pages}\nprocessed: ${processed}\nunprocessed: ${sessions - processed}`);
}

// ---------- main ----------
const COMMANDS = {
  'list-sessions': cmdListSessions,
  'read-session': cmdReadSession,
  'list-pages': cmdListPages,
  'read-page': cmdReadPage,
  'write-page': cmdWritePage,
  'append-log': cmdAppendLog,
  'processed': cmdProcessed,
  'search': cmdSearch,
  'stats': cmdStats
};

function help() {
  emit(
`openpave-wiki - PAVE session history + LLM-maintained wiki

Commands:
  list-sessions [--limit N] [--unprocessed] [--since DATE] [--dir SUBSTR]
  read-session <id> [--max-chars N] [--skip-tools]
  list-pages [--category CAT]
  read-page <path>
  write-page <path> --content TEXT | --content-file PATH [--append]
  append-log --kind ingest|query|lint|note --summary TEXT [--session ID]
  processed <id>            (exit 0 if processed, 2 if not)
  search <pattern> [--category CAT]
  stats

All commands accept --json for machine output.
`);
}

const args = parseArgs(process.argv.slice(2));
if (!args.command || args.options.help) { help(); process.exit(args.command ? 0 : 1); }
const fn = COMMANDS[args.command];
if (!fn) fail(`unknown command: ${args.command}`);
try { fn(args); } catch (e) { fail(e.stack || e.message); }
