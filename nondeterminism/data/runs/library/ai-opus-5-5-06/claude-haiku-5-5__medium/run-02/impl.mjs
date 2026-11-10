const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const RENEW_DAYS = 21;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 7;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function toDayNumber(y, m, d) {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / DAY_MS);
}

// Returns a day number (days since 1970-01-01, UTC-based) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return toDayNumber(y, m, d);
}

function formatDay(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isObj(a) {
  return a !== null && typeof a === 'object';
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function fail(reason) {
  return { ok: false, reason };
}

function guard(fn) {
  return (a) => {
    try {
      return fn(a);
    } catch {
      return fail('INVALID_INPUT');
    }
  };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { id, state: 'available'|'loan'|'set', loan, line }
  const members = new Map(); // memberId -> { id, owed, loans: Map<bookId, loan>, holds: Map<bookId, hold> }
  let clock = null;          // day number of latest dated call
  let seq = 0;

  // Puts a book on the shelf or sets it aside for the first hold in its line.
  function freeBook(book, day) {
    book.loan = null;
    if (book.line.length === 0) {
      book.state = 'available';
      return;
    }
    book.state = 'set';
    book.line[0].readyUntil = day + PICKUP_DAYS;
  }

  // Applies every set-aside expiration due on or before `day`.
  function advanceTo(day) {
    clock = day;
    for (const book of books.values()) {
      while (book.state === 'set' && book.line[0].readyUntil < day) {
        const expired = book.line.shift();
        members.get(expired.memberId).holds.delete(book.id);
        freeBook(book, expired.readyUntil + 1);
      }
    }
  }

  // Validates a dated call's date, enforces ordering, and runs catch-up.
  function timeStep(value) {
    const day = parseDate(value);
    if (day === null) return { reason: 'INVALID_INPUT' };
    if (clock !== null && day < clock) return { reason: 'DATE_OUT_OF_ORDER' };
    advanceTo(day);
    return { day };
  }

  function addBook(a) {
    if (!isObj(a) || !isId(a.bookId)) return fail('INVALID_INPUT');
    const bookId = a.bookId;
    if (books.has(bookId)) return fail('DUPLICATE');
    books.set(bookId, { id: bookId, state: 'available', loan: null, line: [] });
    return { ok: true };
  }

  function addMember(a) {
    if (!isObj(a) || !isId(a.memberId)) return fail('INVALID_INPUT');
    const memberId = a.memberId;
    if (members.has(memberId)) return fail('DUPLICATE');
    members.set(memberId, { id: memberId, owed: 0, loans: new Map(), holds: new Map() });
    return { ok: true };
  }

  function borrow(a) {
    if (!isObj(a)) return fail('INVALID_INPUT');
    const t = timeStep(a.date);
    if (t.reason) return fail(t.reason);
    const memberId = a.memberId;
    const bookId = a.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('INVALID_INPUT');
    const member = members.get(memberId);
    if (!member) return fail('NO_MEMBER');
    const book = books.get(bookId);
    if (!book) return fail('NO_BOOK');
    if (book.state === 'loan') return fail('NOT_AVAILABLE');

    let hold = null;
    if (book.state === 'set') {
      const first = book.line[0];
      if (first.memberId !== memberId) return fail('NOT_AVAILABLE');
      hold = first;
    }
    if (hold) {
      book.line.shift();
      member.holds.delete(bookId);
    }

    const dueDate = t.day + LOAN_DAYS;
    const loan = { memberId, bookId, dueDate, renewals: 0, seq: ++seq };
    book.loan = loan;
    book.state = 'loan';
    member.loans.set(bookId, loan);
    return { ok: true, dueDate: formatDay(dueDate) };
  }

  function placeHold(a) {
    if (!isObj(a)) return fail('INVALID_INPUT');
    const t = timeStep(a.date);
    if (t.reason) return fail(t.reason);
    const memberId = a.memberId;
    const bookId = a.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('INVALID_INPUT');
    const member = members.get(memberId);
    if (!member) return fail('NO_MEMBER');
    const book = books.get(bookId);
    if (!book) return fail('NO_BOOK');
    if (book.state === 'available') return fail('BOOK_AVAILABLE');
    if (book.loan && book.loan.memberId === memberId) return fail('ALREADY_BORROWED');
    if (member.holds.has(bookId)) return fail('ALREADY_HOLDING');

    const hold = { memberId, bookId, seq: ++seq, readyUntil: null };
    book.line.push(hold);
    member.holds.set(bookId, hold);
    return { ok: true, position: book.line.length };
  }

  function renew(a) {
    if (!isObj(a)) return fail('INVALID_INPUT');
    const t = timeStep(a.date);
    if (t.reason) return fail(t.reason);
    const memberId = a.memberId;
    const bookId = a.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('INVALID_INPUT');
    const member = members.get(memberId);
    if (!member) return fail('NO_MEMBER');
    const book = books.get(bookId);
    if (!book) return fail('NO_BOOK');
    if (!book.loan || book.loan.memberId !== memberId) return fail('NOT_ON_LOAN');

    const loan = book.loan;
    if (t.day > loan.dueDate) return fail('OVERDUE');
    if (loan.renewals >= MAX_RENEWALS) return fail('RENEWAL_LIMIT');
    if (book.line.length > 0) return fail('HAS_HOLDS');

    loan.dueDate = t.day + RENEW_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDay(loan.dueDate) };
  }

  function returnBook(a) {
    if (!isObj(a)) return fail('INVALID_INPUT');
    const t = timeStep(a.date);
    if (t.reason) return fail(t.reason);
    const memberId = a.memberId;
    const bookId = a.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('INVALID_INPUT');
    const member = members.get(memberId);
    if (!member) return fail('NO_MEMBER');
    const book = books.get(bookId);
    if (!book) return fail('NO_BOOK');
    if (!book.loan || book.loan.memberId !== memberId) return fail('NOT_ON_LOAN');

    const loan = book.loan;
    const lateDays = Math.max(0, t.day - loan.dueDate);
    const fine = Math.min(FINE_PER_DAY * lateDays, FINE_CAP);
    member.owed += fine;
    member.loans.delete(bookId);
    freeBook(book, t.day);
    return { ok: true, fine };
  }

  function payFine(a) {
    if (!isObj(a)) return fail('INVALID_INPUT');
    const t = timeStep(a.date);
    if (t.reason) return fail(t.reason);
    const memberId = a.memberId;
    if (!isId(memberId)) return fail('INVALID_INPUT');
    const amount = a.amount;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) {
      return fail('BAD_AMOUNT');
    }
    const member = members.get(memberId);
    if (!member) return fail('NO_MEMBER');
    if (amount > member.owed) return fail('BAD_AMOUNT');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(a) {
    if (!isObj(a)) return fail('INVALID_INPUT');
    const t = timeStep(a.date);
    if (t.reason) return fail(t.reason);
    const memberId = a.memberId;
    if (!isId(memberId)) return fail('INVALID_INPUT');
    const member = members.get(memberId);
    if (!member) return fail('NO_MEMBER');

    const loans = [...member.loans.values()]
      .sort((x, y) => x.seq - y.seq)
      .map((l) => ({ bookId: l.bookId, dueDate: formatDay(l.dueDate) }));

    const holds = [...member.holds.values()]
      .sort((x, y) => x.seq - y.seq)
      .map((h) => {
        const book = books.get(h.bookId);
        return {
          bookId: h.bookId,
          position: book.line.indexOf(h) + 1,
          readyUntil: h.readyUntil === null ? null : formatDay(h.readyUntil),
        };
      });

    return { loans, owed: member.owed, holds };
  }

  return {
    addBook: guard(addBook),
    addMember: guard(addMember),
    borrow: guard(borrow),
    returnBook: guard(returnBook),
    renew: guard(renew),
    placeHold: guard(placeHold),
    payFine: guard(payFine),
    getMember: guard(getMember),
  };
}
