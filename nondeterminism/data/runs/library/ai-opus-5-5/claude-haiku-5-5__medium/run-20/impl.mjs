const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

// Parses 'YYYY-MM-DD' into a day number (days since 1970-01-01, UTC).
// Returns null when the string is not a real calendar date in years 0001-9999.
function parseDate(s) {
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

// Formats a day number back to 'YYYY-MM-DD'.
function formatDate(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isObject(a) {
  return a !== null && typeof a === 'object';
}

function removeOne(arr, value) {
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1);
}

function fail() {
  return { ok: false };
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDay, renewals }, queue: [memberId], readyUntil: day | null }
  const books = new Map();
  // memberId -> { loans: [bookId] (borrow order), holds: [bookId] (placed order), owed: cents }
  const members = new Map();
  let today = null; // current day number, unset until the first dated call

  // Processes hold expiries for every book, as of day `now`.
  function expire(now) {
    for (const book of books.values()) {
      if (book.loan) continue;
      while (book.queue.length > 0 && book.readyUntil < now) {
        const memberId = book.queue.shift();
        removeOne(members.get(memberId).holds, bookIdOf(book));
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Maps a book object back to its id. Books are stored with their id in `id`.
  function bookIdOf(book) {
    return book.id;
  }

  // Returns the day number of a usable date (valid and not earlier than the clock), else null.
  // Does not change state.
  function usable(s) {
    const d = parseDate(s);
    if (d === null) return null;
    if (today !== null && d < today) return null;
    return d;
  }

  // Sets the clock to day `d` and runs hold expiry. Call only after usable() succeeded.
  function advance(d) {
    today = d;
    expire(d);
  }

  return {
    addBook(a) {
      if (!isObject(a) || !isId(a.bookId) || books.has(a.bookId)) return fail();
      books.set(a.bookId, { id: a.bookId, loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(a) {
      if (!isObject(a) || !isId(a.memberId) || members.has(a.memberId)) return fail();
      members.set(a.memberId, { loans: [], holds: [], owed: 0 });
      return { ok: true };
    },

    borrow(a) {
      if (!isObject(a) || !isId(a.memberId) || !isId(a.bookId)) return fail();
      const d = usable(a.date);
      if (d === null) return fail();
      advance(d);

      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail();
      if (b.loan) return fail();

      const setAside = b.queue.length > 0;
      if (setAside && b.queue[0] !== a.memberId) return fail();
      if (m.loans.length >= MAX_LOANS) return fail();
      for (const id of m.loans) {
        if (books.get(id).loan.dueDay < d) return fail(); // overdue loan
      }
      if (m.owed >= BLOCK_OWED) return fail();

      b.loan = { memberId: a.memberId, dueDay: d + LOAN_DAYS, renewals: 0 };
      m.loans.push(a.bookId);
      if (setAside) {
        b.queue.shift();
        removeOne(m.holds, a.bookId);
        b.readyUntil = null;
      }
      return { ok: true, dueDate: formatDate(d + LOAN_DAYS) };
    },

    returnBook(a) {
      if (!isObject(a) || !isId(a.memberId) || !isId(a.bookId)) return fail();
      const d = usable(a.date);
      if (d === null) return fail();
      advance(d);

      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail();
      if (!b.loan || b.loan.memberId !== a.memberId) return fail();

      const daysLate = Math.max(0, d - b.loan.dueDay);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
      m.owed += fine;
      removeOne(m.loans, a.bookId);
      b.loan = null;
      if (b.queue.length > 0) {
        b.readyUntil = d + PICKUP_DAYS;
      } else {
        b.readyUntil = null;
      }
      return { ok: true, fine };
    },

    renew(a) {
      if (!isObject(a) || !isId(a.memberId) || !isId(a.bookId)) return fail();
      const d = usable(a.date);
      if (d === null) return fail();
      advance(d);

      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail();
      if (!b.loan || b.loan.memberId !== a.memberId) return fail();
      if (b.loan.renewals >= MAX_RENEWALS) return fail();
      if (d > b.loan.dueDay) return fail(); // overdue
      if (b.queue.length > 0) return fail();

      b.loan.dueDay = d + LOAN_DAYS;
      b.loan.renewals += 1;
      return { ok: true, dueDate: formatDate(b.loan.dueDay) };
    },

    placeHold(a) {
      if (!isObject(a) || !isId(a.memberId) || !isId(a.bookId)) return fail();
      const d = usable(a.date);
      if (d === null) return fail();
      advance(d);

      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail();
      if (!b.loan && b.queue.length === 0) return fail(); // available
      if (b.loan && b.loan.memberId === a.memberId) return fail();
      if (m.holds.includes(a.bookId)) return fail();
      if (m.holds.length >= MAX_HOLDS) return fail();

      b.queue.push(a.memberId);
      m.holds.push(a.bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine(a) {
      if (!isObject(a) || !isId(a.memberId)) return fail();
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return fail();
      const d = usable(a.date);
      if (d === null) return fail();
      advance(d);

      const m = members.get(a.memberId);
      if (!m) return fail();
      if (a.amount > m.owed) return fail();
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },

    getMember(a) {
      if (!isObject(a) || !isId(a.memberId)) return fail();
      const d = usable(a.date);
      if (d === null) return fail();
      advance(d);

      const m = members.get(a.memberId);
      if (!m) return fail();

      const loans = m.loans.map((id) => ({
        bookId: id,
        dueDate: formatDate(books.get(id).loan.dueDay),
      }));

      const holds = m.holds.map((id) => {
        const b = books.get(id);
        const position = b.queue.indexOf(a.memberId) + 1;
        const settled = !b.loan && b.queue[0] === a.memberId;
        return {
          bookId: id,
          position,
          readyUntil: settled ? formatDate(b.readyUntil) : null,
        };
      });

      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
