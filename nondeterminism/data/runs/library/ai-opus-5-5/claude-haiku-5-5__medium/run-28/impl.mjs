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

function isObj(a) {
  return a !== null && typeof a === 'object';
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
function parseDay(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / DAY_MS);
}

function formatDay(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function readRefs(a, needBook) {
  if (!isObj(a)) return null;
  const memberId = a.memberId;
  const bookId = needBook ? a.bookId : undefined;
  const day = parseDay(a.date);
  if (!validId(memberId)) return null;
  if (needBook && !validId(bookId)) return null;
  if (day === null) return null;
  return { memberId, bookId, day };
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDay, renewals, seq }, queue: [{ memberId, seq }], readyUntil: day | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();
  let currentDay = null;
  let seq = 0;

  // Hold expiry (§7.4): applied for every book as of the call's day.
  function expire(day) {
    for (const book of books.values()) {
      while (book.loan === null && book.queue.length > 0 && book.readyUntil < day) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + PICKUP_DAYS + 1;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Advances the clock for a dated call. Returns false if the date is earlier than the current date.
  function advance(day) {
    if (currentDay !== null && day < currentDay) return false;
    currentDay = day;
    expire(day);
    return true;
  }

  // Loans of a member, oldest first.
  function loansOf(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      if (book.loan !== null && book.loan.memberId === memberId) {
        out.push({ bookId, loan: book.loan });
      }
    }
    out.sort((a, b) => a.loan.seq - b.loan.seq);
    return out;
  }

  // Active holds of a member (waiting or ready), oldest placed first.
  function holdsOf(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      book.queue.forEach((entry, index) => {
        if (entry.memberId === memberId) {
          out.push({ bookId, book, index, entry });
        }
      });
    }
    out.sort((a, b) => a.entry.seq - b.entry.seq);
    return out;
  }

  return {
    addBook(args) {
      if (!isObj(args) || !validId(args.bookId) || books.has(args.bookId)) {
        return { ok: false };
      }
      books.set(args.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      if (!isObj(args) || !validId(args.memberId) || members.has(args.memberId)) {
        return { ok: false };
      }
      members.set(args.memberId, { owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      const r = readRefs(args, true);
      if (r === null) return { ok: false };
      const { memberId, bookId, day } = r;
      if (!advance(day)) return { ok: false };

      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      if (book.loan !== null) return { ok: false };
      // Queue non-empty with no loan means the book is set aside for queue[0].
      if (book.queue.length > 0 && book.queue[0].memberId !== memberId) return { ok: false };

      const loans = loansOf(memberId);
      if (loans.length >= MAX_LOANS) return { ok: false };
      if (loans.some((l) => l.loan.dueDay < day)) return { ok: false };
      if (member.owed >= BLOCK_OWED) return { ok: false };

      if (book.queue.length > 0) {
        book.queue.shift();
      }
      book.readyUntil = null;
      seq += 1;
      const dueDay = day + LOAN_DAYS;
      book.loan = { memberId, dueDay, renewals: 0, seq };
      return { ok: true, dueDate: formatDay(dueDay) };
    },

    returnBook(args) {
      const r = readRefs(args, true);
      if (r === null) return { ok: false };
      const { memberId, bookId, day } = r;
      if (!advance(day)) return { ok: false };

      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      if (book.loan === null || book.loan.memberId !== memberId) return { ok: false };

      const daysLate = Math.max(0, day - book.loan.dueDay);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
      member.owed += fine;

      book.loan = null;
      book.readyUntil = book.queue.length > 0 ? day + PICKUP_DAYS : null;
      return { ok: true, fine };
    },

    renew(args) {
      const r = readRefs(args, true);
      if (r === null) return { ok: false };
      const { memberId, bookId, day } = r;
      if (!advance(day)) return { ok: false };

      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      const loan = book.loan;
      if (loan === null || loan.memberId !== memberId) return { ok: false };
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (day > loan.dueDay) return { ok: false };
      if (book.queue.length > 0) return { ok: false };

      loan.dueDay = day + RENEW_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.dueDay) };
    },

    placeHold(args) {
      const r = readRefs(args, true);
      if (r === null) return { ok: false };
      const { memberId, bookId, day } = r;
      if (!advance(day)) return { ok: false };

      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      // Available: no loan and empty queue.
      if (book.loan === null && book.queue.length === 0) return { ok: false };
      if (book.loan !== null && book.loan.memberId === memberId) return { ok: false };
      if (book.queue.some((e) => e.memberId === memberId)) return { ok: false };
      if (holdsOf(memberId).length >= MAX_HOLDS) return { ok: false };

      seq += 1;
      book.queue.push({ memberId, seq });
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      if (!isObj(args)) return { ok: false };
      const memberId = args.memberId;
      const amount = args.amount;
      const day = parseDay(args.date);
      if (!validId(memberId)) return { ok: false };
      if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false };
      if (day === null) return { ok: false };
      if (!advance(day)) return { ok: false };

      const member = members.get(memberId);
      if (!member) return { ok: false };
      if (amount > member.owed) return { ok: false };

      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember(args) {
      const r = readRefs(args, false);
      if (r === null) return { ok: false };
      const { memberId, day } = r;
      if (!advance(day)) return { ok: false };

      const member = members.get(memberId);
      if (!member) return { ok: false };

      const loans = loansOf(memberId).map(({ bookId, loan }) => ({
        bookId,
        dueDate: formatDay(loan.dueDay),
      }));

      const holds = holdsOf(memberId).map(({ bookId, book, index }) => ({
        bookId,
        position: index + 1,
        readyUntil:
          index === 0 && book.loan === null && book.readyUntil !== null
            ? formatDay(book.readyUntil)
            : null,
      }));

      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
