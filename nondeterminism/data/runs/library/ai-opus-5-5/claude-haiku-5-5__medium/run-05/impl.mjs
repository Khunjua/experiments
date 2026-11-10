const LOAN_DAYS = 21;
const RENEWAL_LIMIT = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

const AVAILABLE = 'available';
const LOAN = 'loan';
const SET_ASIDE = 'set';

const MAX_DAY_NUMBER = 0; // initialised below

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Day number: days since 1970-01-01 (proleptic Gregorian, UTC-style, no time zones).
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function dayToString(z) {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  let y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y += 1;
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// Returns a day number, or null if the string is not a valid date.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

const MAX_DAY = daysFromCivil(9999, 12, 31);

function addDays(day, n) {
  return Math.min(day + n, MAX_DAY);
}

function isObject(v) {
  return v !== null && typeof v === 'object';
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

// Validates an argument object. Returns parsed fields, or null on any invalid input.
function parseArgs(a, opts) {
  if (!isObject(a)) return null;
  const out = {};
  if (opts.member) {
    if (!isId(a.memberId)) return null;
    out.memberId = a.memberId;
  }
  if (opts.book) {
    if (!isId(a.bookId)) return null;
    out.bookId = a.bookId;
  }
  if (opts.amount) {
    if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return null;
    out.amount = a.amount;
  }
  if (opts.date) {
    const d = parseDate(a.date);
    if (d === null) return null;
    out.date = d;
  }
  return out;
}

const fail = () => ({ ok: false });

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let now = null;

  // Hold expiry (§7.4), run for every book as of the current date.
  function expire() {
    for (const book of books.values()) {
      while (book.state === SET_ASIDE && now > book.readyDay) {
        const gone = book.queue.shift();
        members.get(gone).holds.delete(book.id);
        if (book.queue.length === 0) {
          book.state = AVAILABLE;
          book.readyDay = null;
        } else {
          book.readyDay = addDays(book.readyDay, PICKUP_DAYS + 1);
        }
      }
    }
  }

  // Advances the clock. Returns false if the date is earlier than the current date.
  function advance(day) {
    if (now !== null && day < now) return false;
    now = day;
    expire();
    return true;
  }

  function addBook(a) {
    const p = parseArgs(a, { book: true });
    if (!p || books.has(p.bookId)) return fail();
    books.set(p.bookId, { id: p.bookId, state: AVAILABLE, loan: null, queue: [], readyDay: null });
    return { ok: true };
  }

  function addMember(a) {
    const p = parseArgs(a, { member: true });
    if (!p || members.has(p.memberId)) return fail();
    members.set(p.memberId, { id: p.memberId, owed: 0, loans: new Map(), holds: new Set() });
    return { ok: true };
  }

  function borrow(a) {
    const p = parseArgs(a, { member: true, book: true, date: true });
    if (!p || !advance(p.date)) return fail();
    const m = members.get(p.memberId);
    const b = books.get(p.bookId);
    if (!m || !b) return fail();
    if (b.state === LOAN) return fail();
    if (b.state === SET_ASIDE && b.queue[0] !== m.id) return fail();
    if (m.loans.size >= MAX_LOANS) return fail();
    for (const l of m.loans.values()) {
      if (l.dueDay < now) return fail();
    }
    if (m.owed >= BORROW_BLOCK_OWED) return fail();

    const loan = { memberId: m.id, bookId: b.id, dueDay: addDays(now, LOAN_DAYS), renewals: 0 };
    m.loans.set(b.id, loan);
    if (b.state === SET_ASIDE) {
      b.queue.shift();
      m.holds.delete(b.id);
      b.readyDay = null;
    }
    b.state = LOAN;
    b.loan = loan;
    return { ok: true, dueDate: dayToString(loan.dueDay) };
  }

  function returnBook(a) {
    const p = parseArgs(a, { member: true, book: true, date: true });
    if (!p || !advance(p.date)) return fail();
    const m = members.get(p.memberId);
    const b = books.get(p.bookId);
    if (!m || !b) return fail();
    if (b.state !== LOAN || b.loan.memberId !== m.id) return fail();

    const loan = b.loan;
    const daysLate = Math.max(0, now - loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
    m.owed += fine;
    m.loans.delete(b.id);
    b.loan = null;
    if (b.queue.length === 0) {
      b.state = AVAILABLE;
      b.readyDay = null;
    } else {
      b.state = SET_ASIDE;
      b.readyDay = addDays(now, PICKUP_DAYS);
    }
    return { ok: true, fine };
  }

  function renew(a) {
    const p = parseArgs(a, { member: true, book: true, date: true });
    if (!p || !advance(p.date)) return fail();
    const m = members.get(p.memberId);
    const b = books.get(p.bookId);
    if (!m || !b) return fail();
    if (b.state !== LOAN || b.loan.memberId !== m.id) return fail();

    const loan = b.loan;
    if (loan.renewals >= RENEWAL_LIMIT) return fail();
    if (now > loan.dueDay) return fail();
    if (b.queue.length > 0) return fail();

    loan.dueDay = addDays(now, LOAN_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: dayToString(loan.dueDay) };
  }

  function placeHold(a) {
    const p = parseArgs(a, { member: true, book: true, date: true });
    if (!p || !advance(p.date)) return fail();
    const m = members.get(p.memberId);
    const b = books.get(p.bookId);
    if (!m || !b) return fail();
    if (b.state === AVAILABLE) return fail();
    if (b.state === LOAN && b.loan.memberId === m.id) return fail();
    if (m.holds.has(b.id)) return fail();
    if (m.holds.size >= MAX_HOLDS) return fail();

    b.queue.push(m.id);
    m.holds.add(b.id);
    return { ok: true, position: b.queue.length };
  }

  function payFine(a) {
    const p = parseArgs(a, { member: true, amount: true, date: true });
    if (!p || !advance(p.date)) return fail();
    const m = members.get(p.memberId);
    if (!m) return fail();
    if (p.amount > m.owed) return fail();
    m.owed -= p.amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(a) {
    const p = parseArgs(a, { member: true, date: true });
    if (!p || !advance(p.date)) return fail();
    const m = members.get(p.memberId);
    if (!m) return fail();

    const loans = [...m.loans.values()].map((l) => ({
      bookId: l.bookId,
      dueDate: dayToString(l.dueDay),
    }));
    const holds = [...m.holds].map((bookId) => {
      const b = books.get(bookId);
      const position = b.queue.indexOf(m.id) + 1;
      const readyUntil =
        b.state === SET_ASIDE && b.queue[0] === m.id ? dayToString(b.readyDay) : null;
      return { bookId, position, readyUntil };
    });
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
