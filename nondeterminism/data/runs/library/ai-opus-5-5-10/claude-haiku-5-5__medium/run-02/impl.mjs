const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE = 1000;
const DEBT_LIMIT = 1000;
const PICKUP_DAYS = 7;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  const table = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[m - 1];
}

// Returns whole-day number (days since 1970-01-01) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / DAY_MS);
}

function formatDate(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

function obj(x) {
  return x !== null && typeof x === 'object' ? x : null;
}

function fail(reason) {
  return { ok: false, reason };
}

function safe(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch {
      return { ok: false, reason: 'internal error' };
    }
  };
}

export function createLibrary() {
  // bookId -> { state: 'available' | 'loan' | 'setAside', queue: [{ memberId, seq }], holder, readyUntil }
  const books = new Map();
  // memberId -> { loans: [{ bookId, dueDay, renewals }], owed }
  const members = new Map();
  let lastDay = null;
  let holdSeq = 0;

  // Time processing (section 4). Runs for every book on each accepted call.
  function advanceClock(day) {
    lastDay = day;
    for (const book of books.values()) {
      while (book.state === 'setAside' && day > book.readyUntil) {
        book.queue.shift();
        const nextStart = book.readyUntil + 1;
        if (book.queue.length > 0) {
          book.readyUntil = nextStart + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.holder = null;
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns true if the call is accepted (date not earlier than lastDay).
  // Date must already be validated. Applies time processing when accepted.
  function accept(day) {
    if (lastDay !== null && day < lastDay) return false;
    advanceClock(day);
    return true;
  }

  const lib = {
    addBook: safe((input) => {
      const a = obj(input);
      if (!a || !validId(a.bookId)) return fail('invalid bookId');
      if (books.has(a.bookId)) return fail('book exists');
      books.set(a.bookId, {
        state: 'available',
        queue: [],
        holder: null,
        readyUntil: null,
      });
      return { ok: true };
    }),

    addMember: safe((input) => {
      const a = obj(input);
      if (!a || !validId(a.memberId)) return fail('invalid memberId');
      if (members.has(a.memberId)) return fail('member exists');
      members.set(a.memberId, { loans: [], owed: 0 });
      return { ok: true };
    }),

    borrow: safe((input) => {
      const a = obj(input);
      if (!a || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid arguments');
      const day = parseDate(a.date);
      if (day === null) return fail('invalid date');
      if (!accept(day)) return fail('date earlier than last date');

      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail('unknown member or book');
      if (b.state === 'loan') return fail('book on loan');
      if (b.state === 'setAside' && b.queue[0].memberId !== a.memberId) {
        return fail('book set aside for another member');
      }
      if (b.state === 'available' && b.queue.length > 0) return fail('inconsistent hold queue');
      if (m.owed >= DEBT_LIMIT) return fail('debt limit');
      if (m.loans.some((l) => day > l.dueDay)) return fail('overdue loan');
      if (m.loans.length >= MAX_LOANS) return fail('loan limit');

      const dueDay = day + LOAN_DAYS;
      m.loans.push({ bookId: a.bookId, dueDay, renewals: 0 });
      if (b.state === 'setAside') {
        b.queue.shift();
      }
      b.state = 'loan';
      b.holder = a.memberId;
      b.readyUntil = null;
      return { ok: true, dueDate: formatDate(dueDay) };
    }),

    returnBook: safe((input) => {
      const a = obj(input);
      if (!a || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid arguments');
      const day = parseDate(a.date);
      if (day === null) return fail('invalid date');
      if (!accept(day)) return fail('date earlier than last date');

      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail('unknown member or book');
      const idx = m.loans.findIndex((l) => l.bookId === a.bookId);
      if (idx < 0) return fail('not on loan to member');

      const loan = m.loans[idx];
      const late = Math.max(0, day - loan.dueDay);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
      m.owed += fine;
      m.loans.splice(idx, 1);

      if (b.queue.length > 0) {
        b.state = 'setAside';
        b.holder = null;
        b.readyUntil = day + PICKUP_DAYS;
      } else {
        b.state = 'available';
        b.holder = null;
        b.readyUntil = null;
      }
      return { ok: true, fine };
    }),

    renew: safe((input) => {
      const a = obj(input);
      if (!a || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid arguments');
      const day = parseDate(a.date);
      if (day === null) return fail('invalid date');
      if (!accept(day)) return fail('date earlier than last date');

      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail('unknown member or book');
      const loan = m.loans.find((l) => l.bookId === a.bookId);
      if (!loan) return fail('not on loan to member');
      if (day > loan.dueDay) return fail('loan overdue');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (b.queue.length > 0) return fail('book is wanted');
      if (m.owed >= DEBT_LIMIT) return fail('debt limit');

      loan.dueDay += LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(loan.dueDay) };
    }),

    placeHold: safe((input) => {
      const a = obj(input);
      if (!a || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid arguments');
      const day = parseDate(a.date);
      if (day === null) return fail('invalid date');
      if (!accept(day)) return fail('date earlier than last date');

      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail('unknown member or book');
      if (b.state === 'available') return fail('book is available');
      if (b.state === 'loan' && b.holder === a.memberId) return fail('already on loan to member');
      if (b.queue.some((e) => e.memberId === a.memberId)) return fail('hold exists');

      holdSeq += 1;
      b.queue.push({ memberId: a.memberId, seq: holdSeq });
      return { ok: true, position: b.queue.length };
    }),

    payFine: safe((input) => {
      const a = obj(input);
      if (!a || !validId(a.memberId)) return fail('invalid memberId');
      if (typeof a.amount !== 'number' || !Number.isInteger(a.amount)) return fail('invalid amount');
      const day = parseDate(a.date);
      if (day === null) return fail('invalid date');
      if (!accept(day)) return fail('date earlier than last date');

      const m = members.get(a.memberId);
      if (!m) return fail('unknown member');
      if (a.amount < 1) return fail('amount too small');
      if (a.amount > m.owed) return fail('overpayment');

      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    }),

    getMember: safe((input) => {
      const a = obj(input);
      if (!a || !validId(a.memberId)) return fail('invalid memberId');
      const day = parseDate(a.date);
      if (day === null) return fail('invalid date');
      if (!accept(day)) return fail('date earlier than last date');

      const m = members.get(a.memberId);
      if (!m) return fail('unknown member');

      const loans = m.loans.map((l) => ({
        bookId: l.bookId,
        dueDate: formatDate(l.dueDay),
      }));

      const found = [];
      for (const [bookId, b] of books) {
        b.queue.forEach((e, i) => {
          if (e.memberId === a.memberId) {
            found.push({
              seq: e.seq,
              bookId,
              position: i + 1,
              readyUntil:
                b.state === 'setAside' && i === 0 ? formatDate(b.readyUntil) : null,
            });
          }
        });
      }
      found.sort((x, y) => x.seq - y.seq);
      const holds = found.map((h) => ({
        bookId: h.bookId,
        position: h.position,
        readyUntil: h.readyUntil,
      }));

      return { loans, owed: m.owed, holds };
    }),
  };

  return lib;
}
