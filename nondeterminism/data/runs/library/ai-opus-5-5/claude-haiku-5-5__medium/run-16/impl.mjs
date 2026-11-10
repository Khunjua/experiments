const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_LATE_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

const MAX_DAY = (() => {
  const t = new Date(0);
  t.setUTCFullYear(9999, 11, 31);
  return Math.round(t.getTime() / DAY_MS);
})();

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY_MS);
}

function fmt(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function clamp(day) {
  return day > MAX_DAY ? MAX_DAY : day;
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isObj(a) {
  return a !== null && typeof a === 'object';
}

const fail = () => ({ ok: false });

export function createLibrary() {
  // bookId -> { loan: loanRecord | null, queue: [{ memberId, seq }], readyUntil: dayNumber | null }
  const books = new Map();
  // memberId -> { loans: [loanRecord in borrow order], owed: cents }
  const members = new Map();
  let current = null;
  let seq = 0;

  // Sets the clock and processes expiry. Returns the day number, or null if the date is invalid or too early.
  function begin(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    expire(day);
    return day;
  }

  function expire(day) {
    for (const b of books.values()) {
      while (b.loan === null && b.queue.length > 0 && day > b.readyUntil) {
        b.queue.shift();
        if (b.queue.length > 0) {
          b.readyUntil = clamp(b.readyUntil + 1 + PICKUP_DAYS);
        } else {
          b.readyUntil = null;
        }
      }
    }
  }

  function holdsOf(memberId) {
    const out = [];
    for (const [bookId, b] of books) {
      b.queue.forEach((h, index) => {
        if (h.memberId === memberId) {
          out.push({ bookId, b, index, seq: h.seq });
        }
      });
    }
    return out;
  }

  return {
    addBook(args) {
      if (!isObj(args) || !validId(args.bookId) || books.has(args.bookId)) return fail();
      books.set(args.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      if (!isObj(args) || !validId(args.memberId) || members.has(args.memberId)) return fail();
      members.set(args.memberId, { loans: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) return fail();
      const { memberId, bookId } = args;
      const day = begin(args.date);
      if (day === null) return fail();
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail();
      if (b.loan !== null) return fail();
      const aside = b.queue.length > 0;
      if (aside && b.queue[0].memberId !== memberId) return fail();
      if (m.loans.length >= MAX_LOANS) return fail();
      if (m.loans.some((l) => l.dueDay < day)) return fail();
      if (m.owed >= BORROW_BLOCK_OWED) return fail();

      const loan = { bookId, memberId, dueDay: clamp(day + LOAN_DAYS), renewals: 0 };
      if (aside) b.queue.shift();
      b.loan = loan;
      b.readyUntil = null;
      m.loans.push(loan);
      return { ok: true, dueDate: fmt(loan.dueDay) };
    },

    returnBook(args) {
      if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) return fail();
      const { memberId, bookId } = args;
      const day = begin(args.date);
      if (day === null) return fail();
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || b.loan === null || b.loan.memberId !== memberId) return fail();

      const loan = b.loan;
      const daysLate = Math.max(0, day - loan.dueDay);
      const fine = Math.min(MAX_FINE, FINE_PER_LATE_DAY * Math.max(0, daysLate - GRACE_DAYS));
      m.owed += fine;
      m.loans.splice(m.loans.indexOf(loan), 1);
      b.loan = null;
      if (b.queue.length > 0) {
        b.readyUntil = clamp(day + PICKUP_DAYS);
      } else {
        b.readyUntil = null;
      }
      return { ok: true, fine };
    },

    renew(args) {
      if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) return fail();
      const { memberId, bookId } = args;
      const day = begin(args.date);
      if (day === null) return fail();
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || b.loan === null || b.loan.memberId !== memberId) return fail();

      const loan = b.loan;
      if (loan.renewals >= MAX_RENEWALS) return fail();
      if (day > loan.dueDay) return fail();
      if (b.queue.length > 0) return fail();

      loan.dueDay = clamp(day + LOAN_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: fmt(loan.dueDay) };
    },

    placeHold(args) {
      if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) return fail();
      const { memberId, bookId } = args;
      const day = begin(args.date);
      if (day === null) return fail();
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail();
      if (b.loan === null && b.queue.length === 0) return fail();
      if (b.loan !== null && b.loan.memberId === memberId) return fail();
      if (b.queue.some((h) => h.memberId === memberId)) return fail();
      if (holdsOf(memberId).length >= MAX_HOLDS) return fail();

      b.queue.push({ memberId, seq: ++seq });
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      if (!isObj(args) || !validId(args.memberId)) return fail();
      const { memberId, amount } = args;
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail();
      const day = begin(args.date);
      if (day === null) return fail();
      const m = members.get(memberId);
      if (!m) return fail();
      if (amount > m.owed) return fail();
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      if (!isObj(args) || !validId(args.memberId)) return fail();
      const { memberId } = args;
      const day = begin(args.date);
      if (day === null) return fail();
      const m = members.get(memberId);
      if (!m) return fail();

      const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: fmt(l.dueDay) }));
      const holds = holdsOf(memberId)
        .sort((x, y) => x.seq - y.seq)
        .map((h) => ({
          bookId: h.bookId,
          position: h.index + 1,
          readyUntil: h.index === 0 && h.b.loan === null ? fmt(h.b.readyUntil) : null,
        }));

      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
