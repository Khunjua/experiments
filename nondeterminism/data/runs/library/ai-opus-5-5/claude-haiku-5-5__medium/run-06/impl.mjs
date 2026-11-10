const DAY_MS = 86400000;
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

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
function parseDay(s) {
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

const MAX_DAY = parseDay('9999-12-31');

function fmtDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(n, k) {
  return Math.min(n + k, MAX_DAY);
}

function argsOf(a) {
  return a !== null && typeof a === 'object' ? a : {};
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

function fail() {
  return { ok: false };
}

export function createLibrary() {
  // bookId -> { loanedTo: memberId|null, queue: [{ memberId, seq }], readyUntil: day|null }
  const books = new Map();
  // memberId -> { owed: cents, loans: Map(bookId -> { dueDay, renewals }) }
  const members = new Map();
  let current = null;
  let holdSeq = 0;

  // Pure date check: returns day number, or null if invalid or earlier than current date.
  function checkDate(s) {
    const day = parseDay(s);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    return day;
  }

  // Advances the clock and processes hold expiries up to and including day.
  function advance(day) {
    current = day;
    expire(day);
  }

  function expire(day) {
    for (const book of books.values()) {
      if (book.loanedTo !== null) continue;
      while (book.queue.length > 0 && book.readyUntil !== null && day > book.readyUntil) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = addDays(book.readyUntil, 1 + PICKUP_DAYS);
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  function countActiveHolds(memberId) {
    let n = 0;
    for (const book of books.values()) {
      for (const entry of book.queue) {
        if (entry.memberId === memberId) n++;
      }
    }
    return n;
  }

  function addBook(args) {
    const a = argsOf(args);
    if (!validId(a.bookId) || books.has(a.bookId)) return fail();
    books.set(a.bookId, { loanedTo: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    const a = argsOf(args);
    if (!validId(a.memberId) || members.has(a.memberId)) return fail();
    members.set(a.memberId, { owed: 0, loans: new Map() });
    return { ok: true };
  }

  function borrow(args) {
    const a = argsOf(args);
    if (!validId(a.memberId) || !validId(a.bookId)) return fail();
    const day = checkDate(a.date);
    if (day === null) return fail();
    advance(day);

    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail();
    if (b.loanedTo !== null) return fail();

    const asideForMe = b.queue.length > 0 && b.queue[0].memberId === a.memberId;
    if (b.queue.length > 0 && !asideForMe) return fail();
    if (m.loans.size >= MAX_LOANS) return fail();
    for (const loan of m.loans.values()) {
      if (loan.dueDay < day) return fail();
    }
    if (m.owed >= BLOCK_OWED) return fail();

    if (asideForMe) {
      b.queue.shift();
      b.readyUntil = null;
    }
    const dueDay = addDays(day, LOAN_DAYS);
    b.loanedTo = a.memberId;
    m.loans.set(a.bookId, { dueDay, renewals: 0 });
    return { ok: true, dueDate: fmtDay(dueDay) };
  }

  function returnBook(args) {
    const a = argsOf(args);
    if (!validId(a.memberId) || !validId(a.bookId)) return fail();
    const day = checkDate(a.date);
    if (day === null) return fail();
    advance(day);

    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail();
    const loan = m.loans.get(a.bookId);
    if (!loan || b.loanedTo !== a.memberId) return fail();

    const late = Math.max(0, day - loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
    m.owed += fine;
    m.loans.delete(a.bookId);
    b.loanedTo = null;
    if (b.queue.length === 0) {
      b.readyUntil = null;
    } else {
      b.readyUntil = addDays(day, PICKUP_DAYS);
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const a = argsOf(args);
    if (!validId(a.memberId) || !validId(a.bookId)) return fail();
    const day = checkDate(a.date);
    if (day === null) return fail();
    advance(day);

    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail();
    const loan = m.loans.get(a.bookId);
    if (!loan || b.loanedTo !== a.memberId) return fail();
    if (loan.renewals >= MAX_RENEWALS) return fail();
    if (day > loan.dueDay) return fail();
    if (b.queue.length > 0) return fail();

    loan.dueDay = addDays(day, RENEW_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: fmtDay(loan.dueDay) };
  }

  function placeHold(args) {
    const a = argsOf(args);
    if (!validId(a.memberId) || !validId(a.bookId)) return fail();
    const day = checkDate(a.date);
    if (day === null) return fail();
    advance(day);

    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail();
    if (b.loanedTo === null && b.queue.length === 0) return fail();
    if (b.loanedTo === a.memberId) return fail();
    if (b.queue.some((e) => e.memberId === a.memberId)) return fail();
    if (countActiveHolds(a.memberId) >= MAX_HOLDS) return fail();

    b.queue.push({ memberId: a.memberId, seq: ++holdSeq });
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    const a = argsOf(args);
    if (!validId(a.memberId)) return fail();
    if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return fail();
    const day = checkDate(a.date);
    if (day === null) return fail();
    advance(day);

    const m = members.get(a.memberId);
    if (!m) return fail();
    if (a.amount > m.owed) return fail();
    m.owed -= a.amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const a = argsOf(args);
    if (!validId(a.memberId)) return fail();
    const day = checkDate(a.date);
    if (day === null) return fail();
    advance(day);

    const m = members.get(a.memberId);
    if (!m) return fail();

    const loans = [];
    for (const [bookId, loan] of m.loans) {
      loans.push({ bookId, dueDate: fmtDay(loan.dueDay) });
    }

    const collected = [];
    for (const [bookId, b] of books) {
      b.queue.forEach((entry, idx) => {
        if (entry.memberId !== a.memberId) return;
        const setAside = idx === 0 && b.loanedTo === null;
        collected.push({
          seq: entry.seq,
          bookId,
          position: idx + 1,
          readyUntil: setAside ? fmtDay(b.readyUntil) : null,
        });
      });
    }
    collected.sort((x, y) => x.seq - y.seq);
    const holds = collected.map(({ bookId, position, readyUntil }) => ({
      bookId,
      position,
      readyUntil,
    }));

    return { ok: true, loans, owed: m.owed, holds };
  }

  return {
    addBook,
    addMember,
    borrow,
    returnBook,
    renew,
    placeHold,
    payFine,
    getMember,
  };
}
