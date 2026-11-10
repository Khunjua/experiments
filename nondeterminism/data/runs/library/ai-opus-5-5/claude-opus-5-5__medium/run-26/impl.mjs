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
const MS_PER_DAY = 86400000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

// Returns a whole-day number (days since 1970-01-01 UTC), or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDate(day) {
  const t = new Date(day * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { loanMember: string|null, queue: [{ memberId, seq, readyUntil }] }
  const books = new Map();
  // memberId -> { loans: Map<bookId, { dueDay, renewals }>, owed }
  const members = new Map();
  let currentDay = null;
  let holdSeq = 0;

  function isSetAside(book) {
    return book.loanMember === null && book.queue.length > 0;
  }

  function processExpiry(day) {
    for (const book of books.values()) {
      while (isSetAside(book) && day > book.queue[0].readyUntil) {
        const prev = book.queue[0].readyUntil;
        book.queue.shift();
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = prev + 1 + PICKUP_DAYS;
        }
      }
    }
  }

  // Validates args object and date, advances clock, runs expiry.
  // Returns { day } or { error }.
  function enterDated(args) {
    if (args === null || typeof args !== 'object') return { error: 'invalid arguments' };
    const day = parseDate(args.date);
    if (day === null) return { error: 'invalid date' };
    if (currentDay !== null && day < currentDay) return { error: 'date earlier than current date' };
    currentDay = day;
    processExpiry(day);
    return { day };
  }

  function memberHolds(memberId) {
    const result = [];
    for (const [bookId, book] of books) {
      for (let i = 0; i < book.queue.length; i++) {
        const h = book.queue[i];
        if (h.memberId === memberId) {
          result.push({
            bookId,
            seq: h.seq,
            position: i + 1,
            readyUntil: i === 0 && isSetAside(book) ? formatDate(h.readyUntil) : null,
          });
        }
      }
    }
    result.sort((a, b) => a.seq - b.seq);
    return result;
  }

  function guard(fn) {
    return (args) => {
      try {
        return fn(args);
      } catch {
        return fail('internal error');
      }
    };
  }

  const addBook = guard((args) => {
    if (args === null || typeof args !== 'object') return fail('invalid arguments');
    const { bookId } = args;
    if (!isId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book already registered');
    books.set(bookId, { loanMember: null, queue: [] });
    return { ok: true };
  });

  const addMember = guard((args) => {
    if (args === null || typeof args !== 'object') return fail('invalid arguments');
    const { memberId } = args;
    if (!isId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member already registered');
    members.set(memberId, { loans: new Map(), owed: 0 });
    return { ok: true };
  });

  const borrow = guard((args) => {
    const e = enterDated(args);
    if (e.error) return fail(e.error);
    const day = e.day;
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (book.loanMember !== null) return fail('book on loan');
    const setAside = isSetAside(book);
    if (setAside && book.queue[0].memberId !== memberId) return fail('set aside for another member');
    if (member.loans.size >= MAX_LOANS) return fail('loan limit reached');
    for (const loan of member.loans.values()) {
      if (loan.dueDay < day) return fail('member has overdue loan');
    }
    if (member.owed >= OWED_BLOCK) return fail('owed too much');

    if (setAside) book.queue.shift();
    const dueDay = day + LOAN_DAYS;
    book.loanMember = memberId;
    member.loans.set(bookId, { dueDay, renewals: 0 });
    return { ok: true, dueDate: formatDate(dueDay) };
  });

  const returnBook = guard((args) => {
    const e = enterDated(args);
    if (e.error) return fail(e.error);
    const day = e.day;
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (book.loanMember !== memberId) return fail('not on loan to member');
    const loan = member.loans.get(bookId);
    if (!loan) return fail('not on loan to member');

    const daysLate = Math.max(0, day - loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
    member.owed += fine;
    member.loans.delete(bookId);
    book.loanMember = null;
    if (book.queue.length > 0) {
      book.queue[0].readyUntil = day + PICKUP_DAYS;
    }
    return { ok: true, fine };
  });

  const renew = guard((args) => {
    const e = enterDated(args);
    if (e.error) return fail(e.error);
    const day = e.day;
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (book.loanMember !== memberId) return fail('not on loan to member');
    const loan = member.loans.get(bookId);
    if (!loan) return fail('not on loan to member');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
    if (day > loan.dueDay) return fail('loan overdue');
    if (book.queue.length > 0) return fail('holds exist');

    loan.dueDay = day + RENEW_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDay) };
  });

  const placeHold = guard((args) => {
    const e = enterDated(args);
    if (e.error) return fail(e.error);
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (book.loanMember === null && book.queue.length === 0) return fail('book available');
    if (book.loanMember === memberId) return fail('member has book on loan');
    if (book.queue.some((h) => h.memberId === memberId)) return fail('already holding');
    if (memberHolds(memberId).length >= MAX_HOLDS) return fail('hold limit reached');

    book.queue.push({ memberId, seq: ++holdSeq, readyUntil: null });
    return { ok: true, position: book.queue.length };
  });

  const payFine = guard((args) => {
    const e = enterDated(args);
    if (e.error) return fail(e.error);
    const { memberId, amount } = args;
    if (!isId(memberId)) return fail('invalid id');
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
      return fail('invalid amount');
    }
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    if (amount > member.owed) return fail('overpayment');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  });

  const getMember = guard((args) => {
    const e = enterDated(args);
    if (e.error) return fail(e.error);
    const { memberId } = args;
    if (!isId(memberId)) return fail('invalid id');
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    const loans = [];
    for (const [bookId, loan] of member.loans) {
      loans.push({ bookId, dueDate: formatDate(loan.dueDay) });
    }
    const holds = memberHolds(memberId).map((h) => ({
      bookId: h.bookId,
      position: h.position,
      readyUntil: h.readyUntil,
    }));
    return { ok: true, loans, owed: member.owed, holds };
  });

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
