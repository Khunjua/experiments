const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

// Returns the day number (days since 1970-01-01, UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
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

function isObj(a) {
  return a !== null && typeof a === 'object';
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let today = null;
  let seq = 0;

  // Validates a date for a dated call without side effects.
  // Returns the day number, or null if invalid or earlier than the current date.
  function checkDate(date) {
    const day = parseDate(date);
    if (day === null) return null;
    if (today !== null && day < today) return null;
    return day;
  }

  // Advances the clock and processes hold expiries up to day.
  function advance(day) {
    today = day;
    processExpiries(day);
  }

  function processExpiries(day) {
    for (const book of books.values()) {
      while (book.ready && book.readyUntil < day) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.ready = false;
          book.readyUntil = null;
        }
      }
    }
  }

  function loansOf(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      if (book.loanMember === memberId) out.push({ bookId, book });
    }
    return out;
  }

  function activeHoldCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      for (const h of book.queue) if (h.memberId === memberId) n++;
    }
    return n;
  }

  function newBook() {
    return {
      loanMember: null,
      loanDue: null,
      loanRenewals: 0,
      loanSeq: 0,
      ready: false,
      readyUntil: null,
      queue: [], // holds: { memberId, seq }
    };
  }

  const FAIL = Object.freeze({ ok: false });

  return {
    addBook(args) {
      if (!isObj(args) || !validId(args.bookId)) return { ok: false };
      if (books.has(args.bookId)) return { ok: false };
      books.set(args.bookId, newBook());
      return { ok: true };
    },

    addMember(args) {
      if (!isObj(args) || !validId(args.memberId)) return { ok: false };
      if (members.has(args.memberId)) return { ok: false };
      members.set(args.memberId, { owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) return { ok: false };
      const day = checkDate(args.date);
      if (day === null) return { ok: false };
      advance(day);

      const { memberId, bookId } = args;
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      if (book.loanMember !== null) return { ok: false };
      if (book.ready && book.queue[0].memberId !== memberId) return { ok: false };

      const loans = loansOf(memberId);
      if (loans.length >= MAX_LOANS) return { ok: false };
      if (loans.some((l) => l.book.loanDue < day)) return { ok: false };
      if (member.owed >= BLOCK_OWED) return { ok: false };

      const dueDay = day + LOAN_DAYS;
      if (dueDay > MAX_DAY) return { ok: false };

      book.loanMember = memberId;
      book.loanDue = dueDay;
      book.loanRenewals = 0;
      book.loanSeq = ++seq;
      if (book.ready) {
        book.queue.shift();
        book.ready = false;
        book.readyUntil = null;
      }
      return { ok: true, dueDate: formatDate(dueDay) };
    },

    returnBook(args) {
      if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) return { ok: false };
      const day = checkDate(args.date);
      if (day === null) return { ok: false };
      advance(day);

      const { memberId, bookId } = args;
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      if (book.loanMember !== memberId) return { ok: false };
      if (book.queue.length > 0 && day + PICKUP_DAYS > MAX_DAY) return { ok: false };

      const daysLate = Math.max(0, day - book.loanDue);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));

      member.owed += fine;
      book.loanMember = null;
      book.loanDue = null;
      book.loanRenewals = 0;
      book.loanSeq = 0;
      if (book.queue.length > 0) {
        book.ready = true;
        book.readyUntil = day + PICKUP_DAYS;
      }
      return { ok: true, fine };
    },

    renew(args) {
      if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) return { ok: false };
      const day = checkDate(args.date);
      if (day === null) return { ok: false };
      advance(day);

      const { memberId, bookId } = args;
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      if (book.loanMember !== memberId) return { ok: false };
      if (book.loanRenewals >= MAX_RENEWALS) return { ok: false };
      if (day > book.loanDue) return { ok: false };
      if (book.queue.length > 0) return { ok: false };

      const newDue = day + RENEWAL_DAYS;
      if (newDue > MAX_DAY) return { ok: false };

      book.loanDue = newDue;
      book.loanRenewals += 1;
      return { ok: true, dueDate: formatDate(newDue) };
    },

    placeHold(args) {
      if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) return { ok: false };
      const day = checkDate(args.date);
      if (day === null) return { ok: false };
      advance(day);

      const { memberId, bookId } = args;
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      if (book.loanMember === null && !book.ready) return { ok: false };
      if (book.loanMember === memberId) return { ok: false };
      if (book.queue.some((h) => h.memberId === memberId)) return { ok: false };
      if (activeHoldCount(memberId) >= MAX_HOLDS) return { ok: false };

      book.queue.push({ memberId, seq: ++seq });
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      if (!isObj(args) || !validId(args.memberId)) return { ok: false };
      const amount = args.amount;
      if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false };
      const day = checkDate(args.date);
      if (day === null) return { ok: false };
      advance(day);

      const member = members.get(args.memberId);
      if (!member) return { ok: false };
      if (amount > member.owed) return { ok: false };

      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember(args) {
      if (!isObj(args) || !validId(args.memberId)) return { ok: false };
      const day = checkDate(args.date);
      if (day === null) return { ok: false };
      advance(day);

      const memberId = args.memberId;
      const member = members.get(memberId);
      if (!member) return { ok: false };

      const loans = loansOf(memberId)
        .sort((a, b) => a.book.loanSeq - b.book.loanSeq)
        .map(({ bookId, book }) => ({ bookId, dueDate: formatDate(book.loanDue) }));

      const found = [];
      for (const [bookId, book] of books) {
        for (const h of book.queue) {
          if (h.memberId === memberId) found.push({ h, bookId, book });
        }
      }
      const holds = found
        .sort((a, b) => a.h.seq - b.h.seq)
        .map(({ h, bookId, book }) => ({
          bookId,
          position: book.queue.indexOf(h) + 1,
          readyUntil: book.ready && book.queue[0] === h ? formatDate(book.readyUntil) : null,
        }));

      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
