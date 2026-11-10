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
  if (m === 2) return isLeap(y) ? 29 : 28;
  return (m === 4 || m === 6 || m === 9 || m === 11) ? 30 : 31;
}

// Days since 1970-01-01 (proleptic Gregorian), pure integer arithmetic.
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
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
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d];
}

const MIN_DAY = daysFromCivil(1, 1, 1);
const MAX_DAY = daysFromCivil(9999, 12, 31);

function parseDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const y = Number(v.slice(0, 4));
  const m = Number(v.slice(5, 7));
  const d = Number(v.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  const day = daysFromCivil(y, m, d);
  if (day < MIN_DAY || day > MAX_DAY) return null;
  return day;
}

function formatDate(day) {
  const [y, m, d] = civilFromDays(day);
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// Returns null when the result would fall after 9999-12-31.
function addDays(day, n) {
  const r = day + n;
  return r > MAX_DAY ? null : r;
}

const field = (arg, key) => (arg !== null && typeof arg === 'object' ? arg[key] : undefined);
const idOf = (v) => (typeof v === 'string' && v.length > 0 ? v : null);
const amountOf = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  let clock = null;
  const books = new Map();   // bookId -> { borrower, queue: [memberId], readyUntil }
  const members = new Map(); // memberId -> { loans: Map<bookId, {dueDate, renewals}>, owed, holds: Set<bookId> }

  // Returns false (and changes nothing) if day is earlier than the clock.
  // Otherwise sets the clock and processes hold expiry (§7.4).
  function advanceClock(day) {
    if (clock !== null && day < clock) return false;
    clock = day;
    for (const [bookId, book] of books) {
      while (
        book.borrower === null &&
        book.queue.length > 0 &&
        book.readyUntil !== null &&
        clock > book.readyUntil
      ) {
        const expiredMemberId = book.queue.shift();
        members.get(expiredMemberId).holds.delete(bookId);
        if (book.queue.length === 0) {
          book.readyUntil = null;
        } else {
          book.readyUntil = Math.min(book.readyUntil + PICKUP_DAYS + 1, MAX_DAY);
        }
      }
    }
    return true;
  }

  return {
    addBook(arg) {
      try {
        const bookId = idOf(field(arg, 'bookId'));
        if (bookId === null) return fail('invalid bookId');
        if (books.has(bookId)) return fail('book exists');
        books.set(bookId, { borrower: null, queue: [], readyUntil: null });
        return { ok: true };
      } catch {
        return fail('internal error');
      }
    },

    addMember(arg) {
      try {
        const memberId = idOf(field(arg, 'memberId'));
        if (memberId === null) return fail('invalid memberId');
        if (members.has(memberId)) return fail('member exists');
        members.set(memberId, { loans: new Map(), owed: 0, holds: new Set() });
        return { ok: true };
      } catch {
        return fail('internal error');
      }
    },

    borrow(arg) {
      try {
        const memberId = idOf(field(arg, 'memberId'));
        const bookId = idOf(field(arg, 'bookId'));
        const day = parseDate(field(arg, 'date'));
        if (memberId === null || bookId === null || day === null) return fail('invalid input');
        if (!advanceClock(day)) return fail('date before current date');

        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return fail('unknown member or book');
        if (b.borrower !== null) return fail('on loan');
        if (b.queue.length > 0 && b.queue[0] !== memberId) return fail('set aside for another member');
        if (m.loans.size >= MAX_LOANS) return fail('loan limit reached');
        if (m.owed >= BLOCK_OWED) return fail('owed too high');
        const due = addDays(day, LOAN_DAYS);
        if (due === null) return fail('date out of range');

        if (b.queue.length > 0) {
          b.queue.shift();
          m.holds.delete(bookId);
        }
        b.readyUntil = null;
        b.borrower = memberId;
        m.loans.set(bookId, { dueDate: due, renewals: 0 });
        return { ok: true, dueDate: formatDate(due) };
      } catch {
        return fail('internal error');
      }
    },

    renew(arg) {
      try {
        const memberId = idOf(field(arg, 'memberId'));
        const bookId = idOf(field(arg, 'bookId'));
        const day = parseDate(field(arg, 'date'));
        if (memberId === null || bookId === null || day === null) return fail('invalid input');
        if (!advanceClock(day)) return fail('date before current date');

        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return fail('unknown member or book');
        const loan = m.loans.get(bookId);
        if (!loan || b.borrower !== memberId) return fail('not on loan to member');
        if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
        if (b.queue.length > 0) return fail('book has holds');
        if (day > loan.dueDate) return fail('overdue');
        const due = addDays(day, LOAN_DAYS);
        if (due === null || due <= loan.dueDate) return fail('renewal does not extend loan');

        loan.dueDate = due;
        loan.renewals += 1;
        return { ok: true, dueDate: formatDate(due) };
      } catch {
        return fail('internal error');
      }
    },

    returnBook(arg) {
      try {
        const memberId = idOf(field(arg, 'memberId'));
        const bookId = idOf(field(arg, 'bookId'));
        const day = parseDate(field(arg, 'date'));
        if (memberId === null || bookId === null || day === null) return fail('invalid input');
        if (!advanceClock(day)) return fail('date before current date');

        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return fail('unknown member or book');
        const loan = m.loans.get(bookId);
        if (!loan || b.borrower !== memberId) return fail('not on loan to member');

        const daysLate = day - loan.dueDate;
        const chargeableDays = Math.max(0, daysLate - GRACE_DAYS);
        const fine = Math.min(FINE_PER_DAY * chargeableDays, MAX_FINE);

        m.loans.delete(bookId);
        m.owed += fine;
        b.borrower = null;
        if (b.queue.length === 0) {
          b.readyUntil = null;
        } else {
          b.readyUntil = Math.min(day + PICKUP_DAYS, MAX_DAY);
        }
        return { ok: true, fine };
      } catch {
        return fail('internal error');
      }
    },

    placeHold(arg) {
      try {
        const memberId = idOf(field(arg, 'memberId'));
        const bookId = idOf(field(arg, 'bookId'));
        const day = parseDate(field(arg, 'date'));
        if (memberId === null || bookId === null || day === null) return fail('invalid input');
        if (!advanceClock(day)) return fail('date before current date');

        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return fail('unknown member or book');
        if (b.borrower === null && b.queue.length === 0) return fail('book is available');
        if (b.borrower === memberId) return fail('member has this book');
        if (b.queue.includes(memberId)) return fail('hold exists');

        b.queue.push(memberId);
        m.holds.add(bookId);
        return { ok: true, position: b.queue.length };
      } catch {
        return fail('internal error');
      }
    },

    payFine(arg) {
      try {
        const memberId = idOf(field(arg, 'memberId'));
        const amount = amountOf(field(arg, 'amount'));
        const day = parseDate(field(arg, 'date'));
        if (memberId === null || amount === null || day === null) return fail('invalid input');
        if (!advanceClock(day)) return fail('date before current date');

        const m = members.get(memberId);
        if (!m) return fail('unknown member');
        if (amount > m.owed) return fail('overpayment');

        m.owed -= amount;
        return { ok: true, owed: m.owed };
      } catch {
        return fail('internal error');
      }
    },

    getMember(arg) {
      try {
        const memberId = idOf(field(arg, 'memberId'));
        const day = parseDate(field(arg, 'date'));
        if (memberId === null || day === null) return fail('invalid input');
        if (!advanceClock(day)) return fail('date before current date');

        const m = members.get(memberId);
        if (!m) return fail('unknown member');

        const loans = [];
        for (const [bookId, loan] of m.loans) {
          loans.push({ bookId, dueDate: formatDate(loan.dueDate) });
        }

        const holds = [];
        for (const bookId of m.holds) {
          const b = books.get(bookId);
          const position = b.queue.indexOf(memberId) + 1;
          const setAside = b.borrower === null && b.queue[0] === memberId;
          holds.push({
            bookId,
            position,
            readyUntil: setAside ? formatDate(b.readyUntil) : null,
          });
        }

        return { ok: true, loans, owed: m.owed, holds };
      } catch {
        return fail('internal error');
      }
    },
  };
}
