const DUTCH_DAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const DUTCH_MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

function formatDutchDate(dateStr) {
  const d = new Date(dateStr);
  const day = DUTCH_DAYS[d.getDay()];
  const num = d.getDate();
  const month = DUTCH_MONTHS[d.getMonth()];
  return `${day} ${num} ${month}`;
}

function formatDutchTime(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
}

function formatDateISO(date) {
  // Use local date components to avoid UTC timezone shift
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getNextWeekday(date, dayIndex) {
  const result = new Date(date);
  const currentDay = result.getDay();
  const daysUntil = (dayIndex - currentDay + 7) % 7 || 7;
  result.setDate(result.getDate() + daysUntil);
  return result;
}

/**
 * Parse Dutch/English free-text date input into { startDate, endDate } ISO strings.
 * Returns null if the input can't be parsed.
 */
function parseFreeTextDate(input) {
  const today = new Date();
  const text = input.toLowerCase().trim();

  if (text === 'vandaag' || text === 'today') {
    const d = formatDateISO(today);
    return { startDate: d, endDate: d };
  }
  if (text === 'morgen' || text === 'tomorrow') {
    const d = formatDateISO(addDays(today, 1));
    return { startDate: d, endDate: d };
  }
  if (text === 'overmorgen' || text === 'day after tomorrow') {
    const d = formatDateISO(addDays(today, 2));
    return { startDate: d, endDate: d };
  }
  if (text === 'deze week' || text === 'this week') {
    return { startDate: formatDateISO(today), endDate: formatDateISO(addDays(today, 7)) };
  }
  if (text === 'volgende week' || text === 'next week') {
    const nextMon = getNextWeekday(today, 1);
    return { startDate: formatDateISO(nextMon), endDate: formatDateISO(addDays(nextMon, 6)) };
  }
  if (text === 'dit weekend' || text === 'this weekend') {
    const sat = getNextWeekday(today, 6);
    return { startDate: formatDateISO(sat), endDate: formatDateISO(addDays(sat, 1)) };
  }

  // "Next week Monday", "volgende week maandag", etc.
  const ENGLISH_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const nextWeekMatch = text.match(/(?:volgende week|next week)\s*(maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|monday|tuesday|wednesday|thursday|friday|saturday|sunday)?/);
  if (nextWeekMatch) {
    const dayName = nextWeekMatch[1];
    if (dayName) {
      let dayIdx = DUTCH_DAYS.indexOf(dayName);
      if (dayIdx === -1) dayIdx = ENGLISH_DAYS.indexOf(dayName);
      if (dayIdx !== -1) {
        // Get that day in next week
        const nextMon = getNextWeekday(today, 1);
        const target = new Date(nextMon);
        const daysFromMon = (dayIdx - 1 + 7) % 7;
        target.setDate(nextMon.getDate() + daysFromMon);
        const d = formatDateISO(target);
        return { startDate: d, endDate: d };
      }
    }
    // Just "next week" without a day
    const nextMon = getNextWeekday(today, 1);
    return { startDate: formatDateISO(nextMon), endDate: formatDateISO(addDays(nextMon, 6)) };
  }

  // Try Dutch day names: "maandag", "dinsdag", etc.
  const dayIdx = DUTCH_DAYS.indexOf(text);
  if (dayIdx !== -1) {
    const d = formatDateISO(getNextWeekday(today, dayIdx));
    return { startDate: d, endDate: d };
  }

  // Try English day names: "monday", "tuesday", etc.
  const engDayIdx = ENGLISH_DAYS.indexOf(text);
  if (engDayIdx !== -1) {
    const d = formatDateISO(getNextWeekday(today, engDayIdx));
    return { startDate: d, endDate: d };
  }

  // Try ISO date format (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return { startDate: text, endDate: text };
  }

  // Try natural date formats: "5th of April", "April 5", "5 april", "5 maart", "march 5th", etc.
  const ENGLISH_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const ALL_MONTHS = [...DUTCH_MONTHS, ...ENGLISH_MONTHS];

  // "5th of April", "5 april", "5 maart", "15th of march"
  const dmMatch = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?(\w+)/);
  if (dmMatch) {
    const day = parseInt(dmMatch[1]);
    const monthName = dmMatch[2].toLowerCase();
    let monthIdx = DUTCH_MONTHS.indexOf(monthName);
    if (monthIdx === -1) monthIdx = ENGLISH_MONTHS.indexOf(monthName);
    if (monthIdx !== -1 && day >= 1 && day <= 31) {
      let year = today.getFullYear();
      const target = new Date(year, monthIdx, day);
      if (target < today) target.setFullYear(year + 1); // If date is in the past, use next year
      const d = formatDateISO(target);
      return { startDate: d, endDate: d };
    }
  }

  // "April 5", "March 15th", "april 5th"
  const mdMatch = text.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?/);
  if (mdMatch) {
    const monthName = mdMatch[1].toLowerCase();
    const day = parseInt(mdMatch[2]);
    let monthIdx = DUTCH_MONTHS.indexOf(monthName);
    if (monthIdx === -1) monthIdx = ENGLISH_MONTHS.indexOf(monthName);
    if (monthIdx !== -1 && day >= 1 && day <= 31) {
      let year = today.getFullYear();
      const target = new Date(year, monthIdx, day);
      if (target < today) target.setFullYear(year + 1);
      const d = formatDateISO(target);
      return { startDate: d, endDate: d };
    }
  }

  // "5/4", "5-4" (day/month format, European)
  const numMatch = text.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (numMatch) {
    const day = parseInt(numMatch[1]);
    const month = parseInt(numMatch[2]) - 1;
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      let year = today.getFullYear();
      const target = new Date(year, month, day);
      if (target < today) target.setFullYear(year + 1);
      const d = formatDateISO(target);
      return { startDate: d, endDate: d };
    }
  }

  return null;
}

module.exports = {
  formatDutchDate,
  formatDutchTime,
  formatDateISO,
  addDays,
  getNextWeekday,
  parseFreeTextDate,
  DUTCH_DAYS,
  DUTCH_MONTHS,
};
