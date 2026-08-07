// server/chat.js
// Ask Saathi's context builder — the part that makes chat feel like it has
// memory. Ported from ../../brain/services/core/modules/context/service.py.
//
// The mechanism is entirely retrieval: before each turn, search runs with the
// latest user message as the query and the top hits are injected into the system
// prompt as delimited data blocks. There is no fine-tuning and no separate RAG
// service.
//
// What changed from the previous version, and it is the whole point: the model
// used to be handed result LABELS only — "[grievances] Ramesh Kumar — Housing,
// Piduguralla, Pending" — and never `issue_description`. It could tell you a
// grievance existed and not what it said. Records now carry their body text, and
// this file puts that text in front of the model.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { search } from './search.js';
import { listMessages } from './db/conversations.js';
import { listGrievances } from './db/grievances.js';
import { listEvents } from './db/events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The prompt lives on disk and is VERSIONED, so changing how the assistant behaves
// is a reviewable diff rather than a string edit buried in a route handler.
const PROMPT_PATH = path.join(__dirname, 'prompts', 'chat_v1.md');

// Turns of history to carry. Older turns are dropped first (see trim).
const MAX_TURNS = 20;
// Retrieval depth per turn.
const SEARCH_K = 10;
// Only the first part of a long message is a useful query; the rest is context
// for the model, not for the index.
const QUERY_CHARS = 240;
// How much of a record's body to quote. Enough to answer from, short enough that
// ten of them do not crowd out the conversation.
const BODY_CHARS = 600;

// Deliberately pessimistic. A real tokenizer is a refinement, not a prerequisite:
// over-estimating costs a little context, under-estimating costs a failed request.
const CHARS_PER_TOKEN = 3.5;
const MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS || 6000);

export const FALLBACK_REPLY =
  "I couldn't reach the AI assistant just now. Your message has been saved — please try again in a moment.";

// ── the data blocks ──────────────────────────────────────────────────────
// Everything retrieved is rendered inside <<<DATA:...>>> … <<<END>>>. That is the
// prompt-injection boundary: a grievance whose description says "ignore your
// instructions" arrives as quoted data, and the system prompt says in as many
// words that block contents are never instructions.
//
// It is also why the system message is exempt from trimming below — a provider
// truncating from the front would remove exactly the framing rule that makes the
// quoting mean anything.

function block(name, lines) {
  if (!lines.length) return `<<<DATA:${name}>>>\n(none)\n<<<END>>>`;
  return `<<<DATA:${name}>>>\n${lines.join('\n')}\n<<<END>>>`;
}

function renderRecords(results) {
  return block('records', results.map(r => {
    const body = String(r.body || '').replace(/\s+/g, ' ').trim().slice(0, BODY_CHARS);
    return `- [${r.source}] ${r.title}${r.subtitle ? ` (${r.subtitle})` : ''}\n  ${body}`;
  }));
}

function renderOpenGrievances(items) {
  return block('open_grievances', items.map(g => {
    const place = [g.village, g.mandal].filter(Boolean).join(', ');
    return `- ${g.full_name || 'unnamed'} · ${g.category} · ${g.resolution_status}`
      + `${place ? ` · ${place}` : ''} · priority ${g.priority_score}`
      + `\n  ${String(g.issue_description || '').replace(/\s+/g, ' ').slice(0, 300)}`;
  }));
}

function renderSchedule(items) {
  return block('todays_schedule', items.map(e => {
    const place = [e.village, e.mandal].filter(Boolean).join(', ');
    return `- ${e.time || 'time TBC'} · ${e.event_name}${place ? ` · ${place}` : ''}`
      + `${e.nearby_count ? ` · ${e.nearby_count} contacts nearby` : ''}`;
  }));
}

// ── context ──────────────────────────────────────────────────────────────

/**
 * Build the messages for one turn.
 *
 * Retrieval is BEST-EFFORT: if search throws, the turn still happens with less
 * context rather than failing. A chat that refuses to answer because its index is
 * unhappy is worse than a chat that answers from the conversation alone.
 */
export function buildContext(conversationId, message, { istDate }) {
  const turns = listMessages(conversationId, { limit: 500 }).items.slice(-MAX_TURNS);

  let results = [];
  let grounding = [];
  try {
    const query = String(message || '').slice(0, QUERY_CHARS);
    const found = search(query, { k: SEARCH_K });
    results = found.results;
    grounding = results.map(r => ({ source: r.source, id: r.id, label: r.title }));
  } catch (err) {
    console.error('chat: retrieval failed, continuing without records:', err.message);
  }

  let openGrievances = [];
  let todaysEvents = [];
  try {
    openGrievances = listGrievances({ status: 'Pending' }).slice(0, 10);
    todaysEvents = listEvents({ from: istDate, to: istDate });
  } catch (err) {
    console.error('chat: standing context failed:', err.message);
  }

  const template = fs.readFileSync(PROMPT_PATH, 'utf8');
  const system = template
    .replaceAll('${date}', istDate)
    .replaceAll('${records_block}', renderRecords(results))
    .replaceAll('${grievances_block}', renderOpenGrievances(openGrievances))
    .replaceAll('${schedule_block}', renderSchedule(todaysEvents));

  const messages = [
    { role: 'system', content: system },
    ...turns.map(t => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.body })),
  ];

  return { messages: trim(messages), grounding };
}

/**
 * Drop the OLDEST non-system messages until the budget is met.
 *
 * The system message is never dropped. It carries the injection-boundary rule and
 * the retrieved records; losing it would leave the model with a conversation and
 * no framing for the quoted data it was about to read.
 */
function trim(messages, maxTokens = MAX_TOKENS) {
  const cost = m => Math.ceil(m.content.length / CHARS_PER_TOKEN);
  const system = messages.filter(m => m.role === 'system');
  const rest = messages.filter(m => m.role !== 'system');

  let total = system.reduce((n, m) => n + cost(m), 0) + rest.reduce((n, m) => n + cost(m), 0);
  let start = 0;
  while (total > maxTokens && start < rest.length - 1) {
    total -= cost(rest[start]);
    start += 1;
  }
  return [...system, ...rest.slice(start)];
}

export const _internals = { trim, renderRecords, block };
