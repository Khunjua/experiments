const LOAN_DAYS = 21;
const RENEWAL_LIMIT = 2;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const BLOCK_OWED = 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86400000;

function parseDay(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(ms / MS_PER_DAY);
}

function isValidDate(s) {
  return parseDay(s) !== null;
}

function fromDay(n) {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDay(parseDay(s) + n);
}

function daysBetween(a, b) {
  return parseDay(b) - parseDay(a);
}

function isValidId(id) {
  return typeof id === 'string' && id.length > 0;
}

function computeFine(dueDate, returnDate) {
  const late = daysBetween(dueDate, returnDate);
  const chargeable = late - GRACE_DAYS;
  if (chargeable <= 0) return 0;
  return Math.min(FINE_CAP, chargeable * FINE_PER_DAY);
}

// Set a book aside for the next waiting member when the shelf is free,
// and drop set-aside holds whose pickup window has lapsed.
function settle(book, date) {
  if (book.loan) return;
  while (book.holds.length > 0 && book.holds[0].readyUntil !== null && book.holds[0].readyUntil < date) {
    book.holds.shift();
  }
  if (book.holds.length > 0 && book.holds[0].readyUntil === null) {
    book.holds[0].readyUntil = addDays(date, PICKUP_DAYS);
  }
}

export function createLibrary() {
  const members = new Map(); // memberId -> { owed }
  const books = new Map();   // bookId -> { loan: null | { memberId, dueDate, renewals }, holds: [{ memberId, readyUntil }] }

  function sweep(date) {
    for (const book of books.values()) settle(book, date);
  }

  function activeLoanCount(memberId) {
    let n = 0;
    for (const b of books.values()) if (b.loan && b.loan.memberId === memberId) n++;
    return n;
  }

  function activeHoldCount(memberId) {
    let n = 0;
    for (const b of books.values()) if (b.holds.some(h => h.memberId === memberId)) n++;
    return n;
  }

  return {
    addBook({ bookId } = {}) {
      if (!isValidId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, holds: [] });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!isValidId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      sweep(date);
      if (m.owed >= BLOCK_OWED) return { ok: false };
      if (activeLoanCount(memberId) >= MAX_LOANS) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.holds.length > 0) {
        const head = b.holds[0];
        if (head.memberId !== memberId || head.readyUntil === null) return { ok: false };
        b.holds.shift();
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      sweep(date);
      const fine = computeFine(b.loan.dueDate, date);
      m.owed += fine;
      b.loan = null;
      settle(b, date);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return { ok: false };
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      sweep(date);
      if (!b.loan) return { ok: false };
      if (b.loan.renewals >= RENEWAL_LIMIT) return { ok: false };
      if (b.holds.length > 0) return { ok: false };
      if (date > b.loan.dueDate) return { ok: false };
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (!isValidDate(date)) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      sweep(date);
      if (m.owed >= BLOCK_OWED) return { ok: false };
      if (activeHoldCount(memberId) >= MAX_HOLDS) return { ok: false };
      if (!b.loan && b.holds.length === 0) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.holds.some(h => h.memberId === memberId)) return { ok: false };
      b.holds.push({ memberId, readyUntil: null });
      return { ok: true, position: b.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      if (!isValidDate(date)) return { ok: false };
      const m = members.get(memberId);
      if (!m) return { ok: false };
      sweep(date);
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      const m = members.get(memberId);
      if (!isValidDate(date) || !m) return { loans: [], owed: 0, holds: [] };
      sweep(date);
      const loans = [];
      const holds = [];
      const ids = Array.from(books.keys()).sort();
      for (const bookId of ids) {
        const b = books.get(bookId);
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate });
        }
        const idx = b.holds.findIndex(h => h.memberId === memberId);
        if (idx >= 0) {
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: idx === 0 ? b.holds[0].readyUntil : null
          });
        }
      }
      return { loans, owed: m.owed, holds };
    }
  };
}
