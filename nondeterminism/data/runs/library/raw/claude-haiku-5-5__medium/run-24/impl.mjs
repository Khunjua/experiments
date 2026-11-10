const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 7;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const MS_PER_DAY = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / MS_PER_DAY);
}

function formatDate(n) {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDay, renewals } | null, queue: [memberId], readyUntil: day | null }
  // readyUntil is set only when the book is not on loan and queue[0] is the holder it is set aside for.
  const books = new Map();
  // memberId -> { owed: cents }
  const members = new Map();

  // Process lapsed pickup windows up to and including `now`.
  function sweep(now) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && book.readyUntil < now) {
        book.queue.shift();
        if (book.queue.length === 0) {
          book.readyUntil = null;
          break;
        }
        const start = book.readyUntil + 1;
        book.readyUntil = start + PICKUP_DAYS;
      }
    }
  }

  return {
    addBook(args) {
      const { bookId } = args ?? {};
      if (!validId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      const { memberId } = args ?? {};
      if (!validId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      const { memberId, bookId, date } = args ?? {};
      const now = parseDate(date);
      const book = books.get(bookId);
      if (now === null || !members.has(memberId) || !book) return { ok: false };
      sweep(now);
      if (book.loan) return { ok: false };
      if (book.queue.length > 0) {
        if (book.queue[0] !== memberId || book.readyUntil === null || now > book.readyUntil) {
          return { ok: false };
        }
        book.queue.shift();
        book.readyUntil = null;
      }
      book.loan = { memberId, dueDay: now + LOAN_DAYS, renewals: 0 };
      return { ok: true, dueDate: formatDate(book.loan.dueDay) };
    },

    returnBook(args) {
      const { memberId, bookId, date } = args ?? {};
      const now = parseDate(date);
      const book = books.get(bookId);
      if (now === null || !members.has(memberId) || !book) return { ok: false };
      if (!book.loan || book.loan.memberId !== memberId) return { ok: false };
      sweep(now);
      const lateDays = Math.max(0, now - book.loan.dueDay - GRACE_DAYS);
      const fine = Math.min(lateDays * FINE_PER_DAY, FINE_CAP);
      book.loan = null;
      if (fine > 0) members.get(memberId).owed += fine;
      if (book.queue.length > 0) book.readyUntil = now + PICKUP_DAYS;
      return { ok: true, fine };
    },

    renew(args) {
      const { memberId, bookId, date } = args ?? {};
      const now = parseDate(date);
      const book = books.get(bookId);
      if (now === null || !members.has(memberId) || !book) return { ok: false };
      if (!book.loan || book.loan.memberId !== memberId) return { ok: false };
      sweep(now);
      if (now > book.loan.dueDay) return { ok: false };
      if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (book.queue.length > 0) return { ok: false };
      book.loan.renewals += 1;
      book.loan.dueDay = now + LOAN_DAYS;
      return { ok: true, dueDate: formatDate(book.loan.dueDay) };
    },

    placeHold(args) {
      const { memberId, bookId, date } = args ?? {};
      const now = parseDate(date);
      const book = books.get(bookId);
      if (now === null || !members.has(memberId) || !book) return { ok: false };
      sweep(now);
      // Only books that are not on the shelf can be held.
      if (!book.loan && book.queue.length === 0) return { ok: false };
      if (book.loan && book.loan.memberId === memberId) return { ok: false };
      if (book.queue.includes(memberId)) return { ok: false };
      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      const { memberId, amount, date } = args ?? {};
      const now = parseDate(date);
      const member = members.get(memberId);
      if (now === null || !member) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) return { ok: false };
      sweep(now);
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember(args) {
      const { memberId, date } = args ?? {};
      const now = parseDate(date);
      const member = members.get(memberId);
      if (now === null || !member) return { loans: [], owed: 0, holds: [] };
      sweep(now);
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: formatDate(book.loan.dueDay) });
        }
        const i = book.queue.indexOf(memberId);
        if (i !== -1) {
          const readyUntil = i === 0 && book.readyUntil !== null ? formatDate(book.readyUntil) : null;
          holds.push({ bookId, position: i + 1, readyUntil });
        }
      }
      return { loans, owed: member.owed, holds };
    },
  };
}
