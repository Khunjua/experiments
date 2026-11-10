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

// Returns the day number (days since 1970-01-01, UTC) or null if s is not a valid date.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
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

const MIN_DAY = parseDate('0001-01-01');
const MAX_DAY = parseDate('9999-12-31');

function inRange(n) {
  return n >= MIN_DAY && n <= MAX_DAY;
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isObj(x) {
  return x !== null && typeof x === 'object';
}

export function createLibrary() {
  const books = new Map();   // bookId -> { id, state, queue: [memberId], loan, readyUntil }
  const members = new Map(); // memberId -> { loans: [bookId] (borrow order), holds: [bookId] (placed order), owed }
  let today = null;          // day number of current date, or null if unset

  const fail = () => ({ ok: false });

  function removeFromList(list, value) {
    const i = list.indexOf(value);
    if (i >= 0) list.splice(i, 1);
  }

  // Processes hold expiries for every book as of day d.
  function expire(d) {
    for (const book of books.values()) {
      while (book.state === 'shelf' && d > book.readyUntil) {
        const memberId = book.queue.shift();
        removeFromList(members.get(memberId).holds, book.id);
        if (book.queue.length > 0) {
          book.readyUntil = Math.min(book.readyUntil + 1 + PICKUP_DAYS, MAX_DAY);
        } else {
          book.state = 'available';
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates a dated call's date, advances the clock and processes expiry.
  // Returns the day number, or null if the date is invalid or earlier than the current date.
  function advance(dateStr) {
    const d = parseDate(dateStr);
    if (d === null) return null;
    if (today !== null && d < today) return null;
    today = d;
    expire(d);
    return d;
  }

  return {
    addBook(args) {
      if (!isObj(args) || !isId(args.bookId) || books.has(args.bookId)) return fail();
      books.set(args.bookId, {
        id: args.bookId,
        state: 'available',
        queue: [],
        loan: null,
        readyUntil: null,
      });
      return { ok: true };
    },

    addMember(args) {
      if (!isObj(args) || !isId(args.memberId) || members.has(args.memberId)) return fail();
      members.set(args.memberId, { loans: [], holds: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
      const d = advance(args.date);
      if (d === null) return fail();
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (b.state === 'loan') return fail();
      if (b.state === 'shelf' && b.queue[0] !== args.memberId) return fail();
      if (m.loans.length >= MAX_LOANS) return fail();
      for (const id of m.loans) {
        if (books.get(id).loan.dueDate < d) return fail();
      }
      if (m.owed >= BLOCK_OWED) return fail();
      const due = d + LOAN_DAYS;
      if (!inRange(due)) return fail();

      if (b.state === 'shelf') {
        b.queue.shift();
        removeFromList(m.holds, b.id);
      }
      b.state = 'loan';
      b.readyUntil = null;
      b.loan = { memberId: args.memberId, dueDate: due, renewals: 0 };
      m.loans.push(b.id);
      return { ok: true, dueDate: formatDate(due) };
    },

    returnBook(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
      const d = advance(args.date);
      if (d === null) return fail();
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (b.state !== 'loan' || b.loan.memberId !== args.memberId) return fail();
      if (b.queue.length > 0 && !inRange(d + PICKUP_DAYS)) return fail();

      const late = Math.max(0, d - b.loan.dueDate);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));

      m.owed += fine;
      removeFromList(m.loans, b.id);
      b.loan = null;
      if (b.queue.length === 0) {
        b.state = 'available';
        b.readyUntil = null;
      } else {
        b.state = 'shelf';
        b.readyUntil = d + PICKUP_DAYS;
      }
      return { ok: true, fine };
    },

    renew(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
      const d = advance(args.date);
      if (d === null) return fail();
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (b.state !== 'loan' || b.loan.memberId !== args.memberId) return fail();
      if (b.loan.renewals >= MAX_RENEWALS) return fail();
      if (d > b.loan.dueDate) return fail();
      if (b.queue.length > 0) return fail();
      const due = d + LOAN_DAYS;
      if (!inRange(due)) return fail();

      b.loan.renewals += 1;
      b.loan.dueDate = due;
      return { ok: true, dueDate: formatDate(due) };
    },

    placeHold(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
      const d = advance(args.date);
      if (d === null) return fail();
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (b.state === 'available') return fail();
      if (b.state === 'loan' && b.loan.memberId === args.memberId) return fail();
      if (b.queue.includes(args.memberId)) return fail();
      if (m.holds.length >= MAX_HOLDS) return fail();

      b.queue.push(args.memberId);
      m.holds.push(b.id);
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      if (!isObj(args) || !isId(args.memberId)) return fail();
      if (!Number.isSafeInteger(args.amount) || args.amount <= 0) return fail();
      const d = advance(args.date);
      if (d === null) return fail();
      const m = members.get(args.memberId);
      if (!m) return fail();
      if (args.amount > m.owed) return fail();

      m.owed -= args.amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      if (!isObj(args) || !isId(args.memberId)) return fail();
      const d = advance(args.date);
      if (d === null) return fail();
      const m = members.get(args.memberId);
      if (!m) return fail();

      const loans = m.loans.map((id) => ({
        bookId: id,
        dueDate: formatDate(books.get(id).loan.dueDate),
      }));
      const holds = m.holds.map((id) => {
        const b = books.get(id);
        const ready = b.state === 'shelf' && b.queue[0] === args.memberId;
        return {
          bookId: id,
          position: b.queue.indexOf(args.memberId) + 1,
          readyUntil: ready ? formatDate(b.readyUntil) : null,
        };
      });
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
