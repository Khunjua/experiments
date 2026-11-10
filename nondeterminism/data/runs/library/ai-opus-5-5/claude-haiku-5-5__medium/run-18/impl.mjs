const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt.getTime() / DAY_MS;
}

function formatDate(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const MAX_DAY = parseDate('9999-12-31');

function isObj(a) {
  return a !== null && typeof a === 'object';
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

export function createLibrary() {
  // bookId -> { loanMember: string|null, renewals unused on book, queue: [memberId], readyUntil: day|null }
  const books = new Map();
  // memberId -> { loans: [{ bookId, dueDate (day), renewals }], owed: cents, holds: [bookId] }
  const members = new Map();
  let current = null;

  // Checks date validity and monotonicity. Does not change state.
  function checkDate(v) {
    const day = parseDate(v);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    return day;
  }

  function advance(day) {
    current = day;
    expire(day);
  }

  function expire(day) {
    for (const book of books.values()) {
      while (
        book.loanMember === null &&
        book.queue.length > 0 &&
        book.readyUntil !== null &&
        day > book.readyUntil
      ) {
        const expiredMemberId = book.queue.shift();
        const m = members.get(expiredMemberId);
        if (m) {
          const idx = m.holds.indexOf(findBookIdFor(book));
          if (idx >= 0) m.holds.splice(idx, 1);
        }
        if (book.queue.length > 0) {
          book.readyUntil = Math.min(MAX_DAY, book.readyUntil + 1 + PICKUP_DAYS);
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Helper used during expiry: the bookId whose Map value is this book object.
  // Set in a closure-free way via a reverse lookup established at addBook time.
  const bookIdOf = new Map();
  function findBookIdFor(book) {
    return bookIdOf.get(book);
  }

  return {
    addBook(arg) {
      if (!isObj(arg) || !isId(arg.bookId)) return { ok: false };
      if (books.has(arg.bookId)) return { ok: false };
      const book = { loanMember: null, queue: [], readyUntil: null };
      books.set(arg.bookId, book);
      bookIdOf.set(book, arg.bookId);
      return { ok: true };
    },

    addMember(arg) {
      if (!isObj(arg) || !isId(arg.memberId)) return { ok: false };
      if (members.has(arg.memberId)) return { ok: false };
      members.set(arg.memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },

    borrow(arg) {
      if (!isObj(arg) || !isId(arg.memberId) || !isId(arg.bookId)) return { ok: false };
      const day = checkDate(arg.date);
      if (day === null) return { ok: false };
      advance(day);

      const m = members.get(arg.memberId);
      const b = books.get(arg.bookId);
      if (!m || !b) return { ok: false };
      if (m.loans.length >= MAX_LOANS) return { ok: false };
      if (m.owed >= BLOCK_OWED) return { ok: false };
      if (m.loans.some((l) => l.dueDate < day)) return { ok: false };
      if (b.loanMember !== null) return { ok: false };
      if (b.queue.length > 0 && b.queue[0] !== arg.memberId) return { ok: false };

      const due = day + LOAN_DAYS;
      if (due > MAX_DAY) return { ok: false };

      if (b.queue.length > 0) {
        // Set aside for this member: fulfil the hold.
        b.queue.shift();
        const idx = m.holds.indexOf(arg.bookId);
        if (idx >= 0) m.holds.splice(idx, 1);
        b.readyUntil = null;
      }
      b.loanMember = arg.memberId;
      m.loans.push({ bookId: arg.bookId, dueDate: due, renewals: 0 });
      return { ok: true, dueDate: formatDate(due) };
    },

    returnBook(arg) {
      if (!isObj(arg) || !isId(arg.memberId) || !isId(arg.bookId)) return { ok: false };
      const day = checkDate(arg.date);
      if (day === null) return { ok: false };
      advance(day);

      const m = members.get(arg.memberId);
      const b = books.get(arg.bookId);
      if (!m || !b) return { ok: false };
      const li = m.loans.findIndex((l) => l.bookId === arg.bookId);
      if (li < 0 || b.loanMember !== arg.memberId) return { ok: false };

      const loan = m.loans[li];
      const lateDays = day - loan.dueDate;
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, lateDays - GRACE_DAYS));

      m.owed += fine;
      m.loans.splice(li, 1);
      b.loanMember = null;
      if (b.queue.length === 0) {
        b.readyUntil = null;
      } else {
        b.readyUntil = Math.min(MAX_DAY, day + PICKUP_DAYS);
      }
      return { ok: true, fine };
    },

    renew(arg) {
      if (!isObj(arg) || !isId(arg.memberId) || !isId(arg.bookId)) return { ok: false };
      const day = checkDate(arg.date);
      if (day === null) return { ok: false };
      advance(day);

      const m = members.get(arg.memberId);
      const b = books.get(arg.bookId);
      if (!m || !b) return { ok: false };
      const loan = m.loans.find((l) => l.bookId === arg.bookId);
      if (!loan || b.loanMember !== arg.memberId) return { ok: false };
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (day > loan.dueDate) return { ok: false };
      if (b.queue.length > 0) return { ok: false };

      const due = day + RENEW_DAYS;
      if (due > MAX_DAY) return { ok: false };
      loan.dueDate = due;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(due) };
    },

    placeHold(arg) {
      if (!isObj(arg) || !isId(arg.memberId) || !isId(arg.bookId)) return { ok: false };
      const day = checkDate(arg.date);
      if (day === null) return { ok: false };
      advance(day);

      const m = members.get(arg.memberId);
      const b = books.get(arg.bookId);
      if (!m || !b) return { ok: false };
      if (b.loanMember === null && b.queue.length === 0) return { ok: false };
      if (b.loanMember === arg.memberId) return { ok: false };
      if (b.queue.includes(arg.memberId)) return { ok: false };
      if (m.holds.length >= MAX_HOLDS) return { ok: false };

      b.queue.push(arg.memberId);
      m.holds.push(arg.bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine(arg) {
      if (!isObj(arg) || !isId(arg.memberId)) return { ok: false };
      const amount = arg.amount;
      if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false };
      const day = checkDate(arg.date);
      if (day === null) return { ok: false };
      advance(day);

      const m = members.get(arg.memberId);
      if (!m) return { ok: false };
      if (amount > m.owed) return { ok: false };
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(arg) {
      if (!isObj(arg) || !isId(arg.memberId)) return { ok: false };
      const day = checkDate(arg.date);
      if (day === null) return { ok: false };
      advance(day);

      const m = members.get(arg.memberId);
      if (!m) return { ok: false };

      const loans = m.loans.map((l) => ({
        bookId: l.bookId,
        dueDate: formatDate(l.dueDate),
      }));

      const holds = m.holds.map((bookId) => {
        const b = books.get(bookId);
        const idx = b.queue.indexOf(arg.memberId);
        const setAsideForMe = b.loanMember === null && idx === 0 && b.readyUntil !== null;
        return {
          bookId,
          position: idx + 1,
          readyUntil: setAsideForMe ? formatDate(b.readyUntil) : null,
        };
      });

      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
