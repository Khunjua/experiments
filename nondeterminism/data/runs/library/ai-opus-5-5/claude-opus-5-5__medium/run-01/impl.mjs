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
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > daysInMonth(y, m)) return false;
  return true;
}

// Day number in UTC, independent of local time zone.
function toDay(s) {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  return Math.round(dt.getTime() / 86400000);
}

function pad(n, w) {
  let s = String(n);
  while (s.length < w) s = '0' + s;
  return s;
}

function fromDay(n) {
  const dt = new Date(n * 86400000);
  return (
    pad(dt.getUTCFullYear(), 4) +
    '-' +
    pad(dt.getUTCMonth() + 1, 2) +
    '-' +
    pad(dt.getUTCDate(), 2)
  );
}

function addDays(s, n) {
  return fromDay(toDay(s) + n);
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function field(args, key) {
  if (args === null || (typeof args !== 'object' && typeof args !== 'function')) return undefined;
  try {
    return args[key];
  } catch {
    return undefined;
  }
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { status: 'available'|'loan'|'aside', loanMember, queue: [{memberId, seq}], readyUntil }
  const books = new Map();
  // memberId -> { loans: [{bookId, dueDate, renewals}], owed, holds: [{bookId, seq}] }
  const members = new Map();
  let currentDay = null; // day number
  let holdSeq = 0;

  function removeMemberHold(memberId, bookId) {
    const m = members.get(memberId);
    if (!m) return;
    const i = m.holds.findIndex((h) => h.bookId === bookId);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function processExpiry(dateStr) {
    const day = toDay(dateStr);
    for (const [bookId, b] of books) {
      while (b.status === 'aside' && day > toDay(b.readyUntil)) {
        const expired = b.queue.shift();
        removeMemberHold(expired.memberId, bookId);
        if (b.queue.length > 0) {
          b.readyUntil = addDays(b.readyUntil, 1 + PICKUP_DAYS);
        } else {
          b.status = 'available';
          b.readyUntil = null;
        }
      }
    }
  }

  // Returns true if the date is valid and not earlier than the clock; advances clock and expiry.
  function tick(dateStr) {
    if (!isValidDate(dateStr)) return false;
    const day = toDay(dateStr);
    if (currentDay !== null && day < currentDay) return false;
    currentDay = day;
    processExpiry(dateStr);
    return true;
  }

  function addBook(args) {
    const bookId = field(args, 'bookId');
    if (!isId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('duplicate book');
    books.set(bookId, { status: 'available', loanMember: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    const memberId = field(args, 'memberId');
    if (!isId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('duplicate member');
    members.set(memberId, { loans: [], owed: 0, holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const memberId = field(args, 'memberId');
    const bookId = field(args, 'bookId');
    const date = field(args, 'date');
    if (!tick(date)) return fail('invalid or past date');
    if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('not registered');
    if (b.status === 'loan') return fail('on loan');
    if (b.status === 'aside' && b.queue[0].memberId !== memberId) return fail('set aside for another');
    if (m.loans.length >= MAX_LOANS) return fail('loan limit');
    const day = toDay(date);
    if (m.loans.some((l) => toDay(l.dueDate) < day)) return fail('overdue loan');
    if (m.owed >= OWED_BLOCK) return fail('owes too much');

    if (b.status === 'aside') {
      b.queue.shift();
      removeMemberHold(memberId, bookId);
    }
    const dueDate = addDays(date, LOAN_DAYS);
    b.status = 'loan';
    b.loanMember = memberId;
    b.readyUntil = null;
    m.loans.push({ bookId, dueDate, renewals: 0 });
    return { ok: true, dueDate };
  }

  function returnBook(args) {
    const memberId = field(args, 'memberId');
    const bookId = field(args, 'bookId');
    const date = field(args, 'date');
    if (!tick(date)) return fail('invalid or past date');
    if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('not registered');
    if (b.status !== 'loan' || b.loanMember !== memberId) return fail('not on loan to member');
    const idx = m.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0) return fail('not on loan to member');
    const loan = m.loans[idx];

    const daysLate = Math.max(0, toDay(date) - toDay(loan.dueDate));
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
    m.owed += fine;
    m.loans.splice(idx, 1);
    b.loanMember = null;
    if (b.queue.length === 0) {
      b.status = 'available';
      b.readyUntil = null;
    } else {
      b.status = 'aside';
      b.readyUntil = addDays(date, PICKUP_DAYS);
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const memberId = field(args, 'memberId');
    const bookId = field(args, 'bookId');
    const date = field(args, 'date');
    if (!tick(date)) return fail('invalid or past date');
    if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('not registered');
    if (b.status !== 'loan' || b.loanMember !== memberId) return fail('not on loan to member');
    const loan = m.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('not on loan to member');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (toDay(date) > toDay(loan.dueDate)) return fail('overdue');
    if (b.queue.length > 0) return fail('holds waiting');

    loan.dueDate = addDays(date, RENEW_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: loan.dueDate };
  }

  function placeHold(args) {
    const memberId = field(args, 'memberId');
    const bookId = field(args, 'bookId');
    const date = field(args, 'date');
    if (!tick(date)) return fail('invalid or past date');
    if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('not registered');
    if (b.status === 'available') return fail('book available');
    if (b.status === 'loan' && b.loanMember === memberId) return fail('member has book');
    if (b.queue.some((h) => h.memberId === memberId)) return fail('already held');
    if (m.holds.length >= MAX_HOLDS) return fail('hold limit');

    const seq = ++holdSeq;
    b.queue.push({ memberId, seq });
    m.holds.push({ bookId, seq });
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    const memberId = field(args, 'memberId');
    const amount = field(args, 'amount');
    const date = field(args, 'date');
    if (!tick(date)) return fail('invalid or past date');
    if (!isId(memberId)) return fail('invalid id');
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail('invalid amount');
    const m = members.get(memberId);
    if (!m) return fail('not registered');
    if (amount > m.owed) return fail('overpayment');
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const memberId = field(args, 'memberId');
    const date = field(args, 'date');
    if (!tick(date)) return fail('invalid or past date');
    if (!isId(memberId)) return fail('invalid id');
    const m = members.get(memberId);
    if (!m) return fail('not registered');

    const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate }));
    const holds = [...m.holds]
      .sort((a, b) => a.seq - b.seq)
      .map((h) => {
        const b = books.get(h.bookId);
        const i = b.queue.findIndex((q) => q.memberId === memberId);
        const readyUntil = b.status === 'aside' && i === 0 ? b.readyUntil : null;
        return { bookId: h.bookId, position: i + 1, readyUntil };
      });
    return { ok: true, loans, owed: m.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
