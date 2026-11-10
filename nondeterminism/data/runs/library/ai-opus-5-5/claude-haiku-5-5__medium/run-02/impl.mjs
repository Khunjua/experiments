const MS_PER_DAY = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail() {
  return { ok: false };
}

function isObj(v) {
  return v !== null && typeof v === 'object';
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function daysInMonth(y, m) {
  if (m === 2) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

// Returns the day number (days since 1970-01-01, UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDate(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function removeHold(member, bookId) {
  const i = member.holds.indexOf(bookId);
  if (i >= 0) member.holds.splice(i, 1);
}

// Validates the common fields of a dated call. Returns null if invalid.
function readCall(a, needBook) {
  if (!isObj(a) || !isId(a.memberId)) return null;
  if (needBook && !isId(a.bookId)) return null;
  const day = parseDate(a.date);
  if (day === null) return null;
  return { memberId: a.memberId, bookId: a.bookId, day };
}

export function createLibrary() {
  // bookId -> { loan: loanObj|null, queue: [memberId], readyUntil: dayNum|null }
  const books = new Map();
  // memberId -> { loans: [loanObj], owed: cents, holds: [bookId] }
  const members = new Map();
  // loanObj -> { memberId, bookId, dueDate: dayNum, renewals: n }
  let current = null;

  // Expires set-aside holds whose pickup window ended before `day`.
  function expire(day) {
    for (const [bookId, book] of books) {
      while (book.loan === null && book.queue.length > 0 && day > book.readyUntil) {
        const memberId = book.queue.shift();
        removeHold(members.get(memberId), bookId);
        book.readyUntil =
          book.queue.length === 0 ? null : book.readyUntil + 1 + PICKUP_DAYS;
      }
    }
  }

  // Moves the clock to `day` if it is not earlier than the current date.
  function advance(day) {
    if (current !== null && day < current) return false;
    current = day;
    expire(day);
    return true;
  }

  function addBook(a) {
    if (!isObj(a) || !isId(a.bookId) || books.has(a.bookId)) return fail();
    books.set(a.bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(a) {
    if (!isObj(a) || !isId(a.memberId) || members.has(a.memberId)) return fail();
    members.set(a.memberId, { loans: [], owed: 0, holds: [] });
    return { ok: true };
  }

  function borrow(a) {
    const c = readCall(a, true);
    if (!c || !advance(c.day)) return fail();
    const m = members.get(c.memberId);
    const b = books.get(c.bookId);
    if (!m || !b || b.loan !== null) return fail();
    const setAside = b.queue.length > 0;
    if (setAside && b.queue[0] !== c.memberId) return fail();
    if (m.loans.length >= MAX_LOANS) return fail();
    if (m.loans.some((l) => l.dueDate < c.day)) return fail();
    if (m.owed >= BLOCK_OWED) return fail();

    const loan = {
      memberId: c.memberId,
      bookId: c.bookId,
      dueDate: c.day + LOAN_DAYS,
      renewals: 0,
    };
    m.loans.push(loan);
    b.loan = loan;
    if (setAside) {
      b.queue.shift();
      removeHold(m, c.bookId);
    }
    b.readyUntil = null;
    return { ok: true, dueDate: formatDate(loan.dueDate) };
  }

  function returnBook(a) {
    const c = readCall(a, true);
    if (!c || !advance(c.day)) return fail();
    const m = members.get(c.memberId);
    const b = books.get(c.bookId);
    if (!m || !b || b.loan === null || b.loan.memberId !== c.memberId) return fail();

    const loan = b.loan;
    const daysLate = Math.max(0, c.day - loan.dueDate);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
    m.owed += fine;
    const i = m.loans.indexOf(loan);
    if (i >= 0) m.loans.splice(i, 1);
    b.loan = null;
    if (b.queue.length === 0) {
      b.readyUntil = null;
    } else {
      b.readyUntil = c.day + PICKUP_DAYS;
    }
    return { ok: true, fine };
  }

  function renew(a) {
    const c = readCall(a, true);
    if (!c || !advance(c.day)) return fail();
    const b = books.get(c.bookId);
    const m = members.get(c.memberId);
    if (!m || !b || b.loan === null || b.loan.memberId !== c.memberId) return fail();

    const loan = b.loan;
    if (loan.renewals >= MAX_RENEWALS) return fail();
    if (c.day > loan.dueDate) return fail();
    if (b.queue.length > 0) return fail();

    loan.dueDate = c.day + RENEWAL_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDate) };
  }

  function placeHold(a) {
    const c = readCall(a, true);
    if (!c || !advance(c.day)) return fail();
    const m = members.get(c.memberId);
    const b = books.get(c.bookId);
    if (!m || !b) return fail();
    if (b.loan === null && b.queue.length === 0) return fail();
    if (b.loan !== null && b.loan.memberId === c.memberId) return fail();
    if (m.holds.includes(c.bookId)) return fail();
    if (m.holds.length >= MAX_HOLDS) return fail();

    b.queue.push(c.memberId);
    m.holds.push(c.bookId);
    return { ok: true, position: b.queue.length };
  }

  function payFine(a) {
    const c = readCall(a, false);
    if (!c || !Number.isSafeInteger(a.amount) || a.amount <= 0) return fail();
    if (!advance(c.day)) return fail();
    const m = members.get(c.memberId);
    if (!m || a.amount > m.owed) return fail();
    m.owed -= a.amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(a) {
    const c = readCall(a, false);
    if (!c || !advance(c.day)) return fail();
    const m = members.get(c.memberId);
    if (!m) return fail();

    return {
      ok: true,
      loans: m.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.dueDate) })),
      owed: m.owed,
      holds: m.holds.map((bookId) => {
        const b = books.get(bookId);
        const position = b.queue.indexOf(c.memberId) + 1;
        const setAside = b.loan === null && b.queue[0] === c.memberId;
        return {
          bookId,
          position,
          readyUntil: setAside ? formatDate(b.readyUntil) : null,
        };
      }),
    };
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
