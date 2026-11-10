const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const FINE_RATE = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function isObj(x) {
  return x !== null && typeof x === 'object';
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

// Returns a day number (days since 1970-01-01 UTC) or null.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(5, 7));
  const dy = Number(s.slice(8, 10));
  if (y < 1 || mo < 1 || mo > 12 || dy < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, dy);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== dy) {
    return null;
  }
  return Math.round(t.getTime() / DAY_MS);
}

function formatDate(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Validates argument shape without touching state.
function parseArgs(args, opts) {
  const book = !!(opts && opts.book);
  const amount = !!(opts && opts.amount);
  if (!isObj(args) || !isId(args.memberId)) return null;
  if (book && !isId(args.bookId)) return null;
  if (amount && !(Number.isSafeInteger(args.amount) && args.amount > 0)) return null;
  const day = parseDate(args.date);
  if (day === null) return null;
  return { memberId: args.memberId, bookId: args.bookId, amount: args.amount, day };
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDay, renewals } | null, queue: [memberId], readyDay: number | null }
  // When loan is null and queue is non-empty, the book is set aside for queue[0].
  const books = new Map();
  // memberId -> { owed: number, loans: [bookId] (borrow order), holds: [bookId] (placed order) }
  const members = new Map();
  let clock = null;

  function removeHoldRecord(memberId, bookId) {
    const m = members.get(memberId);
    if (!m) return;
    const i = m.holds.indexOf(bookId);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function expireHolds(day) {
    for (const [bookId, book] of books) {
      while (book.loan === null && book.queue.length > 0 && day > book.readyDay) {
        const memberId = book.queue.shift();
        removeHoldRecord(memberId, bookId);
        if (book.queue.length > 0) {
          book.readyDay = book.readyDay + 1 + PICKUP_DAYS;
        } else {
          book.readyDay = null;
        }
      }
    }
  }

  // Advances the clock and processes expiries. Returns false if the date is earlier.
  function advance(day) {
    if (clock !== null && day < clock) return false;
    clock = day;
    expireHolds(day);
    return true;
  }

  function begin(args, opts) {
    const p = parseArgs(args, opts);
    if (p === null || !advance(p.day)) return null;
    return p;
  }

  return {
    addBook(args) {
      if (!isObj(args) || !isId(args.bookId) || books.has(args.bookId)) {
        return { ok: false };
      }
      books.set(args.bookId, { loan: null, queue: [], readyDay: null });
      return { ok: true };
    },

    addMember(args) {
      if (!isObj(args) || !isId(args.memberId) || members.has(args.memberId)) {
        return { ok: false };
      }
      members.set(args.memberId, { owed: 0, loans: [], holds: [] });
      return { ok: true };
    },

    borrow(args) {
      const p = begin(args, { book: true });
      if (p === null) return { ok: false };
      const m = members.get(p.memberId);
      const b = books.get(p.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan !== null) return { ok: false };
      if (b.queue.length > 0 && b.queue[0] !== p.memberId) return { ok: false };
      if (m.loans.length >= MAX_LOANS) return { ok: false };
      for (const bid of m.loans) {
        if (books.get(bid).loan.dueDay < p.day) return { ok: false };
      }
      if (m.owed >= BLOCK_OWED) return { ok: false };

      const dueDay = p.day + LOAN_DAYS;
      if (b.queue.length > 0) {
        // Fulfils this member's set-aside hold; remaining holds keep their order.
        b.queue.shift();
        removeHoldRecord(p.memberId, p.bookId);
        b.readyDay = null;
      }
      b.loan = { memberId: p.memberId, dueDay, renewals: 0 };
      m.loans.push(p.bookId);
      return { ok: true, dueDate: formatDate(dueDay) };
    },

    returnBook(args) {
      const p = begin(args, { book: true });
      if (p === null) return { ok: false };
      const m = members.get(p.memberId);
      const b = books.get(p.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan === null || b.loan.memberId !== p.memberId) return { ok: false };

      const late = Math.max(0, p.day - b.loan.dueDay);
      const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, late - GRACE_DAYS));
      m.owed += fine;

      const idx = m.loans.indexOf(p.bookId);
      if (idx >= 0) m.loans.splice(idx, 1);
      b.loan = null;

      if (b.queue.length > 0) {
        b.readyDay = p.day + PICKUP_DAYS;
      } else {
        b.readyDay = null;
      }
      return { ok: true, fine };
    },

    renew(args) {
      const p = begin(args, { book: true });
      if (p === null) return { ok: false };
      const m = members.get(p.memberId);
      const b = books.get(p.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan === null || b.loan.memberId !== p.memberId) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (p.day > b.loan.dueDay) return { ok: false };
      if (b.queue.length > 0) return { ok: false };

      b.loan.dueDay = p.day + RENEWAL_DAYS;
      b.loan.renewals += 1;
      return { ok: true, dueDate: formatDate(b.loan.dueDay) };
    },

    placeHold(args) {
      const p = begin(args, { book: true });
      if (p === null) return { ok: false };
      const m = members.get(p.memberId);
      const b = books.get(p.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan === null && b.queue.length === 0) return { ok: false };
      if (b.loan !== null && b.loan.memberId === p.memberId) return { ok: false };
      if (b.queue.includes(p.memberId)) return { ok: false };
      if (m.holds.length >= MAX_HOLDS) return { ok: false };

      b.queue.push(p.memberId);
      m.holds.push(p.bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      const p = begin(args, { amount: true });
      if (p === null) return { ok: false };
      const m = members.get(p.memberId);
      if (!m) return { ok: false };
      if (p.amount > m.owed) return { ok: false };

      m.owed -= p.amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const p = begin(args, {});
      if (p === null) return { ok: false };
      const m = members.get(p.memberId);
      if (!m) return { ok: false };

      const loans = m.loans.map((bid) => ({
        bookId: bid,
        dueDate: formatDate(books.get(bid).loan.dueDay),
      }));

      const holds = m.holds.map((bid) => {
        const b = books.get(bid);
        const position = b.queue.indexOf(p.memberId) + 1;
        const readyUntil =
          b.loan === null && position === 1 ? formatDate(b.readyDay) : null;
        return { bookId: bid, position, readyUntil };
      });

      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
