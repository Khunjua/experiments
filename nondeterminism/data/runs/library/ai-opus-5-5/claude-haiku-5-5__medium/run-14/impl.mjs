const MS_PER_DAY = 86400000;
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateToDay(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / MS_PER_DAY);
}

const MAX_DAY = dateToDay('9999-12-31');

function dayToString(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(n, k) {
  return Math.min(n + k, MAX_DAY);
}

function isObj(x) {
  return typeof x === 'object' && x !== null;
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

export function createLibrary() {
  // bookId -> { id, queue: [memberId], loan: null | { memberId, dueDate, renewals }, readyUntil }
  const books = new Map();
  // memberId -> { loans: [bookId] (borrow order), holds: [bookId] (placement order), owed }
  const members = new Map();
  let clock = null;

  function expire(now) {
    for (const book of books.values()) {
      while (
        book.loan === null &&
        book.queue.length > 0 &&
        book.readyUntil !== null &&
        now > book.readyUntil
      ) {
        const expiredMember = book.queue.shift();
        const m = members.get(expiredMember);
        const idx = m.holds.indexOf(book.id);
        if (idx >= 0) m.holds.splice(idx, 1);
        if (book.queue.length > 0) {
          book.readyUntil = addDays(book.readyUntil, PICKUP_DAYS + 1);
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates a dated call's date, advances the clock and processes expiry.
  // Returns the day number, or null if the date is invalid or earlier than the clock.
  function advance(date) {
    const n = dateToDay(date);
    if (n === null) return null;
    if (clock !== null && n < clock) return null;
    clock = n;
    expire(n);
    return n;
  }

  return {
    addBook(args) {
      if (!isObj(args) || !isId(args.bookId) || books.has(args.bookId)) {
        return { ok: false };
      }
      books.set(args.bookId, { id: args.bookId, queue: [], loan: null, readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      if (!isObj(args) || !isId(args.memberId) || members.has(args.memberId)) {
        return { ok: false };
      }
      members.set(args.memberId, { loans: [], holds: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return { ok: false };
      const now = advance(args.date);
      if (now === null) return { ok: false };
      const memberId = args.memberId;
      const m = members.get(memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return { ok: false };

      if (b.loan !== null) return { ok: false };
      if (b.loan === null && b.queue.length > 0 && b.queue[0] !== memberId) {
        return { ok: false };
      }
      if (m.loans.length >= MAX_LOANS) return { ok: false };
      for (const bid of m.loans) {
        if (books.get(bid).loan.dueDate < now) return { ok: false };
      }
      if (m.owed >= BLOCK_OWED) return { ok: false };

      const fulfilling = b.queue.length > 0 && b.queue[0] === memberId;
      if (fulfilling) {
        b.queue.shift();
        b.readyUntil = null;
        const idx = m.holds.indexOf(b.id);
        if (idx >= 0) m.holds.splice(idx, 1);
      }

      const due = addDays(now, LOAN_DAYS);
      b.loan = { memberId, dueDate: due, renewals: 0 };
      m.loans.push(b.id);
      return { ok: true, dueDate: dayToString(due) };
    },

    returnBook(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return { ok: false };
      const now = advance(args.date);
      if (now === null) return { ok: false };
      const memberId = args.memberId;
      const m = members.get(memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan === null || b.loan.memberId !== memberId) return { ok: false };

      const daysLate = Math.max(0, now - b.loan.dueDate);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
      m.owed += fine;

      const idx = m.loans.indexOf(b.id);
      if (idx >= 0) m.loans.splice(idx, 1);
      b.loan = null;

      if (b.queue.length === 0) {
        b.readyUntil = null;
      } else {
        b.readyUntil = addDays(now, PICKUP_DAYS);
      }
      return { ok: true, fine };
    },

    renew(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return { ok: false };
      const now = advance(args.date);
      if (now === null) return { ok: false };
      const memberId = args.memberId;
      const m = members.get(memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan === null || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (now > b.loan.dueDate) return { ok: false };
      if (b.queue.length > 0) return { ok: false };

      const due = addDays(now, RENEW_DAYS);
      b.loan.dueDate = due;
      b.loan.renewals += 1;
      return { ok: true, dueDate: dayToString(due) };
    },

    placeHold(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return { ok: false };
      const now = advance(args.date);
      if (now === null) return { ok: false };
      const memberId = args.memberId;
      const m = members.get(memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return { ok: false };

      // Available: not on loan and nothing queued.
      if (b.loan === null && b.queue.length === 0) return { ok: false };
      if (b.loan !== null && b.loan.memberId === memberId) return { ok: false };
      if (m.holds.includes(b.id)) return { ok: false };
      if (m.holds.length >= MAX_HOLDS) return { ok: false };

      b.queue.push(memberId);
      m.holds.push(b.id);
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      if (
        !isObj(args) ||
        !isId(args.memberId) ||
        !Number.isSafeInteger(args.amount) ||
        args.amount <= 0
      ) {
        return { ok: false };
      }
      const now = advance(args.date);
      if (now === null) return { ok: false };
      const m = members.get(args.memberId);
      if (!m) return { ok: false };
      if (args.amount > m.owed) return { ok: false };

      m.owed -= args.amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      if (!isObj(args) || !isId(args.memberId)) return { ok: false };
      const now = advance(args.date);
      if (now === null) return { ok: false };
      const memberId = args.memberId;
      const m = members.get(memberId);
      if (!m) return { ok: false };

      const loans = m.loans.map((bid) => ({
        bookId: bid,
        dueDate: dayToString(books.get(bid).loan.dueDate),
      }));

      const holds = m.holds.map((bid) => {
        const b = books.get(bid);
        const position = b.queue.indexOf(memberId) + 1;
        const settedAside = b.loan === null && b.queue[0] === memberId;
        return {
          bookId: bid,
          position,
          readyUntil: settedAside ? dayToString(b.readyUntil) : null,
        };
      });

      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
