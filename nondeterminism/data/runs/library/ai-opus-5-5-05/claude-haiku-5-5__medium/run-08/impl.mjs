const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 1000;
const BLOCK_OWED = 500;
const PICKUP_DAYS = 7;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  const table = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[m - 1];
}

// Day number relative to 1970-01-01, proleptic Gregorian, no time zones.
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z0) {
  const z = z0 + 719468;
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
  return [m <= 2 ? y + 1 : y, m, d];
}

const MAX_DAY = daysFromCivil(9999, 12, 31);

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function formatDay(z) {
  const [y, m, d] = civilFromDays(z);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isObj(v) {
  return typeof v === 'object' && v !== null;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { borrower: memberId|null, queue: memberId[], readyUntil: dayNumber|null }
  const books = new Map();
  // memberId -> { loans: Map<bookId, { dueDay, renewals }>, holds: Set<bookId>, owed: number }
  const members = new Map();
  let clock = null;

  // Validates the date, enforces monotonic clock, and runs hold expiry.
  function begin(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return { error: 'invalid date' };
    if (clock !== null && day < clock) return { error: 'date earlier than current date' };
    clock = day;
    expire(day);
    return { day };
  }

  function expire(day) {
    for (const [bookId, book] of books) {
      while (
        book.borrower === null &&
        book.queue.length > 0 &&
        book.readyUntil !== null &&
        day > book.readyUntil
      ) {
        const gone = book.queue.shift();
        members.get(gone).holds.delete(bookId);
        if (book.queue.length === 0) {
          book.readyUntil = null;
        } else {
          book.readyUntil = Math.min(book.readyUntil + PICKUP_DAYS + 1, MAX_DAY);
        }
      }
    }
  }

  function safe(fn) {
    return (input) => {
      try {
        return fn(input);
      } catch {
        return fail('internal error');
      }
    };
  }

  const addBook = safe((input) => {
    if (!isObj(input)) return fail('bad input');
    const bookId = input.bookId;
    if (!isId(bookId)) return fail('bad bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { borrower: null, queue: [], readyUntil: null });
    return { ok: true };
  });

  const addMember = safe((input) => {
    if (!isObj(input)) return fail('bad input');
    const memberId = input.memberId;
    if (!isId(memberId)) return fail('bad memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { loans: new Map(), holds: new Set(), owed: 0 });
    return { ok: true };
  });

  const borrow = safe((input) => {
    if (!isObj(input)) return fail('bad input');
    const { memberId, bookId, date } = input;
    if (!isId(memberId) || !isId(bookId)) return fail('bad id');
    const t = begin(date);
    if (t.error) return fail(t.error);
    const m = members.get(memberId);
    if (!m) return fail('no member');
    const b = books.get(bookId);
    if (!b) return fail('no book');
    if (b.borrower !== null) return fail('on loan');
    if (b.queue.length > 0 && b.queue[0] !== memberId) return fail('set aside for another member');
    if (m.loans.size >= MAX_LOANS) return fail('loan limit reached');
    if (m.owed >= BLOCK_OWED) return fail('owed too much');
    const due = t.day + LOAN_DAYS;
    if (due > MAX_DAY) return fail('date out of range');
    if (b.queue.length > 0) {
      b.queue.shift();
      m.holds.delete(bookId);
    }
    b.readyUntil = null;
    b.borrower = memberId;
    m.loans.set(bookId, { dueDay: due, renewals: 0 });
    return { ok: true, dueDate: formatDay(due) };
  });

  const renew = safe((input) => {
    if (!isObj(input)) return fail('bad input');
    const { memberId, bookId, date } = input;
    if (!isId(memberId) || !isId(bookId)) return fail('bad id');
    const t = begin(date);
    if (t.error) return fail(t.error);
    const m = members.get(memberId);
    if (!m) return fail('no member');
    const b = books.get(bookId);
    if (!b) return fail('no book');
    const loan = m.loans.get(bookId);
    if (!loan || b.borrower !== memberId) return fail('not on loan to member');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
    if (b.queue.length > 0) return fail('book has waiting members');
    if (t.day > loan.dueDay) return fail('loan overdue');
    const due = t.day + LOAN_DAYS;
    if (due > MAX_DAY) return fail('date out of range');
    if (due <= loan.dueDay) return fail('renewal does not extend loan');
    loan.dueDay = due;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDay(due) };
  });

  const returnBook = safe((input) => {
    if (!isObj(input)) return fail('bad input');
    const { memberId, bookId, date } = input;
    if (!isId(memberId) || !isId(bookId)) return fail('bad id');
    const t = begin(date);
    if (t.error) return fail(t.error);
    const m = members.get(memberId);
    if (!m) return fail('no member');
    const b = books.get(bookId);
    if (!b) return fail('no book');
    const loan = m.loans.get(bookId);
    if (!loan || b.borrower !== memberId) return fail('not on loan to member');

    const daysLate = t.day - loan.dueDay;
    const chargeable = Math.max(0, daysLate - GRACE_DAYS);
    const fine = Math.min(FINE_PER_DAY * chargeable, MAX_FINE);

    m.loans.delete(bookId);
    m.owed += fine;
    b.borrower = null;
    if (b.queue.length === 0) {
      b.readyUntil = null;
    } else {
      b.readyUntil = Math.min(t.day + PICKUP_DAYS, MAX_DAY);
    }
    return { ok: true, fine };
  });

  const placeHold = safe((input) => {
    if (!isObj(input)) return fail('bad input');
    const { memberId, bookId, date } = input;
    if (!isId(memberId) || !isId(bookId)) return fail('bad id');
    const t = begin(date);
    if (t.error) return fail(t.error);
    const m = members.get(memberId);
    if (!m) return fail('no member');
    const b = books.get(bookId);
    if (!b) return fail('no book');
    if (b.borrower === null && b.queue.length === 0) return fail('book is available');
    if (b.borrower === memberId) return fail('member has the book');
    if (b.queue.includes(memberId)) return fail('hold already exists');
    b.queue.push(memberId);
    m.holds.add(bookId);
    return { ok: true, position: b.queue.length };
  });

  const payFine = safe((input) => {
    if (!isObj(input)) return fail('bad input');
    const { memberId, amount, date } = input;
    if (!isId(memberId)) return fail('bad memberId');
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail('bad amount');
    const t = begin(date);
    if (t.error) return fail(t.error);
    const m = members.get(memberId);
    if (!m) return fail('no member');
    if (amount > m.owed) return fail('overpayment');
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  });

  const getMember = safe((input) => {
    if (!isObj(input)) return fail('bad input');
    const { memberId, date } = input;
    if (!isId(memberId)) return fail('bad memberId');
    const t = begin(date);
    if (t.error) return fail(t.error);
    const m = members.get(memberId);
    if (!m) return fail('no member');

    const loans = [];
    for (const [bookId, loan] of m.loans) {
      loans.push({ bookId, dueDate: formatDay(loan.dueDay) });
    }

    const holds = [];
    for (const bookId of m.holds) {
      const b = books.get(bookId);
      const position = b.queue.indexOf(memberId) + 1;
      const setAsideForMember = b.borrower === null && b.queue[0] === memberId;
      holds.push({
        bookId,
        position,
        readyUntil: setAsideForMember && b.readyUntil !== null ? formatDay(b.readyUntil) : null,
      });
    }

    return { ok: true, loans, owed: m.owed, holds };
  });

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
