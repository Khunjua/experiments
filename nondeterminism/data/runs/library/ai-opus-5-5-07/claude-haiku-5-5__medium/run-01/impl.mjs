const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const BLOCK_THRESHOLD = 500;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

// Returns the UTC epoch day for a valid 'YYYY-MM-DD' string, or null.
function dayNumber(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt.getTime() / MS_PER_DAY;
}

function dateString(n) {
  const dt = new Date(n * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return dateString(dayNumber(s) + n);
}

function removeValue(arr, value) {
  const i = arr.indexOf(value);
  if (i !== -1) arr.splice(i, 1);
}

export function createLibrary() {
  // bookId -> { loanTo, dueDate, renewals, readyUntil, line }
  const books = new Map();
  // memberId -> { owed, loans: [bookId], holds: [bookId] }
  const members = new Map();

  const arg = (x) => (x !== null && typeof x === 'object' ? x : {});
  const fail = () => ({ ok: false });

  function expire(day) {
    for (const [bookId, book] of books) {
      while (
        book.loanTo === null &&
        book.readyUntil !== null &&
        day > dayNumber(book.readyUntil)
      ) {
        const reserved = book.line.shift();
        const m = members.get(reserved);
        if (m) removeValue(m.holds, bookId);
        book.readyUntil =
          book.line.length > 0 ? addDays(book.readyUntil, 1 + PICKUP_DAYS) : null;
      }
    }
  }

  return {
    addBook(input) {
      try {
        const a = arg(input);
        if (!isId(a.bookId) || books.has(a.bookId)) return fail();
        books.set(a.bookId, {
          loanTo: null,
          dueDate: null,
          renewals: 0,
          readyUntil: null,
          line: [],
        });
        return { ok: true };
      } catch {
        return fail();
      }
    },

    addMember(input) {
      try {
        const a = arg(input);
        if (!isId(a.memberId) || members.has(a.memberId)) return fail();
        members.set(a.memberId, { owed: 0, loans: [], holds: [] });
        return { ok: true };
      } catch {
        return fail();
      }
    },

    borrow(input) {
      try {
        const a = arg(input);
        const day = dayNumber(a.date);
        if (day === null) return fail();
        expire(day);
        if (!isId(a.memberId) || !isId(a.bookId)) return fail();
        const m = members.get(a.memberId);
        const b = books.get(a.bookId);
        if (!m || !b) return fail();
        if (b.loanTo !== null) return fail();
        if (b.readyUntil !== null && b.line[0] !== a.memberId) return fail();
        if (m.loans.some((id) => dayNumber(books.get(id).dueDate) < day)) return fail();
        if (m.owed >= BLOCK_THRESHOLD) return fail();

        const dueDate = dateString(day + LOAN_DAYS);
        if (b.readyUntil !== null) {
          // Set aside for this member: consume the hold.
          b.line.shift();
          removeValue(m.holds, a.bookId);
          b.readyUntil = null;
        }
        b.loanTo = a.memberId;
        b.dueDate = dueDate;
        b.renewals = 0;
        m.loans.push(a.bookId);
        return { ok: true, dueDate };
      } catch {
        return fail();
      }
    },

    returnBook(input) {
      try {
        const a = arg(input);
        const day = dayNumber(a.date);
        if (day === null) return fail();
        expire(day);
        if (!isId(a.memberId) || !isId(a.bookId)) return fail();
        const m = members.get(a.memberId);
        const b = books.get(a.bookId);
        if (!m || !b) return fail();
        if (b.loanTo !== a.memberId) return fail();

        const late = day - dayNumber(b.dueDate);
        const chargeable = Math.max(0, late - GRACE_DAYS);
        const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
        m.owed += fine;

        removeValue(m.loans, a.bookId);
        b.loanTo = null;
        b.dueDate = null;
        b.renewals = 0;
        if (b.line.length > 0) {
          b.readyUntil = dateString(day + PICKUP_DAYS);
        } else {
          b.readyUntil = null;
        }
        return { ok: true, fine };
      } catch {
        return fail();
      }
    },

    renew(input) {
      try {
        const a = arg(input);
        const day = dayNumber(a.date);
        if (day === null) return fail();
        expire(day);
        if (!isId(a.memberId) || !isId(a.bookId)) return fail();
        const m = members.get(a.memberId);
        const b = books.get(a.bookId);
        if (!m || !b) return fail();
        if (b.loanTo !== a.memberId) return fail();
        if (day > dayNumber(b.dueDate)) return fail();
        if (b.renewals >= MAX_RENEWALS) return fail();
        if (b.line.length > 0) return fail();
        if (m.owed >= BLOCK_THRESHOLD) return fail();

        b.dueDate = dateString(day + LOAN_DAYS);
        b.renewals += 1;
        return { ok: true, dueDate: b.dueDate };
      } catch {
        return fail();
      }
    },

    placeHold(input) {
      try {
        const a = arg(input);
        const day = dayNumber(a.date);
        if (day === null) return fail();
        expire(day);
        if (!isId(a.memberId) || !isId(a.bookId)) return fail();
        const m = members.get(a.memberId);
        const b = books.get(a.bookId);
        if (!m || !b) return fail();
        if (b.loanTo === null && b.readyUntil === null) return fail(); // available
        if (b.loanTo === a.memberId) return fail();
        if (b.line.includes(a.memberId)) return fail();

        b.line.push(a.memberId);
        m.holds.push(a.bookId);
        return { ok: true, position: b.line.length };
      } catch {
        return fail();
      }
    },

    payFine(input) {
      try {
        const a = arg(input);
        const day = dayNumber(a.date);
        if (day === null) return fail();
        expire(day);
        if (!isId(a.memberId)) return fail();
        if (!Number.isInteger(a.amount) || a.amount <= 0) return fail();
        const m = members.get(a.memberId);
        if (!m) return fail();
        if (a.amount > m.owed) return fail();

        m.owed -= a.amount;
        return { ok: true, owed: m.owed };
      } catch {
        return fail();
      }
    },

    getMember(input) {
      try {
        const a = arg(input);
        const day = dayNumber(a.date);
        if (day === null) return fail();
        expire(day);
        if (!isId(a.memberId)) return fail();
        const m = members.get(a.memberId);
        if (!m) return fail();

        const loans = m.loans.map((id) => ({
          bookId: id,
          dueDate: books.get(id).dueDate,
        }));
        const holds = m.holds.map((id) => {
          const b = books.get(id);
          const position = b.line.indexOf(a.memberId) + 1;
          const setAsideForMe =
            b.loanTo === null && b.readyUntil !== null && b.line[0] === a.memberId;
          return {
            bookId: id,
            position,
            readyUntil: setAsideForMe ? b.readyUntil : null,
          };
        });
        return { loans, owed: m.owed, holds };
      } catch {
        return fail();
      }
    },
  };
}
