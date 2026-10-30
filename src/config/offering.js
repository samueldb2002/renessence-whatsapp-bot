/**
 * Passes and Memberships — the team's "New Passes, Memberships & Promotions"
 * document (launch Monday 19 October 2026). Its PT promotion is now a dated
 * promotion the team edits in the dashboard (config/default-promotions.js).
 *
 * Everything switches by date on the server clock (pinned to Europe/Amsterdam
 * in server.js), so the bot can be deployed before the launch and needs no
 * redeploy on the day: until 19 October the bot keeps the old offering, from
 * 00:00 that day it only knows the new one.
 */

const NEW_OFFERING_START = new Date('2026-10-19T00:00:00');

const isNewOffering = (now = new Date()) => now >= NEW_OFFERING_START;

// What every Pass and Membership includes. The launch document lists prices,
// commitments and benefits but not the access itself; this is what every
// current pass and membership on renessence.com/gym-and-members-club includes
// (Oct 2026) — confirm with the team if the new products differ.
const INCLUDED_ACCESS = 'gym access and our private tech treatments: Red Light Therapy (15 min), Infrared Sauna (25 min), Hyperbaric Oxygen Hydroxy (30 min) and Hydrowave (25 min) — max 1 session per treatment type per day';

const MEMBERSHIPS_URL = 'https://renessence.com/gym-and-members-club';

/**
 * The products: what the team edits in the dashboard ("Bot content" → Passes &
 * Memberships). These are the launch document's values, used until the team
 * saves its own list. A group with one product of the same name (the
 * Hyperbaric Reset) is written as one paragraph.
 */
const DEFAULT_MEMBERSHIPS = {
  included: INCLUDED_ACCESS,
  groups: [
    {
      name: 'Passes',
      note: 'no freezing and no Membership discounts',
      items: [
        { name: '1 Month Pass', priceEur: 295, perMonth: false, terms: 'for 1 month. Does NOT renew automatically. Always available, and can be bought again as often as the guest likes.' },
        { name: '3 Month Pass', priceEur: 275, perMonth: true, terms: '3-month commitment.' },
        { name: '6 Month Pass', priceEur: 250, perMonth: true, terms: '6-month commitment.' },
      ],
    },
    {
      name: 'Memberships',
      note: 'can be frozen, and members get 25% discount on tech treatments, classes and concerts and 10% discount on massages, facials and other traditional treatments',
      items: [
        { name: '3 Month Membership', priceEur: 350, perMonth: true, terms: '3-month commitment.' },
        { name: '6 Month Membership', priceEur: 325, perMonth: true, terms: '6-month commitment.' },
        { name: '12 Month Membership', priceEur: 300, perMonth: true, terms: '12-month commitment.' },
      ],
    },
    {
      name: 'Duo Memberships',
      note: 'for 2 people; the price is per month for the two together. Same discounts and freezing as a Membership',
      items: [
        { name: '3 Month Duo', priceEur: 650, perMonth: true, terms: '3-month commitment.' },
        { name: '12 Month Duo', priceEur: 500, perMonth: true, terms: '12-month commitment.' },
      ],
    },
    {
      name: 'Hyperbaric Reset (60 min)',
      note: 'a separate oxygen-only plan, and the only treatment plan we keep',
      items: [
        { name: 'Hyperbaric Reset (60 min)', priceEur: 550, perMonth: true, terms: 'for 1 Hyperbaric Oxygen Hydroxy session of 60 minutes per day. It is bought at https://renessence.com/hyperbaric-oxygen-hydroxy, in the Renessence app or at reception.' },
      ],
    },
  ],
};

/** "€295 for 1 month. …" / "€275 per month, 3-month commitment." */
function priceLine(item) {
  if (!item.perMonth) return `€${item.priceEur}${item.terms ? ` ${item.terms}` : '.'}`;
  return `€${item.priceEur} per month${item.terms ? `, ${item.terms}` : '.'}`;
}

const findProduct = (m, name) => m.groups.flatMap(g => g.items).find(i => i.name === name) || null;

/** "the 1 Month Pass, €295, is always available" — for the gym-access rule elsewhere in the prompt. */
function oneMonthPassNote(m) {
  const pass = findProduct(m, '1 Month Pass');
  return pass ? ` (the 1 Month Pass, €${pass.priceEur}, is always available)` : '';
}

/** The prompt section that replaces every older membership text from 19 October. */
function renderPassesAndMemberships(m) {
  const groups = m.groups.map((g) => {
    const only = g.items.length === 1 && g.items[0].name === g.name ? g.items[0] : null;
    // One plan: "€550 per month for 1 … session" reads as one sentence.
    if (only) return `**${g.name}**${g.note ? ` — ${g.note}` : ''}: €${only.priceEur}${only.perMonth ? ' per month' : ''}${only.terms ? ` ${only.terms}` : '.'}`;
    return `**${g.name}**${g.note ? ` — ${g.note}` : ''}:\n${g.items.map(i => `- ${i.name} — ${priceLine(i)}`).join('\n')}`;
  });
  const onePass = findProduct(m, '1 Month Pass');
  const sixPass = findProduct(m, '6 Month Pass');
  return `## Passes & Memberships (since 19 October 2026)
Access to our gym and tech treatments is sold as Passes and Memberships. Answer every question about them from THIS section only — it replaces all older names and prices you may see in the conversation history (Live HI, Move HI, Say HI, Ultimate HI, Heat Reset for 1 or 2 people, Hyperbaric Reset 30 min, the September "One-Month Pass" for €250, the summer prices). Those are no longer sold.

Every Pass and Membership includes ${m.included}.

${groups.join('\n\n')}

The Heat Reset (1 and 2 people) and the Hyperbaric Reset (30 min) are discontinued — if someone asks for them, explain that kindly and offer the options above.

Rules:
- Quote these prices and terms exactly. Never invent other options, deals, intro prices or discounts, and never calculate a member's discounted price for a treatment.
- You cannot sell, set up, freeze or change a Pass or Membership in this chat. Guests buy them at ${MEMBERSHIPS_URL}, in the Renessence app or at reception. For anything you can't answer from here (freezing conditions, cancelling, invoices, an existing membership) → memberships@renessence.com.
- Membership discounts can't be applied to bookings or payment links in this chat. A guest who says they have a Membership or Duo Membership books with their member benefits in the Renessence app or on renessence.com (see "Special redirects"). Never say a discount will be applied to a link you send.
- Guests who already have an older membership (e.g. Live HI) keep their own terms — refer questions about it to memberships@renessence.com.
- **Never mention the reception-only intro offer.** Our hosts can offer some first-time guests a special one-month pass at reception; it is deliberately not advertised online. Do not mention, confirm or quote it. If someone asks about a cheaper one-month pass or "intro pass", ${onePass ? `say the 1 Month Pass is €${onePass.priceEur}` : 'give the Passes listed above'} and that our hosts at reception are happy to talk through the options when they visit.${sixPass ? ` (The 6 Month Pass at €${sixPass.priceEur} per month is a normal, public option — you may of course quote that one.)` : ''}
- If someone refers to the September One-Month Pass campaign (€250), explain kindly that it has ended and give the current options above.`;
}

module.exports = {
  NEW_OFFERING_START,
  MEMBERSHIPS_URL,
  DEFAULT_MEMBERSHIPS,
  isNewOffering,
  renderPassesAndMemberships,
  oneMonthPassNote,
};
