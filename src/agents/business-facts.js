/**
 * The prompt sections built from the team's dashboard edits (opening hours,
 * closures, notices, contact; promotions). They sit after the knowledge base
 * and before Session: an edit changes only this tail, so the long static body
 * before it stays in OpenAI's prompt cache.
 */

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_KEYS = DAY_NAMES.map(d => d.toLowerCase());
const FMT_DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

// "Friday, 25 December 2026" → "Friday 25 December 2026"
const longDate = (ymd) => FMT_DAY.format(new Date(`${ymd}T12:00:00`)).replace(',', '');
const span = (h) => (h.closed ? 'closed' : `${h.open}–${h.close}`);

/** "Monday–Thursday 07:00–21:00 · Friday 07:00–20:00 · …" */
function weeklyHours(hours) {
  const groups = [];
  DAY_KEYS.forEach((key, i) => {
    const text = span(hours[key]);
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.to = i;
    else groups.push({ from: i, to: i, text });
  });
  return groups.map(g => `${g.from === g.to ? DAY_NAMES[g.from] : `${DAY_NAMES[g.from]}–${DAY_NAMES[g.to]}`} ${g.text}`).join(' · ');
}

function closureLine(c) {
  const when = c.from === c.to ? longDate(c.from) : `${longDate(c.from)} – ${longDate(c.to)}`;
  const what = c.closed ? 'closed' : `open ${c.open}–${c.close} only`;
  return `- ${when}: ${what}${c.note ? ` (${c.note})` : ''}`;
}

function renderBusinessFacts({ hours, contact, closures, notices }) {
  const e = contact.emails;
  const lines = [
    '## Opening hours, closures and notices',
    'Kept up to date by the Renessence team. This section is the only source for opening hours, closures, the address and contact details.',
    `Opening hours: ${weeklyHours(hours)}`,
    `Address: ${contact.address}`,
    ...(contact.phone ? [`Phone: ${contact.phone}`] : []),
    `Email: general questions ${e.general} · events and space rental ${e.events} · memberships ${e.memberships} · press ${e.press}`,
    '',
  ];
  if (closures.length) {
    lines.push('Planned closures and special opening hours:', ...closures.map(closureLine),
      'Nothing can be booked on a closed day, and on a day with special hours only within them — availability already reflects this. If a customer asks for such a day, say so kindly with the reason and suggest another day.');
  } else {
    lines.push('No closures or special opening hours are planned.');
  }
  if (notices.length) {
    lines.push('', 'Notices from the team (mention them when relevant; never add details that are not written here):',
      ...notices.map(n => `- ${n.text} (until ${longDate(n.until)})`));
  }
  return lines.join('\n') + '\n';
}

const FMT_DAY_MONTH = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long' });
const dayMonth = (ymd) => FMT_DAY_MONTH.format(new Date(`${ymd}T12:00:00`));

/** "19 October – 1 November 2026" (the start year only when it differs). */
function promotionDates(p) {
  const fromYear = p.from.slice(0, 4) === p.until.slice(0, 4) ? '' : ` ${p.from.slice(0, 4)}`;
  return `${dayMonth(p.from)}${fromYear} – ${dayMonth(p.until)} ${p.until.slice(0, 4)}`;
}

/** The promotions section: running ones in full, ended ones by their after-end text. */
function renderPromotions({ running, ended }) {
  const lines = ['## Promotions', 'Set by the Renessence team. These are the only promotions: never invent other deals, discounts or offers.'];
  if (!running.length) lines.push('There are no promotions running right now.');
  for (const p of running) {
    lines.push('', `### ${p.name} (${promotionDates(p)})`, p.botInfo);
    if (p.onlyWhenAsked) lines.push('- Mention it only when the guest asks about it or about what it covers; never bring it up yourself.');
    if (p.intro.enabled) lines.push('- At the start of a new conversation the system may already have sent the guest a message about this promotion, right before your reply. Never repeat that pitch.');
  }
  if (ended.length) {
    lines.push('', 'Ended promotions — what to say if a guest asks about them:');
    for (const p of ended) lines.push('', `### Ended: ${p.name} (${promotionDates(p)})`, p.afterEnd.text);
  }
  return lines.join('\n') + '\n';
}

/** Multi-session packages, as the team describes them. */
function renderPackages(items) {
  const lines = [
    '## Packages',
    'Set by the Renessence team. Packages can\'t be sold or booked in this chat: guests buy them on https://renessence.com (see "Special redirects"), then book the sessions. Quote them exactly as written here and mention one when it fits what the guest is interested in.',
  ];
  if (!items.length) lines.push('No packages are sold right now.');
  for (const p of items) lines.push(`- **${p.name}** — ${p.text}`);
  return lines.join('\n') + '\n';
}

/** Treatments the team paused: nothing when none are. */
function renderPaused(names) {
  if (!names.length) return '';
  return `## Treatments paused by the team
Paused for now — never offer, check or book them; if a guest asks, say it is temporarily unavailable and suggest another treatment: ${names.join(', ')}.
`;
}

module.exports = { renderBusinessFacts, renderPromotions, renderPackages, renderPaused, weeklyHours, longDate };
