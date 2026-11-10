const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / DAY_MS);
}

function formatDate(n) {
  const t = new Date(n * DAY_MS);
  return String(t.getUTCFullYear()).padStart(4, '0') + '-' +
    String(t.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(t.getUTCDate()).padStart(2, '0');
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

// Validates a dated argument object. Returns normalized fields or null.
function fields(arg, needBook) {
  if (!arg || typeof arg !== 'object') return null;
  const date = parseDate(arg.date);
  if (date === null) return null;
  if (!isId(arg.memberId)) return null;
  if (needBook && !isId(arg.bookId)) return null;
  return { memberId: arg.memberId, bookId: arg.bookId, date };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { id, loan, queue, readyUntil }
  const members = new Map(); // memberId -> { loans: [bookId], holds: [bookId], owed }
  let current = null;        // current day number, null until first dated call

  function removeMemberHold(memberId, bookId) {
    const member = members.get(memberId);
    if (!member) return;
    const idx = member.holds.indexOf(bookId);
    if (idx >= 0) member.holds.splice(idx, 1);
  }

  function removeMemberLoan(memberId, bookId) {
    const member = members.get(memberId);
    if (!member) return;
    const idx = member.loans.indexOf(bookId);
    if (idx >= 0) member.loans.splice(idx, 1);
  }

  // Processes hold expiries for every book as of day `now`.
  function expire(now) {
    for (const book of books.values()) {
      if (book.loan !== null) continue;
      while (book.queue.length > 0 && book.readyUntil < now) {
        const expiredMemberId = book.queue.shift();
        removeMemberHold(expiredMemberId, book.id);
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Advances the clock for a dated call. Returns false if the date is earlier.
  function advance(date) {
    if (current !== null && date < current) return false;
    current = date;
    expire(current);
    return true;
  }

  return {
    addBook(arg) {
      if (!arg || typeof arg !== 'object' || !isId(arg.bookId) || books.has(arg.bookId)) {
        return { ok: false };
      }
      books.set(arg.bookId, { id: arg.bookId, loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(arg) {
      if (!arg || typeof arg !== 'object' || !isId(arg.memberId) || members.has(arg.memberId)) {
        return { ok: false };
      }
      members.set(arg.memberId, { loans: [], holds: [], owed: 0 });
      return { ok: true };
    },

    borrow(arg) {
      const a = fields(arg, true);
      if (!a || !advance(a.date)) return { ok: false };
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return { ok: false };
      if (book.loan !== null) return { ok: false };
      if (book.queue.length > 0 && book.queue[0] !== a.memberId) return { ok: false };
      if (member.loans.length >= MAX_LOANS) return { ok: false };
      for (const id of member.loans) {
        if (books.get(id).loan.dueDate < a.date) return { ok: false };
      }
      if (member.owed >= BLOCK_OWED) return { ok: false };

      const dueDate = a.date + LOAN_DAYS;
      book.loan = { memberId: a.memberId, dueDate, renewals: 0 };
      member.loans.push(a.bookId);
      if (book.queue.length > 0) {
        // The queue head is this member (checked above): fulfil the hold.
        book.queue.shift();
        removeMemberHold(a.memberId, a.bookId);
      }
      book.readyUntil = null;
      return { ok: true, dueDate: formatDate(dueDate) };
    },

    returnBook(arg) {
      const a = fields(arg, true);
      if (!a || !advance(a.date)) return { ok: false };
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return { ok: false };
      if (book.loan === null || book.loan.memberId !== a.memberId) return { ok: false };

      const daysLate = Math.max(0, a.date - book.loan.dueDate);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));

      member.owed += fine;
      book.loan = null;
      removeMemberLoan(a.memberId, a.bookId);
      book.readyUntil = book.queue.length > 0 ? a.date + PICKUP_DAYS : null;
      return { ok: true, fine };
    },

    renew(arg) {
      const a = fields(arg, true);
      if (!a || !advance(a.date)) return { ok: false };
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return { ok: false };
      if (book.loan === null || book.loan.memberId !== a.memberId) return { ok: false };
      if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (a.date > book.loan.dueDate) return { ok: false };
      if (book.queue.length > 0) return { ok: false };

      book.loan.dueDate = a.date + LOAN_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: formatDate(book.loan.dueDate) };
    },

    placeHold(arg) {
      const a = fields(arg, true);
      if (!a || !advance(a.date)) return { ok: false };
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return { ok: false };
      if (book.loan === null && book.queue.length === 0) return { ok: false };
      if (book.loan !== null && book.loan.memberId === a.memberId) return { ok: false };
      if (member.holds.includes(a.bookId)) return { ok: false };
      if (member.holds.length >= MAX_HOLDS) return { ok: false };

      book.queue.push(a.memberId);
      member.holds.push(a.bookId);
      return { ok: true, position: book.queue.length };
    },

    payFine(arg) {
      if (!arg || typeof arg !== 'object') return { ok: false };
      const date = parseDate(arg.date);
      if (date === null || !isId(arg.memberId)) return { ok: false };
      if (!Number.isSafeInteger(arg.amount) || arg.amount <= 0) return { ok: false };
      if (!advance(date)) return { ok: false };
      const member = members.get(arg.memberId);
      if (!member) return { ok: false };
      if (arg.amount > member.owed) return { ok: false };

      member.owed -= arg.amount;
      return { ok: true, owed: member.owed };
    },

    getMember(arg) {
      const a = fields(arg, false);
      if (!a || !advance(a.date)) return { ok: false };
      const member = members.get(a.memberId);
      if (!member) return { ok: false };

      const loans = member.loans.map((id) => ({
        bookId: id,
        dueDate: formatDate(books.get(id).loan.dueDate),
      }));
      const holds = member.holds.map((id) => {
        const book = books.get(id);
        const position = book.queue.indexOf(a.memberId) + 1;
        const ready = book.loan === null && position === 1;
        return {
          bookId: id,
          position,
          readyUntil: ready ? formatDate(book.readyUntil) : null,
        };
      });
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
