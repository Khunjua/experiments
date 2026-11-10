const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE = 1000;
const DEBT_LIMIT = 1000;
const PICKUP_DAYS = 7;

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > dim) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / DAY_MS);
}

function fmtDay(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fail(reason = 'not allowed') {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { state: 'available' | 'onLoan' | 'setAside', loanTo, readyDay, queue: [{ memberId, seq }] }
  const books = new Map();
  // memberId -> { owed, loans: [{ bookId, dueDay, renewals }] }
  const members = new Map();
  let lastDay = null;
  let holdSeq = 0;

  function expire(day) {
    for (const book of books.values()) {
      while (book.state === 'setAside' && day > book.readyDay) {
        book.queue.shift();
        const s = book.readyDay + 1;
        if (book.queue.length > 0) {
          book.readyDay = s + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.loanTo = null;
          book.readyDay = null;
        }
      }
    }
  }

  // Validates the date against the clock, advances the clock and runs
  // time processing. Returns the day number, or null if the call is rejected.
  function admit(dateStr) {
    const day = parseDay(dateStr);
    if (day === null) return null;
    if (lastDay !== null && day < lastDay) return null;
    lastDay = day;
    expire(day);
    return day;
  }

  function addBook(args) {
    const bookId = args?.bookId;
    if (!isId(bookId) || books.has(bookId)) return fail('invalid or duplicate book');
    books.set(bookId, { state: 'available', loanTo: null, readyDay: null, queue: [] });
    return { ok: true };
  }

  function addMember(args) {
    const memberId = args?.memberId;
    if (!isId(memberId) || members.has(memberId)) return fail('invalid or duplicate member');
    members.set(memberId, { owed: 0, loans: [] });
    return { ok: true };
  }

  function borrow(args) {
    const memberId = args?.memberId;
    const bookId = args?.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid arguments');
    const day = admit(args?.date);
    if (day === null) return fail('invalid or early date');
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('unknown member or book');
    if (b.state === 'onLoan') return fail('on loan');
    if (b.state === 'setAside' && b.queue[0].memberId !== memberId) return fail('set aside for another member');
    if (b.state === 'available' && b.queue.length > 0) return fail('book has queue');
    if (m.owed >= DEBT_LIMIT) return fail('debt limit');
    if (m.loans.some((l) => l.dueDay < day)) return fail('overdue loan');
    if (m.loans.length >= MAX_LOANS) return fail('loan limit');

    const dueDay = day + LOAN_DAYS;
    m.loans.push({ bookId, dueDay, renewals: 0 });
    if (b.state === 'setAside') b.queue.shift();
    b.state = 'onLoan';
    b.loanTo = memberId;
    b.readyDay = null;
    return { ok: true, dueDate: fmtDay(dueDay) };
  }

  function returnBook(args) {
    const memberId = args?.memberId;
    const bookId = args?.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid arguments');
    const day = admit(args?.date);
    if (day === null) return fail('invalid or early date');
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('unknown member or book');
    const idx = m.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0 || b.state !== 'onLoan' || b.loanTo !== memberId) return fail('not on loan to member');

    const loan = m.loans[idx];
    const late = Math.max(0, day - loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
    m.owed += fine;
    m.loans.splice(idx, 1);
    b.loanTo = null;
    if (b.queue.length > 0) {
      b.state = 'setAside';
      b.readyDay = day + PICKUP_DAYS;
    } else {
      b.state = 'available';
      b.readyDay = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const memberId = args?.memberId;
    const bookId = args?.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid arguments');
    const day = admit(args?.date);
    if (day === null) return fail('invalid or early date');
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('unknown member or book');
    const loan = m.loans.find((l) => l.bookId === bookId);
    if (!loan || b.state !== 'onLoan' || b.loanTo !== memberId) return fail('not on loan to member');
    if (day > loan.dueDay) return fail('overdue');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (b.queue.length > 0) return fail('someone is waiting');
    if (m.owed >= DEBT_LIMIT) return fail('debt limit');

    loan.dueDay += LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: fmtDay(loan.dueDay) };
  }

  function placeHold(args) {
    const memberId = args?.memberId;
    const bookId = args?.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid arguments');
    const day = admit(args?.date);
    if (day === null) return fail('invalid or early date');
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('unknown member or book');
    if (b.state === 'available') return fail('book is available');
    if (b.state === 'onLoan' && b.loanTo === memberId) return fail('already on loan to member');
    if (b.queue.some((e) => e.memberId === memberId)) return fail('hold already exists');

    b.queue.push({ memberId, seq: holdSeq++ });
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    const memberId = args?.memberId;
    const amount = args?.amount;
    if (!isId(memberId) || !Number.isInteger(amount)) return fail('invalid arguments');
    const day = admit(args?.date);
    if (day === null) return fail('invalid or early date');
    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    if (amount < 1) return fail('amount too small');
    if (amount > m.owed) return fail('overpayment');
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const memberId = args?.memberId;
    if (!isId(memberId)) return fail('invalid arguments');
    const day = admit(args?.date);
    if (day === null) return fail('invalid or early date');
    const m = members.get(memberId);
    if (!m) return fail('unknown member');

    const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: fmtDay(l.dueDay) }));

    const entries = [];
    for (const [bookId, b] of books) {
      const idx = b.queue.findIndex((e) => e.memberId === memberId);
      if (idx < 0) continue;
      const setAsideForMe = b.state === 'setAside' && idx === 0;
      entries.push({
        seq: b.queue[idx].seq,
        bookId,
        position: idx + 1,
        readyUntil: setAsideForMe ? fmtDay(b.readyDay) : null,
      });
    }
    entries.sort((x, y) => x.seq - y.seq);
    const holds = entries.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));

    return { loans, owed: m.owed, holds };
  }

  function safe(fn) {
    return (args) => {
      try {
        return fn(args);
      } catch {
        return fail('invalid input');
      }
    };
  }

  return {
    addBook: safe(addBook),
    addMember: safe(addMember),
    borrow: safe(borrow),
    returnBook: safe(returnBook),
    renew: safe(renew),
    placeHold: safe(placeHold),
    payFine: safe(payFine),
    getMember: safe(getMember),
  };
}
