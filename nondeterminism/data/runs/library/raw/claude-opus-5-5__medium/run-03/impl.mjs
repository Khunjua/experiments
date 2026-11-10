const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 1;
const MAX_FINE_PER_LOAN = 500;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function formatDay(day) {
  const dt = new Date(day * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isId(v) {
  return (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isFinite(v));
}

const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDay, renewals } | null, holds: [{ memberId, readyUntil|null }] }
  const books = new Map();
  // memberId -> { owed, loans: [bookId], holds: [bookId] }
  const members = new Map();
  let lastDay = null;

  function processExpirations(day) {
    for (const [bookId, book] of books) {
      while (book.holds.length > 0 && book.holds[0].readyUntil !== null && book.holds[0].readyUntil < day) {
        const expired = book.holds.shift();
        const mem = members.get(expired.memberId);
        if (mem) mem.holds = mem.holds.filter((b) => b !== bookId);
        if (book.holds.length > 0) {
          book.holds[0].readyUntil = expired.readyUntil + 1 + PICKUP_DAYS;
        }
      }
    }
  }

  function enter(date) {
    const day = parseDate(date);
    if (day === null) return null;
    if (lastDay !== null && day < lastDay) return null;
    lastDay = day;
    processExpirations(day);
    return day;
  }

  function addBook(args) {
    const bookId = args && args.bookId;
    if (!isId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { loan: null, holds: [] });
    return { ok: true };
  }

  function addMember(args) {
    const memberId = args && args.memberId;
    if (!isId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const { memberId, bookId, date } = args || {};
    const mem = members.get(memberId);
    const book = books.get(bookId);
    if (!mem) return fail('unknown member');
    if (!book) return fail('unknown book');
    const day = enter(date);
    if (day === null) return fail('invalid date');
    if (book.loan) return fail('book on loan');
    let viaHold = false;
    if (book.holds.length > 0) {
      const head = book.holds[0];
      if (head.memberId !== memberId || head.readyUntil === null) return fail('book reserved');
      viaHold = true;
    }
    if (mem.loans.length >= MAX_LOANS) return fail('loan limit');
    if (mem.owed >= BORROW_BLOCK_OWED) return fail('fines owed');
    if (viaHold) {
      book.holds.shift();
      mem.holds = mem.holds.filter((b) => b !== bookId);
    }
    const dueDay = day + LOAN_DAYS;
    book.loan = { memberId, dueDay, renewals: 0 };
    mem.loans.push(bookId);
    return { ok: true, dueDate: formatDay(dueDay) };
  }

  function returnBook(args) {
    const { memberId, bookId, date } = args || {};
    const mem = members.get(memberId);
    const book = books.get(bookId);
    if (!mem) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
    const day = enter(date);
    if (day === null) return fail('invalid date');
    const late = day - book.loan.dueDay;
    let fine = 0;
    if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
    mem.owed += fine;
    mem.loans = mem.loans.filter((b) => b !== bookId);
    book.loan = null;
    if (book.holds.length > 0) book.holds[0].readyUntil = day + PICKUP_DAYS;
    return { ok: true, fine };
  }

  function renew(args) {
    const { memberId, bookId, date } = args || {};
    const mem = members.get(memberId);
    const book = books.get(bookId);
    if (!mem) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
    const day = enter(date);
    if (day === null) return fail('invalid date');
    if (day > book.loan.dueDay) return fail('overdue');
    if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (book.holds.length > 0) return fail('book has holds');
    book.loan.dueDay += LOAN_DAYS;
    book.loan.renewals += 1;
    return { ok: true, dueDate: formatDay(book.loan.dueDay) };
  }

  function placeHold(args) {
    const { memberId, bookId, date } = args || {};
    const mem = members.get(memberId);
    const book = books.get(bookId);
    if (!mem) return fail('unknown member');
    if (!book) return fail('unknown book');
    const day = enter(date);
    if (day === null) return fail('invalid date');
    if (!book.loan && book.holds.length === 0) return fail('book is available');
    if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
    if (book.holds.some((h) => h.memberId === memberId)) return fail('already holding');
    if (mem.holds.length >= MAX_HOLDS) return fail('hold limit');
    book.holds.push({ memberId, readyUntil: null });
    mem.holds.push(bookId);
    return { ok: true, position: book.holds.length };
  }

  function payFine(args) {
    const { memberId, amount, date } = args || {};
    const mem = members.get(memberId);
    if (!mem) return fail('unknown member');
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail('invalid amount');
    const day = enter(date);
    if (day === null) return fail('invalid date');
    if (amount > mem.owed) return fail('overpayment');
    mem.owed -= amount;
    return { ok: true, owed: mem.owed };
  }

  function getMember(args) {
    const { memberId, date } = args || {};
    const mem = members.get(memberId);
    if (!mem) return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
    const day = enter(date);
    if (day === null) return { ok: false, reason: 'invalid date', loans: [], owed: 0, holds: [] };
    const loans = mem.loans.map((bookId) => ({
      bookId,
      dueDate: formatDay(books.get(bookId).loan.dueDay),
    }));
    const holds = mem.holds.map((bookId) => {
      const q = books.get(bookId).holds;
      const idx = q.findIndex((h) => h.memberId === memberId);
      const h = q[idx];
      return {
        bookId,
        position: idx + 1,
        readyUntil: h.readyUntil === null ? null : formatDay(h.readyUntil),
      };
    });
    return { ok: true, loans, owed: mem.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
