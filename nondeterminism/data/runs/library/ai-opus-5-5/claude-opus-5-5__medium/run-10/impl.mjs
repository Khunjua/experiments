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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Days since 1970-01-01 (proleptic Gregorian, UTC-equivalent, pure integer arithmetic).
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
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  let y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y += 1;
  return [y, m, d];
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function formatDate(n) {
  const [y, m, d] = civilFromDays(n);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isObj(a) {
  return a !== null && typeof a === 'object';
}

const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map(); // bookId -> { loan, queue, readyUntil }
  const members = new Map(); // memberId -> { owed, loans: Map<bookId, loan>, holds: [] }
  let current = null;
  let holdSeq = 0;

  function processExpiry(day) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && day > book.readyUntil) {
        const expired = book.queue.shift();
        removeMemberHold(expired);
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  function removeMemberHold(hold) {
    const m = members.get(hold.memberId);
    const i = m.holds.indexOf(hold);
    if (i >= 0) m.holds.splice(i, 1);
  }

  // Validates args object and date; advances the clock and runs expiry.
  // Returns the day number or null on failure.
  function enterDated(args) {
    if (!isObj(args)) return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    processExpiry(day);
    return day;
  }

  function addBook(args) {
    if (!isObj(args) || !validId(args.bookId)) return FAIL('invalid');
    if (books.has(args.bookId)) return FAIL('exists');
    books.set(args.bookId, { bookId: args.bookId, loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args) || !validId(args.memberId)) return FAIL('invalid');
    if (members.has(args.memberId)) return FAIL('exists');
    members.set(args.memberId, { owed: 0, loans: new Map(), holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const day = enterDated(args);
    if (day === null) return FAIL('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return FAIL('unknown');
    if (b.loan) return FAIL('on loan');
    const setAsideFor = b.readyUntil !== null ? b.queue[0].memberId : null;
    if (setAsideFor !== null && setAsideFor !== memberId) return FAIL('set aside');
    if (m.loans.size >= MAX_LOANS) return FAIL('loan limit');
    for (const loan of m.loans.values()) {
      if (loan.dueDate < day) return FAIL('overdue');
    }
    if (m.owed >= OWED_BLOCK) return FAIL('owes');

    const loan = { memberId, bookId, dueDate: day + LOAN_DAYS, renewals: 0 };
    if (setAsideFor === memberId) {
      const hold = b.queue.shift();
      removeMemberHold(hold);
      b.readyUntil = null;
    }
    b.loan = loan;
    m.loans.set(bookId, loan);
    return { ok: true, dueDate: formatDate(loan.dueDate) };
  }

  function returnBook(args) {
    const day = enterDated(args);
    if (day === null) return FAIL('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return FAIL('unknown');
    if (!b.loan || b.loan.memberId !== memberId) return FAIL('not on loan to member');

    const daysLate = Math.max(0, day - b.loan.dueDate);
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
    m.owed += fine;
    m.loans.delete(bookId);
    b.loan = null;
    b.readyUntil = b.queue.length > 0 ? day + PICKUP_DAYS : null;
    return { ok: true, fine };
  }

  function renew(args) {
    const day = enterDated(args);
    if (day === null) return FAIL('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return FAIL('unknown');
    const loan = b.loan;
    if (!loan || loan.memberId !== memberId) return FAIL('not on loan to member');
    if (loan.renewals >= MAX_RENEWALS) return FAIL('renewal limit');
    if (day > loan.dueDate) return FAIL('overdue');
    if (b.queue.length > 0) return FAIL('holds exist');
    loan.dueDate = Math.max(loan.dueDate, day + RENEW_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDate) };
  }

  function placeHold(args) {
    const day = enterDated(args);
    if (day === null) return FAIL('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return FAIL('unknown');
    if (!b.loan && b.readyUntil === null) return FAIL('available');
    if (b.loan && b.loan.memberId === memberId) return FAIL('own loan');
    if (b.queue.some((h) => h.memberId === memberId)) return FAIL('duplicate hold');
    if (m.holds.length >= MAX_HOLDS) return FAIL('hold limit');
    const hold = { memberId, bookId, seq: ++holdSeq };
    b.queue.push(hold);
    m.holds.push(hold);
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    const day = enterDated(args);
    if (day === null) return FAIL('invalid');
    const { memberId, amount } = args;
    if (!validId(memberId)) return FAIL('invalid');
    if (!Number.isSafeInteger(amount) || amount <= 0) return FAIL('invalid amount');
    const m = members.get(memberId);
    if (!m) return FAIL('unknown');
    if (amount > m.owed) return FAIL('overpayment');
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const day = enterDated(args);
    if (day === null) return FAIL('invalid');
    const { memberId } = args;
    if (!validId(memberId)) return FAIL('invalid');
    const m = members.get(memberId);
    if (!m) return FAIL('unknown');
    const loans = [];
    for (const loan of m.loans.values()) {
      loans.push({ bookId: loan.bookId, dueDate: formatDate(loan.dueDate) });
    }
    const holds = m.holds.map((h) => {
      const b = books.get(h.bookId);
      const idx = b.queue.indexOf(h);
      const ready = idx === 0 && b.readyUntil !== null;
      return {
        bookId: h.bookId,
        position: idx + 1,
        readyUntil: ready ? formatDate(b.readyUntil) : null,
      };
    });
    return { ok: true, loans, owed: m.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
