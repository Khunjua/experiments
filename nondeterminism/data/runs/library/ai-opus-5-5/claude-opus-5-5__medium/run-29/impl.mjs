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

function civilToDays(y, m, d) {
  return Math.round(Date.UTC(2000, m - 1, d) / 86400000) + yearOffsetDays(y);
}

// Days between 2000-01-01 and y-01-01, computed without relying on Date's
// two-digit-year mapping.
function yearOffsetDays(y) {
  const leapsBefore = (yy) => Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400);
  // Number of days from year 2000 start to year y start.
  return (y - 2000) * 365 + (leapsBefore(y - 1) - leapsBefore(1999));
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  // Month/day within year y: compute day-of-year independently of Date year mapping.
  let doy = d - 1;
  for (let i = 1; i < m; i++) doy += daysInMonth(y, i);
  return yearOffsetDays(y) + doy + Math.round(Date.UTC(2000, 0, 1) / 86400000);
}

function formatDate(n) {
  // Find year by estimation, then adjust.
  const base = Math.round(Date.UTC(2000, 0, 1) / 86400000);
  let rel = n - base;
  let y = 2000 + Math.floor(rel / 365.2425);
  while (yearOffsetDays(y) > rel) y--;
  while (yearOffsetDays(y + 1) <= rel) y++;
  let doy = rel - yearOffsetDays(y);
  let m = 1;
  while (doy >= daysInMonth(y, m)) {
    doy -= daysInMonth(y, m);
    m++;
  }
  const d = doy + 1;
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function getArgs(a) {
  return a !== null && typeof a === 'object' ? a : null;
}

const FAIL = () => ({ ok: false });

export function createLibrary() {
  const books = new Map(); // bookId -> { loan, queue: [{memberId, seq}], readyUntil }
  const members = new Map(); // memberId -> { loans: [bookId], owed }
  let currentDate = null;
  let holdSeq = 0;

  function processExpiry(day) {
    for (const book of books.values()) {
      while (book.loan === null && book.queue.length > 0 && book.readyUntil !== null && day > book.readyUntil) {
        const prev = book.readyUntil;
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = prev + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns day number or null. Advances clock and processes expiry when date is valid and not earlier.
  function enterDated(a) {
    if (!a) return null;
    const day = parseDate(a.date);
    if (day === null) return null;
    if (currentDate !== null && day < currentDate) return null;
    currentDate = day;
    processExpiry(day);
    return day;
  }

  function activeHoldCount(memberId) {
    let c = 0;
    for (const book of books.values()) {
      for (const h of book.queue) if (h.memberId === memberId) c++;
    }
    return c;
  }

  function safe(fn) {
    return (arg) => {
      try {
        return fn(arg);
      } catch {
        return FAIL();
      }
    };
  }

  const addBook = safe((arg) => {
    const a = getArgs(arg);
    if (!a || !isId(a.bookId) || books.has(a.bookId)) return FAIL();
    books.set(a.bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  });

  const addMember = safe((arg) => {
    const a = getArgs(arg);
    if (!a || !isId(a.memberId) || members.has(a.memberId)) return FAIL();
    members.set(a.memberId, { loans: [], owed: 0 });
    return { ok: true };
  });

  const borrow = safe((arg) => {
    const a = getArgs(arg);
    const day = enterDated(a);
    if (day === null) return FAIL();
    if (!isId(a.memberId) || !isId(a.bookId)) return FAIL();
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return FAIL();
    if (book.loan !== null) return FAIL();
    const setAside = book.queue.length > 0;
    if (setAside && book.queue[0].memberId !== a.memberId) return FAIL();
    if (member.loans.length >= MAX_LOANS) return FAIL();
    for (const bid of member.loans) {
      if (books.get(bid).loan.dueDate < day) return FAIL();
    }
    if (member.owed >= OWED_BLOCK) return FAIL();
    if (setAside) {
      book.queue.shift();
      book.readyUntil = null;
    }
    const dueDate = day + LOAN_DAYS;
    book.loan = { memberId: a.memberId, dueDate, renewals: 0 };
    member.loans.push(a.bookId);
    return { ok: true, dueDate: formatDate(dueDate) };
  });

  const returnBook = safe((arg) => {
    const a = getArgs(arg);
    const day = enterDated(a);
    if (day === null) return FAIL();
    if (!isId(a.memberId) || !isId(a.bookId)) return FAIL();
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return FAIL();
    if (book.loan === null || book.loan.memberId !== a.memberId) return FAIL();
    const daysLate = Math.max(0, day - book.loan.dueDate);
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
    member.owed += fine;
    book.loan = null;
    const idx = member.loans.indexOf(a.bookId);
    if (idx >= 0) member.loans.splice(idx, 1);
    if (book.queue.length > 0) {
      book.readyUntil = day + PICKUP_DAYS;
    } else {
      book.readyUntil = null;
    }
    return { ok: true, fine };
  });

  const renew = safe((arg) => {
    const a = getArgs(arg);
    const day = enterDated(a);
    if (day === null) return FAIL();
    if (!isId(a.memberId) || !isId(a.bookId)) return FAIL();
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return FAIL();
    const loan = book.loan;
    if (loan === null || loan.memberId !== a.memberId) return FAIL();
    if (loan.renewals >= MAX_RENEWALS) return FAIL();
    if (day > loan.dueDate) return FAIL();
    if (book.queue.length > 0) return FAIL();
    loan.dueDate = Math.max(loan.dueDate, day + RENEW_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDate) };
  });

  const placeHold = safe((arg) => {
    const a = getArgs(arg);
    const day = enterDated(a);
    if (day === null) return FAIL();
    if (!isId(a.memberId) || !isId(a.bookId)) return FAIL();
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return FAIL();
    if (book.loan === null && book.queue.length === 0) return FAIL();
    if (book.loan !== null && book.loan.memberId === a.memberId) return FAIL();
    if (book.queue.some((h) => h.memberId === a.memberId)) return FAIL();
    if (activeHoldCount(a.memberId) >= MAX_HOLDS) return FAIL();
    book.queue.push({ memberId: a.memberId, seq: ++holdSeq });
    return { ok: true, position: book.queue.length };
  });

  const payFine = safe((arg) => {
    const a = getArgs(arg);
    const day = enterDated(a);
    if (day === null) return FAIL();
    if (!isId(a.memberId)) return FAIL();
    const member = members.get(a.memberId);
    if (!member) return FAIL();
    const amount = a.amount;
    if (!Number.isSafeInteger(amount) || amount <= 0) return FAIL();
    if (amount > member.owed) return FAIL();
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  });

  const getMember = safe((arg) => {
    const a = getArgs(arg);
    const day = enterDated(a);
    if (day === null) return FAIL();
    if (!isId(a.memberId)) return FAIL();
    const member = members.get(a.memberId);
    if (!member) return FAIL();
    const loans = member.loans.map((bid) => ({
      bookId: bid,
      dueDate: formatDate(books.get(bid).loan.dueDate),
    }));
    const found = [];
    for (const [bid, book] of books) {
      book.queue.forEach((h, i) => {
        if (h.memberId === a.memberId) {
          const ready = i === 0 && book.loan === null && book.readyUntil !== null;
          found.push({
            seq: h.seq,
            hold: {
              bookId: bid,
              position: i + 1,
              readyUntil: ready ? formatDate(book.readyUntil) : null,
            },
          });
        }
      });
    }
    found.sort((x, y) => x.seq - y.seq);
    return { ok: true, loans, owed: member.owed, holds: found.map((f) => f.hold) };
  });

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
