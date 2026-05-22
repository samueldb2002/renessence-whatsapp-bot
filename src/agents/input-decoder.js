/**
 * Input decoder for the Renessence AI Agent.
 * Translates button/list IDs from WhatsApp interactive messages into readable text for the AI.
 */

const dynamicCatalogService = require('../services/dynamic-catalog.service');

// Static catalog (synchronous — loaded at startup)
const _catalog = dynamicCatalogService.getCatalog();

function decodeInput(buttonReply, listReply) {
  const id = buttonReply?.id || listReply?.id;
  const title = buttonReply?.title || listReply?.title || '';

  if (!id) return null;

  // Group class selection: class_456
  if (id.startsWith('class_')) {
    const classId = id.slice(6);
    return `${title} [classId=${classId}]`;
  }

  // Slot selection: slot_2026-05-01T09:00:00_5_58
  if (id.startsWith('slot_')) {
    const withoutPrefix = id.slice(5); // "2026-05-01T09:00:00_5_58"
    const last = withoutPrefix.lastIndexOf('_');
    const secondLast = withoutPrefix.lastIndexOf('_', last - 1);
    const dateTime = withoutPrefix.substring(0, secondLast);
    const staffId = withoutPrefix.substring(secondLast + 1, last);
    const sessionTypeId = withoutPrefix.substring(last + 1);
    return `${title} [slot: dateTime=${dateTime} staffId=${staffId} sessionTypeId=${sessionTypeId}]`;
  }

  // Service / sub-option selection (svc_finn, svc_87, svc_ir, svc_oxy30, etc.)
  if (id.startsWith('svc_')) {
    const entry = _catalog.byGroupId[id];
    if (entry) {
      // Sub-option selected (has _subOption): resolve to specific session type IDs
      if (entry._subOption) {
        const sub = entry._subOption;
        const ids = sub.sessionTypeIds.join(',');
        return `${sub.label} [sessionTypeIds=${ids}]`;
      }
      // Parent group selected: tell AI what it is and whether it has sub-options
      const ids = entry.sessionTypeIds.join(',');
      if (entry.subOptions) {
        const opts = entry.subOptions.map(s => `{id:${s.id},label:"${s.label}",desc:"${s.desc || ''}",ids:${s.sessionTypeIds.join(',')}}`).join(', ');
        return `${entry.display} [subOptions: ${opts}]`;
      }
      return `${entry.display} [sessionTypeIds=${ids}]`;
    }
    // Legacy numeric fallback
    const sessionTypeId = id.slice(4);
    return `${title || id} [sessionTypeId=${sessionTypeId}]`;
  }
  if (id.startsWith('service_')) {
    return `${title} [sessionTypeId=${id.slice(8)}]`;
  }

  // Cancel appointment selection
  if (id.startsWith('cancel_apt_')) {
    return `Cancel appointment ${id.slice(11)} (${title})`;
  }

  // Reschedule appointment selection
  if (id.startsWith('reschedule_apt_')) {
    return `Reschedule appointment ${id.slice(15)} (${title})`;
  }

  // Old time selection format (legacy)
  if (id.startsWith('time_')) {
    const parts = id.slice(5).split('_');
    const dateTime = parts[0];
    const staffId = parts[1] || '0';
    const sessionTypeId = parts[2] || '0';
    return `${title} [slot: dateTime=${dateTime} staffId=${staffId} sessionTypeId=${sessionTypeId}]`;
  }

  const MAP = {
    menu_book: 'I want to book an appointment',
    menu_appointments: 'Show my upcoming appointments',
    menu_info: 'I want information',
    confirm_yes: 'Yes, confirm',
    confirm_no: 'No, cancel',
    cancel_confirm: 'Yes, cancel the appointment',
    cancel_no: 'No, keep the appointment',
    cancel_all: 'Cancel all my appointments',
    date_week: 'This week',
    date_nextweek: 'Next week',
    cat_tech: 'Tech Treatments',
    cat_massages: 'Massages',
    cat_traditional: 'Massages', // legacy
    cat_classes: 'Classes',
    info_other: 'I have another question',
  };
  if (MAP[id]) return MAP[id];
  if (id.startsWith('cat_')) return `Show ${id.slice(4)} treatments`;
  if (id.startsWith('info_')) return `Tell me about ${id.slice(5)}`;
  if (id.startsWith('date_')) return `Date: ${id.slice(5)}`;
  if (id.startsWith('cancel_all')) return 'Cancel all my appointments';

  return title || id;
}

module.exports = { decodeInput };
