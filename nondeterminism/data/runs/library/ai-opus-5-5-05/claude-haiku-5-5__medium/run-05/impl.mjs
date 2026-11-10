const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 1000;
const BLOCK_OWED = 500;
const PICKUP_DAYS = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Day number (days since 1970-01-01) for a proleptic Gregorian date.
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [y + (m <= 2 ? 1 : 0), m, d];
}

// Returns a day number, or null if the value is not a valid YYYY-MM-DD date.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function formatDay(z) {
  const [y, m, d] = civilFromDays(z);
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isObj(x) {
  return x !== null && typeof x === 'object';
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

function removeFirst(arr, value) {
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1);
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { id, loan: null | { memberId, dueDay, renewals }, queue: [memberId], readyDay: number | null }
  // Invariants:
  //  - on loan:  loan !== null, readyDay === null
  //  - set aside: loan === null, queue non-empty, queue[0] is the set-aside member, readyDay set
  //  - available: loan === null, queue empty, readyDay === null
  const books = new Map();
  // memberId -> { id, loans: [bookId] (creation order), holds: [bookId] (placement order), owed }
  const members = new Map();
  let currentDay = null;

  function processExpiry(day) {
    for (const book of books.values()) {
      while (book.loan === null && book.queue.length > 0 && day > book.readyDay) {
        const expired = book.queue.shift();
        const m = members.get(expired);
        if (m) removeFirst(m.holds, book.id);
        if (book.queue.length === 0) {
          book.readyDay = null;
        } else {
          book.readyDay = book.readyDay + PICKUP_DAYS + 1;
        }
      }
    }
  }

  // Returns a failure object if the date is not allowed, otherwise null.
  function advanceClock(day) {
    if (currentDay !== null && day < currentDay) {
      return fail('date is earlier than the current date');
    }
    currentDay = day;
    processExpiry(day);
    return null;
  }

  function addBook(a) {
    if (!isObj(a) || !validId(a.bookId)) return fail('invalid input');
    const bookId = a.bookId;
    if (books.has(bookId)) return fail('book already exists');
    books.set(bookId, { id: bookId, loan: null, queue: [], readyDay: null });
    return { ok: true };
  }

  function addMember(a) {
    if (!isObj(a) || !validId(a.memberId)) return fail('invalid input');
    const memberId = a.memberId;
    if (members.has(memberId)) return fail('member already exists');
    members.set(memberId, { id: memberId, loans: [], holds: [], owed: 0 });
    return { ok: true };
  }

  function borrow(a) {
    if (!isObj(a) || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid input');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    const memberId = a.memberId;
    const bookId = a.bookId;

    const stale = advanceClock(day);
    if (stale) return stale;

    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('unknown member or book');
    if (b.loan !== null) return fail('book is on loan');
    if (b.queue.length > 0 && b.queue[0] !== memberId) return fail('book is set aside for another member');
    if (m.loans.length >= MAX_LOANS) return fail('loan limit reached');
    if (m.owed >= BLOCK_OWED) return fail('outstanding fines block borrowing');

    const dueDay = day + LOAN_DAYS;
    b.loan = { memberId, dueDay, renewals: 0 };
    if (b.queue.length > 0 && b.queue[0] === memberId) {
      b.queue.shift();
      removeFirst(m.holds, bookId);
    }
    b.readyDay = null;
    m.loans.push(bookId);
    return { ok: true, dueDate: formatDay(dueDay) };
  }

  function renew(a) {
    if (!isObj(a) || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid input');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    const memberId = a.memberId;
    const bookId = a.bookId;

    const stale = advanceClock(day);
    if (stale) return stale;

    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('unknown member or book');
    if (b.loan === null || b.loan.memberId !== memberId) return fail('member does not have this book on loan');
    const loan = b.loan;
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
    if (b.queue.length > 0) return fail('book has a waiting queue');
    if (day > loan.dueDay) return fail('loan is overdue');
    const newDue = day + LOAN_DAYS;
    if (newDue <= loan.dueDay) return fail('renewal does not extend the loan');

    loan.dueDay = newDue;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDay(newDue) };
  }

  function returnBook(a) {
    if (!isObj(a) || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid input');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    const memberId = a.memberId;
    const bookId = a.bookId;

    const stale = advanceClock(day);
    if (stale) return stale;

    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('unknown member or book');
    if (b.loan === null || b.loan.memberId !== memberId) return fail('member does not have this book on loan');

    const daysLate = day - b.loan.dueDay;
    const chargeableDays = Math.max(0, daysLate - GRACE_DAYS);
    const fine = Math.min(FINE_PER_DAY * chargeableDays, MAX_FINE);

    b.loan = null;
    removeFirst(m.loans, bookId);
    m.owed += fine;
    b.readyDay = b.queue.length > 0 ? day + PICKUP_DAYS : null;
    return { ok: true, fine };
  }

  function placeHold(a) {
    if (!isObj(a) || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid input');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    const memberId = a.memberId;
    const bookId = a.bookId;

    const stale = advanceClock(day);
    if (stale) return stale;

    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('unknown member or book');
    if (b.loan === null && b.queue.length === 0) return fail('book is available');
    if (b.loan !== null && b.loan.memberId === memberId) return fail('member has this book on loan');
    if (b.queue.includes(memberId)) return fail('member already has a hold on this book');

    b.queue.push(memberId);
    m.holds.push(bookId);
    return { ok: true, position: b.queue.length };
  }

  function payFine(a) {
    if (!isObj(a) || !validId(a.memberId)) return fail('invalid input');
    const amount = a.amount;
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail('invalid amount');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    const memberId = a.memberId;

    const stale = advanceClock(day);
    if (stale) return stale;

    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    if (amount > m.owed) return fail('amount exceeds amount owed');

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(a) {
    if (!isObj(a) || !validId(a.memberId)) return fail('invalid input');
    const day = parseDate(a.date);
    if (day === null) return fail('invalid date');
    const memberId = a.memberId;

    const stale = advanceClock(day);
    if (stale) return stale;

    const m = members.get(memberId);
    if (!m) return fail('unknown member');

    const loans = m.loans.map((bookId) => {
      const b = books.get(bookId);
      return { bookId, dueDate: formatDay(b.loan.dueDay) };
    });

    const holds = m.holds.map((bookId) => {
      const b = books.get(bookId);
      const idx = b.queue.indexOf(memberId);
      const setAside = b.loan === null && idx === 0;
      return {
        bookId,
        position: idx + 1,
        readyUntil: setAside ? formatDay(b.readyDay) : null,
      };
    });

    return { ok: true, loans, owed: m.owed, holds };
  }

  const guard = (fn) => (arg) => {
    try {
      return fn(arg);
    } catch (e) {
      return { ok: false, reason: 'internal error' };
    }
  };

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
