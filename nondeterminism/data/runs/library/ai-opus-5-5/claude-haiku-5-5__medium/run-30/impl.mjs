const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / DAY_MS);
}

function formatDay(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const MAX_DAY = parseDate('9999-12-31');

function addDays(n, k) {
  return Math.min(n + k, MAX_DAY);
}

function fields(a) {
  return a !== null && typeof a === 'object' ? a : {};
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

function validAmount(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function removeHold(m, bookId) {
  const i = m.holds.indexOf(bookId);
  if (i >= 0) m.holds.splice(i, 1);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, holds: [memberId], readyUntil }
  const members = new Map(); // memberId -> { loans: [{ bookId, dueDay, renewals }], owed, holds: [bookId] }
  let current = null;        // current day number, or null if unset

  function processExpiry() {
    for (const [bookId, b] of books) {
      while (
        b.loan === null &&
        b.holds.length > 0 &&
        b.readyUntil !== null &&
        current > b.readyUntil
      ) {
        const who = b.holds.shift();
        const m = members.get(who);
        if (m) removeHold(m, bookId);
        if (b.holds.length === 0) {
          b.readyUntil = null;
        } else {
          b.readyUntil = addDays(b.readyUntil, 1 + PICKUP_DAYS);
        }
      }
    }
  }

  // Validates the date, enforces ordering, advances the clock and processes expiry.
  // Returns the day number, or null if the date is invalid or earlier than current.
  function clock(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    processExpiry();
    return day;
  }

  return {
    addBook(args) {
      const a = fields(args);
      if (!validId(a.bookId) || books.has(a.bookId)) return { ok: false };
      books.set(a.bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      const a = fields(args);
      if (!validId(a.memberId) || members.has(a.memberId)) return { ok: false };
      members.set(a.memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },

    borrow(args) {
      const a = fields(args);
      if (!validId(a.memberId) || !validId(a.bookId)) return { ok: false };
      const day = clock(a.date);
      if (day === null) return { ok: false };
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan !== null) return { ok: false };
      const aside = b.holds.length > 0;
      const forMe = aside && b.holds[0] === a.memberId;
      if (aside && !forMe) return { ok: false };
      if (m.loans.length >= MAX_LOANS) return { ok: false };
      if (m.loans.some((l) => l.dueDay < day)) return { ok: false };
      if (m.owed >= BLOCK_OWED) return { ok: false };
      const due = addDays(day, LOAN_DAYS);
      m.loans.push({ bookId: a.bookId, dueDay: due, renewals: 0 });
      b.loan = a.memberId;
      if (forMe) {
        b.holds.shift();
        removeHold(m, a.bookId);
        b.readyUntil = null;
      }
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook(args) {
      const a = fields(args);
      if (!validId(a.memberId) || !validId(a.bookId)) return { ok: false };
      const day = clock(a.date);
      if (day === null) return { ok: false };
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan !== a.memberId) return { ok: false };
      const idx = m.loans.findIndex((l) => l.bookId === a.bookId);
      if (idx < 0) return { ok: false };
      const loan = m.loans[idx];
      const late = Math.max(0, day - loan.dueDay);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
      m.owed += fine;
      m.loans.splice(idx, 1);
      b.loan = null;
      if (b.holds.length === 0) {
        b.readyUntil = null;
      } else {
        b.readyUntil = addDays(day, PICKUP_DAYS);
      }
      return { ok: true, fine };
    },

    renew(args) {
      const a = fields(args);
      if (!validId(a.memberId) || !validId(a.bookId)) return { ok: false };
      const day = clock(a.date);
      if (day === null) return { ok: false };
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan !== a.memberId) return { ok: false };
      const loan = m.loans.find((l) => l.bookId === a.bookId);
      if (!loan) return { ok: false };
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (day > loan.dueDay) return { ok: false };
      if (b.holds.length > 0) return { ok: false };
      loan.dueDay = addDays(day, RENEW_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.dueDay) };
    },

    placeHold(args) {
      const a = fields(args);
      if (!validId(a.memberId) || !validId(a.bookId)) return { ok: false };
      const day = clock(a.date);
      if (day === null) return { ok: false };
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan === null && b.holds.length === 0) return { ok: false };
      if (b.loan === a.memberId) return { ok: false };
      if (m.holds.includes(a.bookId)) return { ok: false };
      if (m.holds.length >= MAX_HOLDS) return { ok: false };
      b.holds.push(a.memberId);
      m.holds.push(a.bookId);
      return { ok: true, position: b.holds.length };
    },

    payFine(args) {
      const a = fields(args);
      if (!validId(a.memberId) || !validAmount(a.amount)) return { ok: false };
      const day = clock(a.date);
      if (day === null) return { ok: false };
      const m = members.get(a.memberId);
      if (!m) return { ok: false };
      if (a.amount > m.owed) return { ok: false };
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const a = fields(args);
      if (!validId(a.memberId)) return { ok: false };
      const day = clock(a.date);
      if (day === null) return { ok: false };
      const m = members.get(a.memberId);
      if (!m) return { ok: false };
      const loans = m.loans.map((l) => ({
        bookId: l.bookId,
        dueDate: formatDay(l.dueDay),
      }));
      const holds = m.holds.map((bookId) => {
        const b = books.get(bookId);
        const position = b.holds.indexOf(a.memberId) + 1;
        const readyUntil =
          b.loan === null && b.holds[0] === a.memberId
            ? formatDay(b.readyUntil)
            : null;
        return { bookId, position, readyUntil };
      });
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
