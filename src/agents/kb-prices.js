/**
 * The knowledge base quotes treatment prices as Dutch text ("60min EUR 130 /
 * 80min EUR 170", "Vanaf EUR 80"). Before it reaches the prompt, each of those
 * amounts is filled in from PRICE_MAP — the prices Stripe charges, which the
 * team edits in the dashboard — so the bot can't quote an old price next to a
 * new one. Packages (5x, 3x) are edited by the team as their own section and
 * leave the knowledge base.
 */

// path in the knowledge base → for each "EUR n" in the text, in order, the
// session types it quotes ("Vanaf" = the cheapest of them).
const PRICED_FIELDS = [
  [['pricing', 'tech_treatments', 'float', '1 persoon (60 min)'], [[58]]],
  [['pricing', 'tech_treatments', 'infrared_sauna', '1 persoon 25 min'], [[98, 65]]],
  [['pricing', 'tech_treatments', 'infrared_sauna', '2 personen 25 min'], [[97]]],
  [['pricing', 'tech_treatments', 'oxygen_hydroxy', '30 min (liggend of zittend)'], [[71, 92]]],
  [['pricing', 'tech_treatments', 'oxygen_hydroxy', '60 min (liggend of zittend)'], [[93, 94]]],
  [['pricing', 'tech_treatments', 'finnish_sauna', 'Solo (60 min)'], [[87]]],
  [['pricing', 'tech_treatments', 'finnish_sauna', '2 personen (60 min)'], [[69]]],
  [['pricing', 'tech_treatments', 'finnish_sauna', '3 personen (60 min)'], [[91]]],
  [['pricing', 'tech_treatments', 'hydrowave', '25 min'], [[80]]],
  [['pricing', 'traditional_treatments', 'massage', 'Tailored 60 min'], [[31]]],
  [['pricing', 'traditional_treatments', 'massage', 'Tailored 80 min'], [[32]]],
  [['pricing', 'traditional_treatments', 'massage', 'Prenatal 60 min'], [[35]]],
  [['pricing', 'traditional_treatments', 'massage', 'Prenatal 80 min'], [[36]]],
  [['pricing', 'traditional_treatments', 'massage', 'Lymphatic Drainage 60 min'], [[37]]],
  [['pricing', 'traditional_treatments', 'massage', 'Lymphatic Drainage 80 min'], [[38]]],
  [['pricing', 'traditional_treatments', 'massage', 'LED Light Face Therapy add-on'], [[30]]],
  [['pricing', 'traditional_treatments', 'facial', 'Orchid Stem Cell Renewal Facial 60 min'], [[41]]],
  [['pricing', 'traditional_treatments', 'nervous_system_reset', '1 sessie 90 min'], [[45]]],
  [['pricing', 'classes', 'Vinyasa Flow 60 min'], [[83]]],
  [['pricing', 'classes', 'Empowered Pilates 60 min'], [[83]]],
  [['pricing', 'classes', 'Mobility Flow 60 min'], [[83]]],
  [['pricing', 'classes', 'Breathe & Release 60 min'], [[83]]],
  [['treatments', 'traditional', 'massage', 'types', 'Tailored Massage'], [[31], [32]]],
  [['treatments', 'traditional', 'massage', 'types', 'Prenatal Massage'], [[35], [36]]],
  [['treatments', 'traditional', 'massage', 'types', 'Lymphatic Drainage'], [[37], [38]]],
  [['treatments', 'traditional', 'massage', 'add_on'], [[30]]],
  [['treatments', 'traditional', 'facial', 'price'], [[41]]],
  [['treatments', 'traditional', 'facial', 'add_on'], [[30]]],
  [['treatments', 'traditional', 'nervous_system_reset', 'prices', 'Enkele sessie'], [[45]]],
  [['treatments', 'traditional', 'let_it_go', 'price'], [[109]]],
  [['classes', 'types', 'Vinyasa Flow'], [[83]]],
  [['classes', 'types', 'Empowered Pilates'], [[83]]],
  [['classes', 'types', 'Mobility Flow'], [[83]]],
  [['classes', 'types', 'Breathe & Release'], [[83]]],
  [['classes', 'pricing', 'single_class'], [[83]]],
];

// Packages are the team's "Packages" section now (settings.service.js).
const PACKAGE_FIELDS = [
  ['pricing', 'tech_treatments', 'infrared_sauna', '5x Pack 25 min'],
  ['pricing', 'traditional_treatments', 'nervous_system_reset', '3x Pack 90 min'],
  ['treatments', 'traditional', 'nervous_system_reset', 'prices', '3x Pack'],
  ['treatments', 'tech', 'oxygen_hydroxy', 'package'],
];

function parentOf(obj, path) {
  let node = obj;
  for (const key of path.slice(0, -1)) {
    node = node?.[key];
    if (!node || typeof node !== 'object') return null;
  }
  return node;
}

/** A copy of the knowledge base with today's prices and without the packages. */
function withLivePrices(kb, priceInEuros) {
  const out = JSON.parse(JSON.stringify(kb));
  for (const [path, groups] of PRICED_FIELDS) {
    const parent = parentOf(out, path);
    const key = path[path.length - 1];
    if (!parent || typeof parent[key] !== 'string') continue;
    let i = 0;
    parent[key] = parent[key].replace(/EUR \d+/g, (m) => {
      const ids = groups[i++];
      return ids ? `EUR ${Math.min(...ids.map(priceInEuros))}` : m;
    });
  }
  for (const path of PACKAGE_FIELDS) {
    const parent = parentOf(out, path);
    if (parent) delete parent[path[path.length - 1]];
  }
  return out;
}

module.exports = { withLivePrices, PRICED_FIELDS };
