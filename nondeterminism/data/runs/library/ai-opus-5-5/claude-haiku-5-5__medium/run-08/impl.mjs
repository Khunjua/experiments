const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_RATE = 25;
const GRACE_DAYS = 2;
const FINE_MAX = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
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

const isId = (v) => typeof v === 'string' && v.length > 0;
const isObj = (v) => typeof v === 'object' && v !== null;

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, queue: [hold] }
  const members = new Map(); // memberId -> { loans: Map(bookId -> loan), holds: [hold], owed }
  let current = null;
  let seq = 0;

  function readArgs(args, needBook) {
    if (!isObj(args)) return null;
    const memberId = args.memberId;
    if (!isId(memberId)) return null;
    let bookId;
    if (needBook) {
      bookId = args.bookId;
      if (!isId(bookId)) return null;
    }
    const day = parseDate(args.date);
    if (day === null) return null;
    return { memberId, bookId, day };
  }

  function removeMemberHold(hold) {
    const m = members.get(hold.memberId);
    if (!m) return;
    const i = m.holds.indexOf(hold);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function expire(day) {
    for (const book of books.values()) {
      while (!book.loan && book.queue.length > 0 && day > book.queue[0].readyUntil) {
        const expired = book.queue.shift();
        removeMemberHold(expired);
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = addDays(expired.readyUntil, PICKUP_DAYS + 1);
        }
      }
    }
  }

  function advanceClock(day) {
    if (current !== null && day < current) return false;
    current = day;
    expire(day);
    return true;
  }

  return {
    addBook(args) {
      if (!isObj(args)) return { ok: false };
      const bookId = args.bookId;
      if (!isId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember(args) {
      if (!isObj(args)) return { ok: false };
      const memberId = args.memberId;
      if (!isId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, { loans: new Map(), holds: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      const a = readArgs(args, true);
      if (!a || !advanceClock(a.day)) return { ok: false };
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan) return { ok: false };
      const front = b.queue[0];
      if (front && front.memberId !== a.memberId) return { ok: false };
      if (m.loans.size >= MAX_LOANS) return { ok: false };
      for (const loan of m.loans.values()) {
        if (loan.dueDay < a.day) return { ok: false };
      }
      if (m.owed >= BLOCK_OWED) return { ok: false };

      const due = addDays(a.day, LOAN_DAYS);
      if (front) {
        b.queue.shift();
        removeMemberHold(front);
      }
      const loan = { bookId: a.bookId, memberId: a.memberId, dueDay: due, renewals: 0, seq: ++seq };
      b.loan = loan;
      m.loans.set(a.bookId, loan);
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook(args) {
      const a = readArgs(args, true);
      if (!a || !advanceClock(a.day)) return { ok: false };
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return { ok: false };
      const loan = b.loan;
      if (!loan || loan.memberId !== a.memberId) return { ok: false };

      const late = Math.max(0, a.day - loan.dueDay);
      const fine = Math.min(FINE_MAX, FINE_RATE * Math.max(0, late - GRACE_DAYS));
      m.owed += fine;
      b.loan = null;
      m.loans.delete(a.bookId);
      if (b.queue.length > 0) {
        b.queue[0].readyUntil = addDays(a.day, PICKUP_DAYS);
      }
      return { ok: true, fine };
    },

    renew(args) {
      const a = readArgs(args, true);
      if (!a || !advanceClock(a.day)) return { ok: false };
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return { ok: false };
      const loan = b.loan;
      if (!loan || loan.memberId !== a.memberId) return { ok: false };
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (a.day > loan.dueDay) return { ok: false };
      if (b.queue.length > 0) return { ok: false };

      loan.dueDay = addDays(a.day, RENEW_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.dueDay) };
    },

    placeHold(args) {
      const a = readArgs(args, true);
      if (!a || !advanceClock(a.day)) return { ok: false };
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return { ok: false };
      if (!b.loan && b.queue.length === 0) return { ok: false };
      if (b.loan && b.loan.memberId === a.memberId) return { ok: false };
      if (b.queue.some((h) => h.memberId === a.memberId)) return { ok: false };
      if (m.holds.length >= MAX_HOLDS) return { ok: false };

      const hold = { bookId: a.bookId, memberId: a.memberId, readyUntil: null, seq: ++seq };
      b.queue.push(hold);
      m.holds.push(hold);
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      if (!isObj(args)) return { ok: false };
      const memberId = args.memberId;
      const amount = args.amount;
      if (!isId(memberId) || !Number.isSafeInteger(amount) || amount <= 0) return { ok: false };
      const day = parseDate(args.date);
      if (day === null || !advanceClock(day)) return { ok: false };
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (amount > m.owed) return { ok: false };
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const a = readArgs(args, false);
      if (!a || !advanceClock(a.day)) return { ok: false };
      const m = members.get(a.memberId);
      if (!m) return { ok: false };

      const loans = [...m.loans.values()]
        .sort((x, y) => x.seq - y.seq)
        .map((l) => ({ bookId: l.bookId, dueDate: formatDay(l.dueDay) }));

      const holds = m.holds.map((h) => {
        const b = books.get(h.bookId);
        return {
          bookId: h.bookId,
          position: b.queue.indexOf(h) + 1,
          readyUntil: h.readyUntil === null ? null : formatDay(h.readyUntil),
        };
      });

      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
