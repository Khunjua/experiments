const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_RATE = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(2000, 0, 1));
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return Math.round(dt.getTime() / MS_PER_DAY);
}

function formatDay(n) {
  const dt = new Date(n * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getArgs(a) {
  return a !== null && typeof a === 'object' ? a : null;
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, queue, readyUntil }
  const members = new Map(); // memberId -> { owed }
  let currentDay = null;
  let seq = 0;

  const FAIL = () => ({ ok: false });

  function processExpiry(day) {
    for (const book of books.values()) {
      while (book.loan === null && book.queue.length > 0 && day > book.readyUntil) {
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

  // Returns day number, or null on failure (invalid date or earlier than clock).
  function enterDated(args) {
    if (!args) return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (currentDay !== null && day < currentDay) return null;
    currentDay = day;
    processExpiry(day);
    return day;
  }

  function memberLoans(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) out.push({ bookId, loan: book.loan });
    }
    out.sort((a, b) => a.loan.seq - b.loan.seq);
    return out;
  }

  function memberHolds(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      const idx = book.queue.findIndex((h) => h.memberId === memberId);
      if (idx >= 0) out.push({ bookId, book, idx, seq: book.queue[idx].seq });
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  function isSetAside(book) {
    return book.loan === null && book.queue.length > 0;
  }

  return {
    addBook(a) {
      const args = getArgs(a);
      if (!args || !isId(args.bookId) || books.has(args.bookId)) return FAIL();
      books.set(args.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(a) {
      const args = getArgs(a);
      if (!args || !isId(args.memberId) || members.has(args.memberId)) return FAIL();
      members.set(args.memberId, { owed: 0 });
      return { ok: true };
    },

    borrow(a) {
      const args = getArgs(a);
      const day = enterDated(args);
      if (day === null) return FAIL();
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL();
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return FAIL();
      if (book.loan !== null) return FAIL();
      const setAside = isSetAside(book);
      if (setAside && book.queue[0].memberId !== memberId) return FAIL();
      const loans = memberLoans(memberId);
      if (loans.length >= MAX_LOANS) return FAIL();
      if (loans.some((l) => l.loan.dueDay < day)) return FAIL();
      if (member.owed >= BLOCK_OWED) return FAIL();
      if (setAside) {
        book.queue.shift();
        book.readyUntil = null;
      }
      const dueDay = day + LOAN_DAYS;
      book.loan = { memberId, dueDay, renewals: 0, seq: ++seq };
      return { ok: true, dueDate: formatDay(dueDay) };
    },

    returnBook(a) {
      const args = getArgs(a);
      const day = enterDated(args);
      if (day === null) return FAIL();
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL();
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return FAIL();
      if (!book.loan || book.loan.memberId !== memberId) return FAIL();
      const daysLate = Math.max(0, day - book.loan.dueDay);
      const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
      member.owed += fine;
      book.loan = null;
      book.readyUntil = book.queue.length > 0 ? day + PICKUP_DAYS : null;
      return { ok: true, fine };
    },

    renew(a) {
      const args = getArgs(a);
      const day = enterDated(args);
      if (day === null) return FAIL();
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL();
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return FAIL();
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return FAIL();
      if (loan.renewals >= MAX_RENEWALS) return FAIL();
      if (day > loan.dueDay) return FAIL();
      if (book.queue.length > 0) return FAIL();
      loan.dueDay = day + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.dueDay) };
    },

    placeHold(a) {
      const args = getArgs(a);
      const day = enterDated(args);
      if (day === null) return FAIL();
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL();
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return FAIL();
      if (book.loan === null && book.queue.length === 0) return FAIL();
      if (book.loan && book.loan.memberId === memberId) return FAIL();
      if (book.queue.some((h) => h.memberId === memberId)) return FAIL();
      if (memberHolds(memberId).length >= MAX_HOLDS) return FAIL();
      book.queue.push({ memberId, seq: ++seq });
      return { ok: true, position: book.queue.length };
    },

    payFine(a) {
      const args = getArgs(a);
      const day = enterDated(args);
      if (day === null) return FAIL();
      const { memberId, amount } = args;
      if (!isId(memberId)) return FAIL();
      const member = members.get(memberId);
      if (!member) return FAIL();
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return FAIL();
      if (amount > member.owed) return FAIL();
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember(a) {
      const args = getArgs(a);
      const day = enterDated(args);
      if (day === null) return FAIL();
      const { memberId } = args;
      if (!isId(memberId)) return FAIL();
      const member = members.get(memberId);
      if (!member) return FAIL();
      const loans = memberLoans(memberId).map((l) => ({
        bookId: l.bookId,
        dueDate: formatDay(l.loan.dueDay),
      }));
      const holds = memberHolds(memberId).map((h) => ({
        bookId: h.bookId,
        position: h.idx + 1,
        readyUntil:
          h.idx === 0 && h.book.loan === null && h.book.readyUntil !== null
            ? formatDay(h.book.readyUntil)
            : null,
      }));
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
