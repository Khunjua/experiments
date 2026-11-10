const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const BLOCK_THRESHOLD = 500;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}

// Epoch day number for a valid 'YYYY-MM-DD' string (UTC, no time zones).
function toDay(s) {
  const t = new Date(0);
  t.setUTCFullYear(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round(t.getTime() / MS_PER_DAY);
}

function fromDay(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return fromDay(toDay(s) + n);
}

function dropFirst(list, value) {
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1);
}

function safe(fn, onError) {
  try {
    return fn();
  } catch {
    return onError();
  }
}

const FAIL = () => ({ ok: false });

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null, holds: [memberId], readyDay: number | null }
  const books = new Map();
  // memberId -> { owed: number, loans: [bookId], holds: [bookId] }
  const members = new Map();

  // Expiry processing (§5.4) for date D.
  function runExpiry(date) {
    const D = toDay(date);
    for (const [bookId, book] of books) {
      while (
        book.loan === null &&
        book.holds.length > 0 &&
        book.readyDay !== null &&
        D > book.readyDay
      ) {
        const gone = book.holds.shift();
        const m = members.get(gone);
        if (m) dropFirst(m.holds, bookId);
        book.readyDay = book.holds.length > 0
          ? book.readyDay + 1 + PICKUP_DAYS
          : null;
      }
    }
  }

  return {
    addBook(args) {
      return safe(() => {
        const bookId = args?.bookId;
        if (!isId(bookId) || books.has(bookId)) return { ok: false };
        books.set(bookId, { loan: null, holds: [], readyDay: null });
        return { ok: true };
      }, FAIL);
    },

    addMember(args) {
      return safe(() => {
        const memberId = args?.memberId;
        if (!isId(memberId) || members.has(memberId)) return { ok: false };
        members.set(memberId, { owed: 0, loans: [], holds: [] });
        return { ok: true };
      }, FAIL);
    },

    borrow(args) {
      return safe(() => {
        const memberId = args?.memberId;
        const bookId = args?.bookId;
        const date = args?.date;
        if (!isDate(date)) return { ok: false };
        runExpiry(date);
        if (!isId(memberId) || !isId(bookId)) return { ok: false };
        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return { ok: false };
        if (b.loan !== null) return { ok: false };
        if (b.holds.length > 0 && b.holds[0] !== memberId) return { ok: false };
        const D = toDay(date);
        if (m.loans.some(id => toDay(books.get(id).loan.dueDate) < D)) return { ok: false };
        if (m.owed >= BLOCK_THRESHOLD) return { ok: false };

        const dueDate = addDays(date, LOAN_DAYS);
        b.loan = { memberId, dueDate, renewals: 0 };
        if (b.holds.length > 0) {
          b.holds.shift();
          dropFirst(m.holds, bookId);
        }
        b.readyDay = null;
        m.loans.push(bookId);
        return { ok: true, dueDate };
      }, FAIL);
    },

    returnBook(args) {
      return safe(() => {
        const memberId = args?.memberId;
        const bookId = args?.bookId;
        const date = args?.date;
        if (!isDate(date)) return { ok: false };
        runExpiry(date);
        if (!isId(memberId) || !isId(bookId)) return { ok: false };
        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return { ok: false };
        if (b.loan === null || b.loan.memberId !== memberId) return { ok: false };

        const late = toDay(date) - toDay(b.loan.dueDate);
        const chargeable = Math.max(0, late - GRACE_DAYS);
        const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);

        m.owed += fine;
        dropFirst(m.loans, bookId);
        b.loan = null;
        b.readyDay = b.holds.length > 0 ? toDay(date) + PICKUP_DAYS : null;
        return { ok: true, fine };
      }, FAIL);
    },

    renew(args) {
      return safe(() => {
        const memberId = args?.memberId;
        const bookId = args?.bookId;
        const date = args?.date;
        if (!isDate(date)) return { ok: false };
        runExpiry(date);
        if (!isId(memberId) || !isId(bookId)) return { ok: false };
        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return { ok: false };
        if (b.loan === null || b.loan.memberId !== memberId) return { ok: false };
        if (toDay(date) > toDay(b.loan.dueDate)) return { ok: false };
        if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
        if (b.holds.length > 0) return { ok: false };
        if (m.owed >= BLOCK_THRESHOLD) return { ok: false };

        b.loan.dueDate = addDays(date, LOAN_DAYS);
        b.loan.renewals += 1;
        return { ok: true, dueDate: b.loan.dueDate };
      }, FAIL);
    },

    placeHold(args) {
      return safe(() => {
        const memberId = args?.memberId;
        const bookId = args?.bookId;
        const date = args?.date;
        if (!isDate(date)) return { ok: false };
        runExpiry(date);
        if (!isId(memberId) || !isId(bookId)) return { ok: false };
        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return { ok: false };
        if (b.loan === null && b.holds.length === 0) return { ok: false };
        if (b.loan !== null && b.loan.memberId === memberId) return { ok: false };
        if (b.holds.includes(memberId)) return { ok: false };

        b.holds.push(memberId);
        m.holds.push(bookId);
        return { ok: true, position: b.holds.length };
      }, FAIL);
    },

    payFine(args) {
      return safe(() => {
        const memberId = args?.memberId;
        const amount = args?.amount;
        const date = args?.date;
        if (!isDate(date)) return { ok: false };
        runExpiry(date);
        if (!isId(memberId)) return { ok: false };
        if (!Number.isInteger(amount) || amount <= 0) return { ok: false };
        const m = members.get(memberId);
        if (!m) return { ok: false };
        if (amount > m.owed) return { ok: false };

        m.owed -= amount;
        return { ok: true, owed: m.owed };
      }, FAIL);
    },

    getMember(args) {
      return safe(() => {
        const memberId = args?.memberId;
        const date = args?.date;
        if (!isDate(date)) return { ok: false };
        runExpiry(date);
        if (!isId(memberId)) return { ok: false };
        const m = members.get(memberId);
        if (!m) return { ok: false };

        const loans = m.loans.map(id => ({
          bookId: id,
          dueDate: books.get(id).loan.dueDate,
        }));
        const holds = m.holds.map(id => {
          const b = books.get(id);
          const setAside = b.loan === null && b.holds[0] === memberId;
          return {
            bookId: id,
            position: b.holds.indexOf(memberId) + 1,
            readyUntil: setAside ? fromDay(b.readyDay) : null,
          };
        });
        return { loans, owed: m.owed, holds };
      }, FAIL);
    },
  };
}
