/**
 * The promotions that were code until the team could edit them in the
 * dashboard ("Bot content" → Promotions). They are the fallback: with nothing
 * saved, the bot behaves exactly as before. Once the team saves the
 * promotions list, the saved list is used instead.
 *
 * - PT promotion: from src/config/offering.js (prompt texts) and
 *   intro-promo.service.js (the WhatsApp intro), the team's "New Passes,
 *   Memberships & Promotions" document, 19 October – 1 November 2026.
 * - December gift-card deal: was undated text in knowledge-base.json
 *   (gift_cards.december_promotion), so the bot quoted it in any month.
 *   Dated here for December 2026; the team can change or delete it.
 */

const PT_PROMO = {
  // Fixed: the once-per-guest intro log (promo_messages_sent) is keyed on it.
  id: 'pt-promo-2026-10',
  name: 'PT promotion',
  from: '2026-10-19',
  until: '2026-11-01',
  botInfo: `"Buy a Pass, get 1 complimentary PT session" (19 October – 1 November 2026)
- Every 1 Month Pass (€295), 3 Month Pass (€275 per month) or 6 Month Pass (€250 per month) bought from 19 October up to and including 1 November 2026 comes with one complimentary Personal Training session.
- It does NOT apply to Memberships or Duo Memberships.
- How it works: after the purchase, Renessence connects the guest with one of our personal trainers; the guest and the trainer arrange the session directly; Renessence pays for it. You cannot book the PT session in this chat.
- If a guest bought a Pass in this period and hasn't been connected with a trainer yet, call request_human_handoff (reason "PT promotion — connect with trainer") so the team can arrange it.
- Mention the promotion when the guest asks about passes, memberships, the gym, offers or personal training.`,
  onlyWhenAsked: false,
  // Buyers from the last days are still waiting for their trainer in early
  // November — "it has ended" must only apply to new purchases.
  afterEnd: {
    text: 'The PT promotion ("Buy a Pass, get 1 complimentary PT session") was for 1, 3 and 6 Month Passes bought from 19 October up to and including 1 November 2026. New purchases no longer come with a PT session — say so kindly if asked. Guests who bought a Pass in that period still get their session: if they haven\'t been connected with a trainer yet, call request_human_handoff (reason "PT promotion — connect with trainer"). Never tell such a guest the offer has ended.',
    until: '2026-12-31',
  },
  intro: {
    enabled: true,
    en: `Before we help you, something we'd love to share ✨

*Buy a Pass, get a complimentary Personal Training session*

From now until 1 November, every *1 Month Pass* (€295), *3 Month Pass* (€275 per month) or *6 Month Pass* (€250 per month) comes with one personal training session, on us. After your purchase we'll connect you with one of our personal trainers, and you plan the session together.

Get your Pass at renessence.com/gym-and-members-club, in the Renessence app or at reception.

We look forward to welcoming you at Renessence.`,
    nl: `Voordat we je helpen, iets wat we graag met je delen ✨

*Koop een Pass en krijg een gratis Personal Training-sessie*

Tot en met 1 november krijg je bij elke *1 Month Pass* (€295), *3 Month Pass* (€275 per maand) of *6 Month Pass* (€250 per maand) een personal training-sessie cadeau. Na je aankoop brengen we je in contact met een van onze personal trainers, en plannen jullie samen de sessie in.

Je Pass koop je via renessence.com/gym-and-members-club, in de Renessence-app of bij de receptie.

We kijken ernaar uit je te verwelkomen bij Renessence.`,
    image: '/public/pt-promo-2026-10.jpg',
  },
};

const DECEMBER_GIFT_CARDS = {
  id: 'gift-cards-december-2026',
  name: 'December gift-card deal',
  from: '2026-12-01',
  until: '2026-12-24',
  botInfo: `Gift cards are worth more than they cost, up to and including 24 December: €90 for €75, €220 for €175, €325 for €250, €475 for €350 and €700 for €500. Gift cards are bought online at https://renessence.com.`,
  onlyWhenAsked: false,
  afterEnd: null,
  intro: { enabled: false, en: '', nl: '', image: null },
};

module.exports = { DEFAULT_PROMOTIONS: [PT_PROMO, DECEMBER_GIFT_CARDS] };
