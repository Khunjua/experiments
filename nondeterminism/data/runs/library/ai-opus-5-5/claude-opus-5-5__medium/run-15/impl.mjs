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

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

// Convert a 'YYYY-MM-DD' string to a UTC day number, or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || y > 9999) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > daysInMonth(y, mo)) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  return Math.round(dt.getTime() / 86400000);
}

function formatDate(n) {
  const dt = new Date(n * 86400000);
  const y = dt.getUTCFullYear();
  const mo = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return (
    String(y).padStart(4, '0') + '-' +
    String(mo).padStart(2, '0') + '-' +
    String(d).padStart(2, '0')
  );
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function argObj(a) {
  return a !== null && typeof a === 'object' ? a : null;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, queue: [memberId], readyUntil }
  const members = new Map(); // memberId -> { owed, loans: [bookId], holds: [bookId] }
  let current = null;

  function removeFromArray(arr, v) {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1);
  }

  function processExpiry(day) {
    for (const [bookId, b] of books) {
      while (!b.loan && b.queue.length > 0 && day > b.readyUntil) {
        const prev = b.readyUntil;
        const mId = b.queue.shift();
        removeFromArray(members.get(mId).holds, bookId);
        if (b.queue.length > 0) {
          b.readyUntil = prev + 1 + PICKUP_DAYS;
        } else {
          b.readyUntil = null;
        }
      }
    }
  }

  // Validates the date; on success advances the clock and processes expiry.
  // Returns the day number, or null on failure (nothing changed).
  function enterDated(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    processExpiry(day);
    return day;
  }

  function addBook(arg) {
    const a = argObj(arg);
    if (!a || !isId(a.bookId)) return fail('invalid');
    if (books.has(a.bookId)) return fail('exists');
    books.set(a.bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(arg) {
    const a = argObj(arg);
    if (!a || !isId(a.memberId)) return fail('invalid');
    if (members.has(a.memberId)) return fail('exists');
    members.set(a.memberId, { owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(arg) {
    const a = argObj(arg);
    if (!a || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid');
    const day = enterDated(a.date);
    if (day === null) return fail('date');
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail('unknown');
    if (b.loan) return fail('on loan');
    const setAside = b.queue.length > 0;
    if (setAside && b.queue[0] !== a.memberId) return fail('set aside');
    if (m.loans.length >= MAX_LOANS) return fail('loan limit');
    for (const bid of m.loans) {
      if (books.get(bid).loan.due < day) return fail('overdue');
    }
    if (m.owed >= OWED_BLOCK) return fail('owed');
    if (setAside) {
      b.queue.shift();
      removeFromArray(m.holds, a.bookId);
      b.readyUntil = null;
    }
    const due = day + LOAN_DAYS;
    b.loan = { memberId: a.memberId, due, renewals: 0 };
    m.loans.push(a.bookId);
    return { ok: true, dueDate: formatDate(due) };
  }

  function returnBook(arg) {
    const a = argObj(arg);
    if (!a || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid');
    const day = enterDated(a.date);
    if (day === null) return fail('date');
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail('unknown');
    if (!b.loan || b.loan.memberId !== a.memberId) return fail('not on loan');
    const daysLate = Math.max(0, day - b.loan.due);
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
    m.owed += fine;
    b.loan = null;
    removeFromArray(m.loans, a.bookId);
    b.readyUntil = b.queue.length > 0 ? day + PICKUP_DAYS : null;
    return { ok: true, fine };
  }

  function renew(arg) {
    const a = argObj(arg);
    if (!a || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid');
    const day = enterDated(a.date);
    if (day === null) return fail('date');
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail('unknown');
    if (!b.loan || b.loan.memberId !== a.memberId) return fail('not on loan');
    if (b.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (day > b.loan.due) return fail('overdue');
    if (b.queue.length > 0) return fail('holds');
    b.loan.due = day + RENEW_DAYS;
    b.loan.renewals += 1;
    return { ok: true, dueDate: formatDate(b.loan.due) };
  }

  function placeHold(arg) {
    const a = argObj(arg);
    if (!a || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid');
    const day = enterDated(a.date);
    if (day === null) return fail('date');
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail('unknown');
    if (!b.loan && b.queue.length === 0) return fail('available');
    if (b.loan && b.loan.memberId === a.memberId) return fail('own loan');
    if (b.queue.includes(a.memberId)) return fail('duplicate');
    if (m.holds.length >= MAX_HOLDS) return fail('hold limit');
    b.queue.push(a.memberId);
    m.holds.push(a.bookId);
    return { ok: true, position: b.queue.length };
  }

  function payFine(arg) {
    const a = argObj(arg);
    if (!a || !isId(a.memberId)) return fail('invalid');
    if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return fail('amount');
    const day = enterDated(a.date);
    if (day === null) return fail('date');
    const m = members.get(a.memberId);
    if (!m) return fail('unknown');
    if (a.amount > m.owed) return fail('overpay');
    m.owed -= a.amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(arg) {
    const a = argObj(arg);
    if (!a || !isId(a.memberId)) return fail('invalid');
    const day = enterDated(a.date);
    if (day === null) return fail('date');
    const m = members.get(a.memberId);
    if (!m) return fail('unknown');
    const loans = m.loans.map((bid) => ({
      bookId: bid,
      dueDate: formatDate(books.get(bid).loan.due),
    }));
    const holds = m.holds.map((bid) => {
      const b = books.get(bid);
      const idx = b.queue.indexOf(a.memberId);
      const ready = !b.loan && idx === 0;
      return {
        bookId: bid,
        position: idx + 1,
        readyUntil: ready ? formatDate(b.readyUntil) : null,
      };
    });
    return { ok: true, loans, owed: m.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
