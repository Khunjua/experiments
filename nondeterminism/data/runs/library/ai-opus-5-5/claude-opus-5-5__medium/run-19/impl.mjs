const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_RATE = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const OWED_BLOCK = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const MAX_DAY = toDayRaw(9999, 12, 31);

function toDayRaw(y, m, d) {
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  return Math.round(dt.getTime() / DAY_MS);
}

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || y > 9999 || mo < 1 || mo > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d > dim) return null;
  return toDayRaw(y, mo, d);
}

function formatDate(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function argObj(a) {
  return typeof a === 'object' && a !== null ? a : null;
}

const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  // book: { loan: { memberId, due, renewals } | null, queue: [memberId], readyUntil: dayNum | null }
  const books = new Map();
  // member: { loans: [bookId], holds: [bookId], owed }
  const members = new Map();
  let current = null;

  function removeMemberHold(memberId, bookId) {
    const mem = members.get(memberId);
    if (!mem) return;
    const i = mem.holds.indexOf(bookId);
    if (i >= 0) mem.holds.splice(i, 1);
  }

  function processExpiry(today) {
    for (const [bookId, book] of books) {
      while (book.loan === null && book.queue.length > 0 && book.readyUntil !== null && today > book.readyUntil) {
        const expired = book.queue.shift();
        removeMemberHold(expired, bookId);
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns day number or null (failure). Advances clock and processes expiry when date valid and not in the past.
  function startDated(a) {
    if (!a) return null;
    const day = parseDate(a.date);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    processExpiry(day);
    return day;
  }

  function isSetAside(book) {
    return book.loan === null && book.queue.length > 0;
  }

  return {
    addBook(args) {
      const a = argObj(args);
      if (!a || !isId(a.bookId)) return FAIL('invalid');
      if (books.has(a.bookId)) return FAIL('exists');
      books.set(a.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      const a = argObj(args);
      if (!a || !isId(a.memberId)) return FAIL('invalid');
      if (members.has(a.memberId)) return FAIL('exists');
      members.set(a.memberId, { loans: [], holds: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      const a = argObj(args);
      const day = startDated(a);
      if (day === null) return FAIL('invalid date');
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL('invalid');
      const mem = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!mem || !book) return FAIL('unknown');
      if (book.loan !== null) return FAIL('on loan');
      const setAside = isSetAside(book);
      if (setAside && book.queue[0] !== a.memberId) return FAIL('set aside for other');
      if (mem.loans.length >= MAX_LOANS) return FAIL('loan limit');
      for (const bid of mem.loans) {
        if (books.get(bid).loan.due < day) return FAIL('overdue');
      }
      if (mem.owed >= OWED_BLOCK) return FAIL('owes');
      const due = day + LOAN_DAYS;
      if (due > MAX_DAY) return FAIL('date range');
      if (setAside) {
        book.queue.shift();
        removeMemberHold(a.memberId, a.bookId);
        book.readyUntil = null;
      }
      book.loan = { memberId: a.memberId, due, renewals: 0 };
      mem.loans.push(a.bookId);
      return { ok: true, dueDate: formatDate(due) };
    },

    returnBook(args) {
      const a = argObj(args);
      const day = startDated(a);
      if (day === null) return FAIL('invalid date');
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL('invalid');
      const mem = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!mem || !book) return FAIL('unknown');
      if (book.loan === null || book.loan.memberId !== a.memberId) return FAIL('not on loan to member');
      const daysLate = Math.max(0, day - book.loan.due);
      const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
      mem.owed += fine;
      const i = mem.loans.indexOf(a.bookId);
      if (i >= 0) mem.loans.splice(i, 1);
      book.loan = null;
      book.readyUntil = book.queue.length > 0 ? day + PICKUP_DAYS : null;
      return { ok: true, fine };
    },

    renew(args) {
      const a = argObj(args);
      const day = startDated(a);
      if (day === null) return FAIL('invalid date');
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL('invalid');
      const mem = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!mem || !book) return FAIL('unknown');
      if (book.loan === null || book.loan.memberId !== a.memberId) return FAIL('not on loan to member');
      if (book.loan.renewals >= MAX_RENEWALS) return FAIL('renewal limit');
      if (day > book.loan.due) return FAIL('overdue');
      if (book.queue.length > 0) return FAIL('holds exist');
      const due = day + RENEW_DAYS;
      if (due > MAX_DAY) return FAIL('date range');
      book.loan.due = due;
      book.loan.renewals += 1;
      return { ok: true, dueDate: formatDate(due) };
    },

    placeHold(args) {
      const a = argObj(args);
      const day = startDated(a);
      if (day === null) return FAIL('invalid date');
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL('invalid');
      const mem = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!mem || !book) return FAIL('unknown');
      if (book.loan === null && book.queue.length === 0) return FAIL('available');
      if (book.loan !== null && book.loan.memberId === a.memberId) return FAIL('own loan');
      if (book.queue.includes(a.memberId)) return FAIL('already held');
      if (mem.holds.length >= MAX_HOLDS) return FAIL('hold limit');
      book.queue.push(a.memberId);
      mem.holds.push(a.bookId);
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      const a = argObj(args);
      const day = startDated(a);
      if (day === null) return FAIL('invalid date');
      if (!isId(a.memberId)) return FAIL('invalid');
      const mem = members.get(a.memberId);
      if (!mem) return FAIL('unknown');
      const amt = a.amount;
      if (typeof amt !== 'number' || !Number.isSafeInteger(amt) || amt <= 0) return FAIL('invalid amount');
      if (amt > mem.owed) return FAIL('overpayment');
      mem.owed -= amt;
      return { ok: true, owed: mem.owed };
    },

    getMember(args) {
      const a = argObj(args);
      const day = startDated(a);
      if (day === null) return FAIL('invalid date');
      if (!isId(a.memberId)) return FAIL('invalid');
      const mem = members.get(a.memberId);
      if (!mem) return FAIL('unknown');
      const loans = mem.loans.map((bid) => ({
        bookId: bid,
        dueDate: formatDate(books.get(bid).loan.due),
      }));
      const holds = mem.holds.map((bid) => {
        const book = books.get(bid);
        const idx = book.queue.indexOf(a.memberId);
        const ready = idx === 0 && isSetAside(book) && book.readyUntil !== null;
        return {
          bookId: bid,
          position: idx + 1,
          readyUntil: ready ? formatDate(book.readyUntil) : null,
        };
      });
      return { ok: true, loans, owed: mem.owed, holds };
    },
  };
}
