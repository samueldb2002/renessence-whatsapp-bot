/**
 * Passes, Memberships and the PT promotion — the team's "New Passes,
 * Memberships & Promotions" document (launch Monday 19 October 2026).
 *
 * Everything switches by date on the server clock (pinned to Europe/Amsterdam
 * in server.js), so the bot can be deployed before the launch and needs no
 * redeploy on the day: until 19 October the bot keeps the old offering, from
 * 00:00 that day it only knows the new one.
 */

const NEW_OFFERING_START = new Date('2026-10-19T00:00:00');

// "Buy a Pass, get 1 complimentary PT session": 19 October – 1 November
// inclusive, so it ends at midnight going into 2 November.
const PT_PROMO_START = NEW_OFFERING_START;
const PT_PROMO_END = new Date('2026-11-02T00:00:00');

const isNewOffering = (now = new Date()) => now >= NEW_OFFERING_START;
const isPtPromoActive = (now = new Date()) => now >= PT_PROMO_START && now < PT_PROMO_END;
const isPtPromoOver = (now = new Date()) => now >= PT_PROMO_END;

// What every Pass and Membership includes. The launch document lists prices,
// commitments and benefits but not the access itself; this is what every
// current pass and membership on renessence.com/gym-and-members-club includes
// (Oct 2026) — confirm with the team if the new products differ.
const INCLUDED_ACCESS = 'gym access and our private tech treatments: Red Light Therapy (15 min), Infrared Sauna (25 min), Hyperbaric Oxygen Hydroxy (30 min) and Hydrowave (25 min) — max 1 session per treatment type per day';

const MEMBERSHIPS_URL = 'https://renessence.com/gym-and-members-club';

/** The prompt section that replaces every older membership text from 19 October. */
const PASSES_AND_MEMBERSHIPS_SECTION = `## Passes & Memberships (since 19 October 2026)
Access to our gym and tech treatments is sold as Passes and Memberships. Answer every question about them from THIS section only — it replaces all older names and prices you may see in the conversation history (Live HI, Move HI, Say HI, Ultimate HI, Heat Reset for 1 or 2 people, Hyperbaric Reset 30 min, the September "One-Month Pass" for €250, the summer prices). Those are no longer sold.

Every Pass and Membership includes ${INCLUDED_ACCESS}.

**Passes** — no freezing and no Membership discounts:
- 1 Month Pass — €295 for 1 month. Does NOT renew automatically. Always available, and can be bought again as often as the guest likes.
- 3 Month Pass — €275 per month, 3-month commitment.
- 6 Month Pass — €250 per month, 6-month commitment.

**Memberships** — can be frozen, and members get 25% discount on tech treatments, classes and concerts and 10% discount on massages, facials and other traditional treatments:
- 3 Month Membership — €350 per month, 3-month commitment.
- 6 Month Membership — €325 per month, 6-month commitment.
- 12 Month Membership — €300 per month, 12-month commitment.

**Duo Memberships** — for 2 people; the price is per month for the two together. Same discounts and freezing as a Membership:
- 3 Month Duo — €650 per month, 3-month commitment.
- 12 Month Duo — €500 per month, 12-month commitment.

**Hyperbaric Reset (60 min)** — a separate oxygen-only plan, and the only treatment plan we keep: €550 per month for 1 Hyperbaric Oxygen Hydroxy session of 60 minutes per day. It is bought at https://renessence.com/hyperbaric-oxygen-hydroxy, in the Renessence app or at reception. The Heat Reset (1 and 2 people) and the Hyperbaric Reset (30 min) are discontinued — if someone asks for them, explain that kindly and offer the options above.

Rules:
- Quote these prices and terms exactly. Never invent other options, deals, intro prices or discounts, and never calculate a member's discounted price for a treatment.
- You cannot sell, set up, freeze or change a Pass or Membership in this chat. Guests buy them at ${MEMBERSHIPS_URL}, in the Renessence app or at reception. For anything you can't answer from here (freezing conditions, cancelling, invoices, an existing membership) → memberships@renessence.com.
- Membership discounts can't be applied to bookings or payment links in this chat. A guest who says they have a Membership or Duo Membership books with their member benefits in the Renessence app or on renessence.com (see "Special redirects"). Never say a discount will be applied to a link you send.
- Guests who already have an older membership (e.g. Live HI) keep their own terms — refer questions about it to memberships@renessence.com.
- **Never mention the reception-only intro offer.** Our hosts can offer some first-time guests a special one-month pass at reception; it is deliberately not advertised online. Do not mention, confirm or quote it. If someone asks about a cheaper one-month pass or "intro pass", say the 1 Month Pass is €295 and that our hosts at reception are happy to talk through the options when they visit. (The 6 Month Pass at €250 per month is a normal, public option — you may of course quote that one.)
- If someone refers to the September One-Month Pass campaign (€250), explain kindly that it has ended and give the current options above.`;

const PT_PROMO_SECTION = `## PT promotion — "Buy a Pass, get 1 complimentary PT session" (19 October – 1 November 2026)
- Every 1 Month Pass (€295), 3 Month Pass (€275 per month) or 6 Month Pass (€250 per month) bought from 19 October up to and including 1 November 2026 comes with one complimentary Personal Training session.
- It does NOT apply to Memberships or Duo Memberships.
- How it works: after the purchase, Renessence connects the guest with one of our personal trainers; the guest and the trainer arrange the session directly; Renessence pays for it. You cannot book the PT session in this chat.
- If a guest bought a Pass in this period and hasn't been connected with a trainer yet, call request_human_handoff (reason "PT promotion — connect with trainer") so the team can arrange it.
- At the start of a new conversation the system may already have sent the guest a message about this promotion, right before your reply. Never repeat that pitch. Mention the promotion when the guest asks about passes, memberships, the gym, offers or personal training.`;

// Buyers from the last days are still waiting for their trainer in early
// November — "it has ended" must only apply to new purchases.
const PT_PROMO_ENDED_LINE = '- The PT promotion ("Buy a Pass, get 1 complimentary PT session") was for 1, 3 and 6 Month Passes bought from 19 October up to and including 1 November 2026. New purchases no longer come with a PT session — say so kindly if asked. Guests who bought a Pass in that period still get their session: if they haven\'t been connected with a trainer yet, call request_human_handoff (reason "PT promotion — connect with trainer"). Never tell such a guest the offer has ended.';

module.exports = {
  NEW_OFFERING_START,
  PT_PROMO_START,
  PT_PROMO_END,
  MEMBERSHIPS_URL,
  isNewOffering,
  isPtPromoActive,
  isPtPromoOver,
  PASSES_AND_MEMBERSHIPS_SECTION,
  PT_PROMO_SECTION,
  PT_PROMO_ENDED_LINE,
};
