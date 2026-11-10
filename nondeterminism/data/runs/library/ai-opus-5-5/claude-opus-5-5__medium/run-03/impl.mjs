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

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  const t = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return t[m - 1];
}

// Pure integer UTC day arithmetic (proleptic Gregorian), independent of time zones.
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
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
  let y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
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
  return (
    String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0')
  );
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function getArgs(a) {
  return a !== null && typeof a === 'object' ? a : null;
}

const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map(); // bookId -> { state, loanMember, queue: [memberId], readyUntil }
  const members = new Map(); // memberId -> { loans: [{bookId, due, renewals}], owed, holds: [bookId] }
  let current = null;

  function processExpiry(day) {
    for (const [bookId, book] of books) {
      while (book.state === 'aside' && day > book.readyUntil) {
        const expiredMember = book.queue.shift();
        const m = members.get(expiredMember);
        if (m) {
          const i = m.holds.indexOf(bookId);
          if (i !== -1) m.holds.splice(i, 1);
        }
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates date, applies clock and expiry. Returns day number or null on failure.
  function tick(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    processExpiry(day);
    return day;
  }

  function addBook(args) {
    const a = getArgs(args);
    if (!a || !isId(a.bookId)) return FAIL('invalid');
    if (books.has(a.bookId)) return FAIL('exists');
    books.set(a.bookId, { state: 'available', loanMember: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    const a = getArgs(args);
    if (!a || !isId(a.memberId)) return FAIL('invalid');
    if (members.has(a.memberId)) return FAIL('exists');
    members.set(a.memberId, { loans: [], owed: 0, holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const a = getArgs(args);
    if (!a) return FAIL('invalid');
    const day = tick(a.date);
    if (day === null) return FAIL('invalid date');
    if (!isId(a.memberId) || !isId(a.bookId)) return FAIL('invalid');
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return FAIL('unknown');
    if (b.state === 'loan') return FAIL('on loan');
    if (b.state === 'aside' && b.queue[0] !== a.memberId) return FAIL('set aside for another');
    if (m.loans.length >= MAX_LOANS) return FAIL('loan limit');
    if (m.loans.some((l) => l.due < day)) return FAIL('overdue');
    if (m.owed >= BLOCK_OWED) return FAIL('owes');
    if (b.state === 'aside') {
      b.queue.shift();
      const i = m.holds.indexOf(a.bookId);
      if (i !== -1) m.holds.splice(i, 1);
      b.readyUntil = null;
    }
    const due = day + LOAN_DAYS;
    b.state = 'loan';
    b.loanMember = a.memberId;
    m.loans.push({ bookId: a.bookId, due, renewals: 0 });
    return { ok: true, dueDate: formatDate(due) };
  }

  function returnBook(args) {
    const a = getArgs(args);
    if (!a) return FAIL('invalid');
    const day = tick(a.date);
    if (day === null) return FAIL('invalid date');
    if (!isId(a.memberId) || !isId(a.bookId)) return FAIL('invalid');
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return FAIL('unknown');
    if (b.state !== 'loan' || b.loanMember !== a.memberId) return FAIL('not on loan to member');
    const idx = m.loans.findIndex((l) => l.bookId === a.bookId);
    if (idx === -1) return FAIL('not on loan to member');
    const loan = m.loans[idx];
    const daysLate = Math.max(0, day - loan.due);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
    m.owed += fine;
    m.loans.splice(idx, 1);
    b.loanMember = null;
    if (b.queue.length === 0) {
      b.state = 'available';
      b.readyUntil = null;
    } else {
      b.state = 'aside';
      b.readyUntil = day + PICKUP_DAYS;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const a = getArgs(args);
    if (!a) return FAIL('invalid');
    const day = tick(a.date);
    if (day === null) return FAIL('invalid date');
    if (!isId(a.memberId) || !isId(a.bookId)) return FAIL('invalid');
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return FAIL('unknown');
    if (b.state !== 'loan' || b.loanMember !== a.memberId) return FAIL('not on loan to member');
    const loan = m.loans.find((l) => l.bookId === a.bookId);
    if (!loan) return FAIL('not on loan to member');
    if (loan.renewals >= MAX_RENEWALS) return FAIL('renewal limit');
    if (day > loan.due) return FAIL('overdue');
    if (b.queue.length > 0) return FAIL('holds exist');
    loan.due = day + RENEW_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.due) };
  }

  function placeHold(args) {
    const a = getArgs(args);
    if (!a) return FAIL('invalid');
    const day = tick(a.date);
    if (day === null) return FAIL('invalid date');
    if (!isId(a.memberId) || !isId(a.bookId)) return FAIL('invalid');
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return FAIL('unknown');
    if (b.state === 'available') return FAIL('available');
    if (b.state === 'loan' && b.loanMember === a.memberId) return FAIL('member has it');
    if (b.queue.includes(a.memberId)) return FAIL('already held');
    if (m.holds.length >= MAX_HOLDS) return FAIL('hold limit');
    b.queue.push(a.memberId);
    m.holds.push(a.bookId);
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    const a = getArgs(args);
    if (!a) return FAIL('invalid');
    const day = tick(a.date);
    if (day === null) return FAIL('invalid date');
    if (!isId(a.memberId)) return FAIL('invalid');
    const amount = a.amount;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
      return FAIL('invalid amount');
    }
    const m = members.get(a.memberId);
    if (!m) return FAIL('unknown');
    if (amount > m.owed) return FAIL('overpayment');
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const a = getArgs(args);
    if (!a) return FAIL('invalid');
    const day = tick(a.date);
    if (day === null) return FAIL('invalid date');
    if (!isId(a.memberId)) return FAIL('invalid');
    const m = members.get(a.memberId);
    if (!m) return FAIL('unknown');
    const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.due) }));
    const holds = m.holds.map((bookId) => {
      const b = books.get(bookId);
      const position = b.queue.indexOf(a.memberId) + 1;
      const readyUntil =
        b.state === 'aside' && position === 1 ? formatDate(b.readyUntil) : null;
      return { bookId, position, readyUntil };
    });
    return { ok: true, loans, owed: m.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
