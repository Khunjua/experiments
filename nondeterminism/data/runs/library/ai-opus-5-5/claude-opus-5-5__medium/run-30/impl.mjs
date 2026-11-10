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
const MAX_DAY = toDayNumber(9999, 12, 31);

function toDayNumber(y, m, d) {
  const t = new Date(0);
  t.setUTCHours(0, 0, 0, 0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / MS_PER_DAY);
}

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > dim) return null;
  return toDayNumber(y, m, d);
}

function formatDate(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1;
  const d = t.getUTCDate();
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isObj(a) {
  return typeof a === 'object' && a !== null;
}

const FAIL = () => ({ ok: false });

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, dueDate, renewals, seq} | null, queue: [{memberId, seq}], readyUntil: number|null }
  const members = new Map(); // memberId -> { owed }
  let currentDate = null;
  let seqCounter = 0;

  function processExpiry(day) {
    for (const book of books.values()) {
      while (!book.loan && book.queue.length > 0 && book.readyUntil !== null && day > book.readyUntil) {
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

  // Validates and applies the clock. Returns day number or null on failure.
  function startDated(args) {
    if (!isObj(args)) return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (currentDate !== null && day < currentDate) return null;
    currentDate = day;
    processExpiry(day);
    return day;
  }

  function memberLoans(memberId) {
    const loans = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) loans.push({ bookId, loan: book.loan });
    }
    loans.sort((a, b) => a.loan.seq - b.loan.seq);
    return loans;
  }

  function memberHolds(memberId) {
    const holds = [];
    for (const [bookId, book] of books) {
      book.queue.forEach((h, i) => {
        if (h.memberId === memberId) {
          const ready = i === 0 && !book.loan && book.readyUntil !== null;
          holds.push({ bookId, seq: h.seq, position: i + 1, readyUntil: ready ? book.readyUntil : null });
        }
      });
    }
    holds.sort((a, b) => a.seq - b.seq);
    return holds;
  }

  function safe(fn) {
    return (args) => {
      try {
        return fn(args);
      } catch {
        return FAIL();
      }
    };
  }

  return {
    addBook: safe((args) => {
      if (!isObj(args) || !isId(args.bookId) || books.has(args.bookId)) return FAIL();
      books.set(args.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    }),

    addMember: safe((args) => {
      if (!isObj(args) || !isId(args.memberId) || members.has(args.memberId)) return FAIL();
      members.set(args.memberId, { owed: 0 });
      return { ok: true };
    }),

    borrow: safe((args) => {
      const day = startDated(args);
      if (day === null) return FAIL();
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL();
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return FAIL();
      if (book.loan) return FAIL();
      const setAside = book.queue.length > 0;
      if (setAside && book.queue[0].memberId !== memberId) return FAIL();
      const loans = memberLoans(memberId);
      if (loans.length >= MAX_LOANS) return FAIL();
      if (loans.some((l) => l.loan.dueDate < day)) return FAIL();
      if (member.owed >= OWED_BLOCK) return FAIL();
      const dueDate = day + LOAN_DAYS;
      if (dueDate > MAX_DAY) return FAIL();
      if (setAside) book.queue.shift();
      book.readyUntil = null;
      book.loan = { memberId, dueDate, renewals: 0, seq: ++seqCounter };
      return { ok: true, dueDate: formatDate(dueDate) };
    }),

    returnBook: safe((args) => {
      const day = startDated(args);
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
      book.loan = null;
      book.readyUntil = book.queue.length > 0 ? day + PICKUP_DAYS : null;
      return { ok: true, fine };
    }),

    renew: safe((args) => {
      const day = startDated(args);
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
      const dueDate = day + RENEW_DAYS;
      if (dueDate > MAX_DAY) return FAIL();
      loan.dueDate = dueDate;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(dueDate) };
    }),

    placeHold: safe((args) => {
      const day = startDated(args);
      if (day === null) return FAIL();
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL();
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return FAIL();
      if (!book.loan && book.queue.length === 0) return FAIL();
      if (book.loan && book.loan.memberId === memberId) return FAIL();
      if (book.queue.some((h) => h.memberId === memberId)) return FAIL();
      if (memberHolds(memberId).length >= MAX_HOLDS) return FAIL();
      book.queue.push({ memberId, seq: ++seqCounter });
      return { ok: true, position: book.queue.length };
    }),

    payFine: safe((args) => {
      const day = startDated(args);
      if (day === null) return FAIL();
      const { memberId, amount } = args;
      if (!isId(memberId)) return FAIL();
      const member = members.get(memberId);
      if (!member) return FAIL();
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return FAIL();
      if (amount > member.owed) return FAIL();
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    }),

    getMember: safe((args) => {
      const day = startDated(args);
      if (day === null) return FAIL();
      const { memberId } = args;
      if (!isId(memberId)) return FAIL();
      const member = members.get(memberId);
      if (!member) return FAIL();
      return {
        ok: true,
        loans: memberLoans(memberId).map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.loan.dueDate) })),
        owed: member.owed,
        holds: memberHolds(memberId).map((h) => ({
          bookId: h.bookId,
          position: h.position,
          readyUntil: h.readyUntil === null ? null : formatDate(h.readyUntil),
        })),
      };
    }),
  };
}
