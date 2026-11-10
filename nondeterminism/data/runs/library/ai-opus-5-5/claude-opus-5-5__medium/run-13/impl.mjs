const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_RATE = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const OWED_BLOCK = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  return Math.round(dt.getTime() / DAY_MS);
}

const MAX_DAY = parseDate('9999-12-31');

function formatDate(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  function isSetAside(book) {
    return book.loan === null && book.queue.length > 0;
  }

  function removeMemberHold(memberId, bookId) {
    const m = members.get(memberId);
    if (!m) return;
    const i = m.holds.indexOf(bookId);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function processExpiry(day) {
    for (const [bookId, book] of books) {
      while (isSetAside(book) && day > book.readyUntil) {
        const prev = book.readyUntil;
        const expired = book.queue.shift();
        removeMemberHold(expired, bookId);
        if (book.queue.length > 0) {
          book.readyUntil = prev + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates the argument object and date, advances clock, runs expiry.
  // Returns day number or null.
  function enter(args) {
    if (args === null || typeof args !== 'object') return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    processExpiry(day);
    return day;
  }

  function addBook(args) {
    if (args === null || typeof args !== 'object' || !isId(args.bookId)) return fail('invalid');
    if (books.has(args.bookId)) return fail('exists');
    books.set(args.bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (args === null || typeof args !== 'object' || !isId(args.memberId)) return fail('invalid');
    if (members.has(args.memberId)) return fail('exists');
    members.set(args.memberId, { loans: [], owed: 0, holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const day = enter(args);
    if (day === null) return fail('invalid');
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan !== null) return fail('on loan');
    const setAside = isSetAside(book);
    if (setAside && book.queue[0] !== memberId) return fail('set aside for another');
    if (member.loans.length >= MAX_LOANS) return fail('loan limit');
    if (member.loans.some((l) => l.due < day)) return fail('overdue');
    if (member.owed >= OWED_BLOCK) return fail('owes');
    const due = day + LOAN_DAYS;
    if (due > MAX_DAY) return fail('date out of range');
    if (setAside) {
      book.queue.shift();
      book.readyUntil = null;
      removeMemberHold(memberId, bookId);
    }
    book.loan = memberId;
    member.loans.push({ bookId, due, renewals: 0 });
    return { ok: true, dueDate: formatDate(due) };
  }

  function returnBook(args) {
    const day = enter(args);
    if (day === null) return fail('invalid');
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan !== memberId) return fail('not on loan to member');
    const idx = member.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0) return fail('not on loan to member');
    const loan = member.loans[idx];
    const daysLate = Math.max(0, day - loan.due);
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
    member.owed += fine;
    member.loans.splice(idx, 1);
    book.loan = null;
    book.readyUntil = book.queue.length > 0 ? day + PICKUP_DAYS : null;
    return { ok: true, fine };
  }

  function renew(args) {
    const day = enter(args);
    if (day === null) return fail('invalid');
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan !== memberId) return fail('not on loan to member');
    const loan = member.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('not on loan to member');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (day > loan.due) return fail('overdue');
    if (book.queue.length > 0) return fail('holds exist');
    const due = day + LOAN_DAYS;
    if (due > MAX_DAY) return fail('date out of range');
    loan.due = due;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(due) };
  }

  function placeHold(args) {
    const day = enter(args);
    if (day === null) return fail('invalid');
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan === null && book.queue.length === 0) return fail('available');
    if (book.loan === memberId) return fail('member has book');
    if (book.queue.includes(memberId)) return fail('already held');
    if (member.holds.length >= MAX_HOLDS) return fail('hold limit');
    book.queue.push(memberId);
    member.holds.push(bookId);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    const day = enter(args);
    if (day === null) return fail('invalid');
    const { memberId, amount } = args;
    if (!isId(memberId)) return fail('invalid');
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail('invalid amount');
    const member = members.get(memberId);
    if (!member) return fail('unknown');
    if (amount > member.owed) return fail('overpayment');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const day = enter(args);
    if (day === null) return fail('invalid');
    const { memberId } = args;
    if (!isId(memberId)) return fail('invalid');
    const member = members.get(memberId);
    if (!member) return fail('unknown');
    const loans = member.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.due) }));
    const holds = member.holds.map((bookId) => {
      const book = books.get(bookId);
      const position = book.queue.indexOf(memberId) + 1;
      const ready = book.loan === null && position === 1;
      return { bookId, position, readyUntil: ready ? formatDate(book.readyUntil) : null };
    });
    return { ok: true, loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
