const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const OWED_BLOCK = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  const t = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return t[m - 1];
}

// Converts a valid date string to a UTC day number; returns null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  return Math.round(dt.getTime() / 86400000);
}

function formatDate(dayNum) {
  const dt = new Date(dayNum * 86400000);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function readArgs(args, fields) {
  try {
    if (typeof args !== 'object' || args === null) return null;
    const out = {};
    for (const f of fields) out[f] = args[f];
    return out;
  } catch {
    return null;
  }
}

const FAIL = () => ({ ok: false });

export function createLibrary() {
  const books = new Map(); // bookId -> { loan: memberId|null, queue: [memberId], readyUntil: number|null }
  const members = new Map(); // memberId -> { loans: [{bookId, due, renewals}], owed, holds: [bookId] }
  let current = null;

  function removeHoldFromMember(memberId, bookId) {
    const m = members.get(memberId);
    const i = m.holds.indexOf(bookId);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function processExpiry(day) {
    for (const [bookId, b] of books) {
      while (b.loan === null && b.queue.length > 0 && day > b.readyUntil) {
        const expired = b.queue.shift();
        removeHoldFromMember(expired, bookId);
        if (b.queue.length > 0) {
          b.readyUntil = b.readyUntil + 1 + PICKUP_DAYS;
        } else {
          b.readyUntil = null;
        }
      }
    }
  }

  // Validates date, enforces clock, advances it, and runs expiry. Returns day number or null.
  function tick(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    processExpiry(day);
    return day;
  }

  function isSetAside(b) {
    return b.loan === null && b.queue.length > 0;
  }

  function findLoan(m, bookId) {
    return m.loans.find((l) => l.bookId === bookId) || null;
  }

  return {
    addBook(args) {
      const a = readArgs(args, ['bookId']);
      if (!a || !isId(a.bookId) || books.has(a.bookId)) return FAIL();
      books.set(a.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      const a = readArgs(args, ['memberId']);
      if (!a || !isId(a.memberId) || members.has(a.memberId)) return FAIL();
      members.set(a.memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },

    borrow(args) {
      const a = readArgs(args, ['memberId', 'bookId', 'date']);
      if (!a) return FAIL();
      const day = tick(a.date);
      if (day === null) return FAIL();
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL();
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return FAIL();
      if (b.loan !== null) return FAIL();
      const setAside = isSetAside(b);
      if (setAside && b.queue[0] !== a.memberId) return FAIL();
      if (m.loans.length >= MAX_LOANS) return FAIL();
      if (m.loans.some((l) => l.due < day)) return FAIL();
      if (m.owed >= OWED_BLOCK) return FAIL();
      const due = day + LOAN_DAYS;
      if (setAside) {
        b.queue.shift();
        removeHoldFromMember(a.memberId, a.bookId);
        b.readyUntil = null;
      }
      b.loan = a.memberId;
      m.loans.push({ bookId: a.bookId, due, renewals: 0 });
      return { ok: true, dueDate: formatDate(due) };
    },

    returnBook(args) {
      const a = readArgs(args, ['memberId', 'bookId', 'date']);
      if (!a) return FAIL();
      const day = tick(a.date);
      if (day === null) return FAIL();
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL();
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return FAIL();
      if (b.loan !== a.memberId) return FAIL();
      const loan = findLoan(m, a.bookId);
      if (!loan) return FAIL();
      const daysLate = Math.max(0, day - loan.due);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
      m.owed += fine;
      m.loans.splice(m.loans.indexOf(loan), 1);
      b.loan = null;
      b.readyUntil = b.queue.length > 0 ? day + PICKUP_DAYS : null;
      return { ok: true, fine };
    },

    renew(args) {
      const a = readArgs(args, ['memberId', 'bookId', 'date']);
      if (!a) return FAIL();
      const day = tick(a.date);
      if (day === null) return FAIL();
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL();
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return FAIL();
      if (b.loan !== a.memberId) return FAIL();
      const loan = findLoan(m, a.bookId);
      if (!loan) return FAIL();
      if (loan.renewals >= MAX_RENEWALS) return FAIL();
      if (day > loan.due) return FAIL();
      if (b.queue.length > 0) return FAIL();
      const newDue = Math.max(loan.due, day + RENEW_DAYS);
      loan.due = newDue;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(newDue) };
    },

    placeHold(args) {
      const a = readArgs(args, ['memberId', 'bookId', 'date']);
      if (!a) return FAIL();
      const day = tick(a.date);
      if (day === null) return FAIL();
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL();
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return FAIL();
      if (b.loan === null && b.queue.length === 0) return FAIL();
      if (b.loan === a.memberId) return FAIL();
      if (b.queue.includes(a.memberId)) return FAIL();
      if (m.holds.length >= MAX_HOLDS) return FAIL();
      b.queue.push(a.memberId);
      m.holds.push(a.bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      const a = readArgs(args, ['memberId', 'amount', 'date']);
      if (!a) return FAIL();
      const day = tick(a.date);
      if (day === null) return FAIL();
      if (!isId(a.memberId)) return FAIL();
      const m = members.get(a.memberId);
      if (!m) return FAIL();
      if (typeof a.amount !== 'number' || !Number.isSafeInteger(a.amount) || a.amount <= 0) return FAIL();
      if (a.amount > m.owed) return FAIL();
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const a = readArgs(args, ['memberId', 'date']);
      if (!a) return FAIL();
      const day = tick(a.date);
      if (day === null) return FAIL();
      if (!isId(a.memberId)) return FAIL();
      const m = members.get(a.memberId);
      if (!m) return FAIL();
      const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.due) }));
      const holds = m.holds.map((bookId) => {
        const b = books.get(bookId);
        const idx = b.queue.indexOf(a.memberId);
        const ready = isSetAside(b) && idx === 0;
        return {
          bookId,
          position: idx + 1,
          readyUntil: ready ? formatDate(b.readyUntil) : null,
        };
      });
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
