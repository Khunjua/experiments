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

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > dim) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  return Math.round(dt.getTime() / MS_PER_DAY);
}

function formatDate(n) {
  const dt = new Date(n * MS_PER_DAY);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isArgs(a) {
  return typeof a === 'object' && a !== null;
}

const FAIL = () => ({ ok: false });

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, queue: [hold], readyUntil }
  const members = new Map(); // memberId -> { loans: [bookId], owed, holds: [hold] }
  let currentDate = null;

  function removeFromMemberHolds(hold) {
    const m = members.get(hold.memberId);
    const i = m.holds.indexOf(hold);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function processExpiry(day) {
    for (const book of books.values()) {
      while (!book.loan && book.queue.length > 0 && day > book.readyUntil) {
        const expired = book.queue.shift();
        removeFromMemberHolds(expired);
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates the date, enforces the clock, advances it and runs expiry.
  // Returns the day number, or null if the call must fail.
  function clock(args) {
    if (!isArgs(args)) return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (currentDate !== null && day < currentDate) return null;
    currentDate = day;
    processExpiry(day);
    return day;
  }

  function setAsideFor(book) {
    if (!book.loan && book.queue.length > 0) return book.queue[0].memberId;
    return null;
  }

  return {
    addBook(args) {
      if (!isArgs(args) || !isId(args.bookId)) return FAIL();
      if (books.has(args.bookId)) return FAIL();
      books.set(args.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      if (!isArgs(args) || !isId(args.memberId)) return FAIL();
      if (members.has(args.memberId)) return FAIL();
      members.set(args.memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },

    borrow(args) {
      const day = clock(args);
      if (day === null) return FAIL();
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL();
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return FAIL();
      if (book.loan) return FAIL();
      const reserved = setAsideFor(book);
      if (reserved !== null && reserved !== memberId) return FAIL();
      if (member.loans.length >= MAX_LOANS) return FAIL();
      for (const bid of member.loans) {
        if (books.get(bid).loan.dueDate < day) return FAIL();
      }
      if (member.owed >= OWED_BLOCK) return FAIL();

      if (reserved === memberId) {
        const hold = book.queue.shift();
        removeFromMemberHolds(hold);
        book.readyUntil = null;
      }
      const dueDate = day + LOAN_DAYS;
      book.loan = { memberId, dueDate, renewals: 0 };
      member.loans.push(bookId);
      return { ok: true, dueDate: formatDate(dueDate) };
    },

    returnBook(args) {
      const day = clock(args);
      if (day === null) return FAIL();
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL();
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return FAIL();
      if (!book.loan || book.loan.memberId !== memberId) return FAIL();

      const daysLate = Math.max(0, day - book.loan.dueDate);
      const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
      member.owed += fine;
      const i = member.loans.indexOf(bookId);
      if (i >= 0) member.loans.splice(i, 1);
      book.loan = null;
      book.readyUntil = book.queue.length > 0 ? day + PICKUP_DAYS : null;
      return { ok: true, fine };
    },

    renew(args) {
      const day = clock(args);
      if (day === null) return FAIL();
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL();
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return FAIL();
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return FAIL();
      if (loan.renewals >= MAX_RENEWALS) return FAIL();
      if (day > loan.dueDate) return FAIL();
      if (book.queue.length > 0) return FAIL();
      loan.dueDate = day + RENEW_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(loan.dueDate) };
    },

    placeHold(args) {
      const day = clock(args);
      if (day === null) return FAIL();
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL();
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return FAIL();
      if (!book.loan && book.queue.length === 0) return FAIL();
      if (book.loan && book.loan.memberId === memberId) return FAIL();
      if (book.queue.some(h => h.memberId === memberId)) return FAIL();
      if (member.holds.length >= MAX_HOLDS) return FAIL();
      const hold = { memberId, bookId };
      book.queue.push(hold);
      member.holds.push(hold);
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      const day = clock(args);
      if (day === null) return FAIL();
      const { memberId, amount } = args;
      if (!isId(memberId)) return FAIL();
      if (!Number.isSafeInteger(amount) || amount <= 0) return FAIL();
      const member = members.get(memberId);
      if (!member) return FAIL();
      if (amount > member.owed) return FAIL();
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember(args) {
      const day = clock(args);
      if (day === null) return FAIL();
      const { memberId } = args;
      if (!isId(memberId)) return FAIL();
      const member = members.get(memberId);
      if (!member) return FAIL();
      const loans = member.loans.map(bid => ({
        bookId: bid,
        dueDate: formatDate(books.get(bid).loan.dueDate),
      }));
      const holds = member.holds.map(h => {
        const book = books.get(h.bookId);
        const idx = book.queue.indexOf(h);
        const ready = !book.loan && idx === 0;
        return {
          bookId: h.bookId,
          position: idx + 1,
          readyUntil: ready ? formatDate(book.readyUntil) : null,
        };
      });
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
