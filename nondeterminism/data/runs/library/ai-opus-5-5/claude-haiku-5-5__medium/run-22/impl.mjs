const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const RENEW_LIMIT = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY_MS);
}

function formatDate(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const MAX_DAY = parseDate('9999-12-31');

function isObj(x) {
  return x !== null && typeof x === 'object';
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

const NO = () => ({ ok: false });

function guard(fn) {
  return (args) => {
    try {
      return fn(args);
    } catch {
      return { ok: false };
    }
  };
}

function readCall(args, withBook) {
  if (!isObj(args)) return null;
  const memberId = args.memberId;
  const bookId = withBook ? args.bookId : undefined;
  const day = parseDate(args.date);
  if (!validId(memberId)) return null;
  if (withBook && !validId(bookId)) return null;
  if (day === null) return null;
  return { memberId, bookId, day };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: null | {memberId, due, renewals}, queue: [memberId], readyUntil: number|null }
  const members = new Map(); // memberId -> { loans: [bookId], owed: number, holds: [bookId] }
  let now = null;

  function expire(today) {
    for (const [bookId, book] of books) {
      while (
        book.loan === null &&
        book.queue.length > 0 &&
        book.readyUntil !== null &&
        book.readyUntil < today
      ) {
        const expiredMember = book.queue.shift();
        const m = members.get(expiredMember);
        const idx = m.holds.indexOf(bookId);
        if (idx !== -1) m.holds.splice(idx, 1);
        if (book.queue.length > 0) {
          book.readyUntil = Math.min(book.readyUntil + 1 + PICKUP_DAYS, MAX_DAY);
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  function advance(day) {
    if (now !== null && day < now) return false;
    now = day;
    expire(day);
    return true;
  }

  return {
    addBook: guard((args) => {
      if (!isObj(args)) return NO();
      const bookId = args.bookId;
      if (!validId(bookId) || books.has(bookId)) return NO();
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    }),

    addMember: guard((args) => {
      if (!isObj(args)) return NO();
      const memberId = args.memberId;
      if (!validId(memberId) || members.has(memberId)) return NO();
      members.set(memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    }),

    borrow: guard((args) => {
      const c = readCall(args, true);
      if (c === null) return NO();
      const { memberId, bookId, day } = c;
      if (!advance(day)) return NO();
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return NO();
      if (b.loan !== null) return NO();
      if (b.queue.length > 0 && b.queue[0] !== memberId) return NO();
      if (m.loans.length >= MAX_LOANS) return NO();
      if (m.loans.some((id) => books.get(id).loan.due < day)) return NO();
      if (m.owed >= BLOCK_OWED) return NO();
      const due = day + LOAN_DAYS;
      if (due > MAX_DAY) return NO();
      if (b.queue.length > 0) {
        b.queue.shift();
        const idx = m.holds.indexOf(bookId);
        if (idx !== -1) m.holds.splice(idx, 1);
        b.readyUntil = null;
      }
      b.loan = { memberId, due, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate: formatDate(due) };
    }),

    returnBook: guard((args) => {
      const c = readCall(args, true);
      if (c === null) return NO();
      const { memberId, bookId, day } = c;
      if (!advance(day)) return NO();
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return NO();
      if (b.loan === null || b.loan.memberId !== memberId) return NO();
      const late = Math.max(0, day - b.loan.due);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
      if (b.queue.length > 0 && day + PICKUP_DAYS > MAX_DAY) return NO();
      m.owed += fine;
      m.loans.splice(m.loans.indexOf(bookId), 1);
      b.loan = null;
      b.readyUntil = b.queue.length > 0 ? day + PICKUP_DAYS : null;
      return { ok: true, fine };
    }),

    renew: guard((args) => {
      const c = readCall(args, true);
      if (c === null) return NO();
      const { memberId, bookId, day } = c;
      if (!advance(day)) return NO();
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return NO();
      if (b.loan === null || b.loan.memberId !== memberId) return NO();
      if (b.loan.renewals >= RENEW_LIMIT) return NO();
      if (day > b.loan.due) return NO();
      if (b.queue.length > 0) return NO();
      const due = day + LOAN_DAYS;
      if (due > MAX_DAY) return NO();
      b.loan.due = due;
      b.loan.renewals += 1;
      return { ok: true, dueDate: formatDate(due) };
    }),

    placeHold: guard((args) => {
      const c = readCall(args, true);
      if (c === null) return NO();
      const { memberId, bookId, day } = c;
      if (!advance(day)) return NO();
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return NO();
      if (b.loan === null && b.queue.length === 0) return NO();
      if (b.loan !== null && b.loan.memberId === memberId) return NO();
      if (b.queue.includes(memberId)) return NO();
      if (m.holds.length >= MAX_HOLDS) return NO();
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    }),

    payFine: guard((args) => {
      if (!isObj(args)) return NO();
      const memberId = args.memberId;
      const amount = args.amount;
      if (!validId(memberId) || !Number.isSafeInteger(amount) || amount <= 0) return NO();
      const day = parseDate(args.date);
      if (day === null) return NO();
      if (!advance(day)) return NO();
      const m = members.get(memberId);
      if (!m) return NO();
      if (amount > m.owed) return NO();
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    }),

    getMember: guard((args) => {
      const c = readCall(args, false);
      if (c === null) return NO();
      const { memberId, day } = c;
      if (!advance(day)) return NO();
      const m = members.get(memberId);
      if (!m) return NO();
      const loans = m.loans.map((bookId) => ({
        bookId,
        dueDate: formatDate(books.get(bookId).loan.due),
      }));
      const holds = m.holds.map((bookId) => {
        const b = books.get(bookId);
        const isReady = b.loan === null && b.queue[0] === memberId;
        return {
          bookId,
          position: b.queue.indexOf(memberId) + 1,
          readyUntil: isReady ? formatDate(b.readyUntil) : null,
        };
      });
      return { ok: true, loans, owed: m.owed, holds };
    }),
  };
}
