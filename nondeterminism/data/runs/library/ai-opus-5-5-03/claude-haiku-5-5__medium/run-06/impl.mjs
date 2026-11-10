const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 500;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

// Returns the day number (days since 1970-01-01, UTC) or null if invalid.
function parseDay(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDay(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const MAX_DAY = parseDay('9999-12-31');

// Dates are clamped to 9999-12-31 so every returned date stays a valid string.
function addDays(n, k) {
  return Math.min(n + k, MAX_DAY);
}

function isObj(v) {
  return typeof v === 'object' && v !== null;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isAmount(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function removeValue(arr, v) {
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
}

function fail() {
  return { ok: false };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: null | {memberId, dueDate, renewals}, queue: [] }
  const members = new Map(); // memberId -> { owed, loans: [bookId], holds: [bookId] }
  let clock = null;

  function processHolds(D) {
    for (const [bookId, book] of books) {
      while (
        book.queue.length > 0 &&
        book.queue[0].ready &&
        book.queue[0].readyUntil < D
      ) {
        const expired = book.queue.shift();
        const member = members.get(expired.memberId);
        if (member) removeValue(member.holds, bookId);
        const e = addDays(expired.readyUntil, 1);
        if (book.queue.length > 0) {
          const head = book.queue[0];
          head.ready = true;
          head.readyUntil = addDays(e, PICKUP_DAYS);
        }
      }
    }
  }

  // Validates the date, enforces time order, sets the clock and runs hold processing.
  function tick(date) {
    const day = parseDay(date);
    if (day === null) return null;
    if (clock !== null && day < clock) return null;
    clock = day;
    processHolds(day);
    return day;
  }

  return {
    addBook(arg) {
      try {
        if (!isObj(arg) || !isId(arg.bookId) || books.has(arg.bookId)) return fail();
        books.set(arg.bookId, { loan: null, queue: [] });
        return { ok: true };
      } catch {
        return fail();
      }
    },

    addMember(arg) {
      try {
        if (!isObj(arg) || !isId(arg.memberId) || members.has(arg.memberId)) return fail();
        members.set(arg.memberId, { owed: 0, loans: [], holds: [] });
        return { ok: true };
      } catch {
        return fail();
      }
    },

    borrow(arg) {
      try {
        if (!isObj(arg)) return fail();
        const day = tick(arg.date);
        if (day === null) return fail();
        const { memberId, bookId } = arg;
        if (!isId(memberId) || !isId(bookId)) return fail();
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail();
        if (book.loan) return fail();
        const head = book.queue[0];
        if (head && head.ready && head.memberId !== memberId) return fail();
        if (member.loans.length >= MAX_LOANS) return fail();
        if (member.owed >= BORROW_BLOCK_OWED) return fail();

        if (head && head.ready) {
          // Head is a ready hold for this member; consume it.
          book.queue.shift();
          removeValue(member.holds, bookId);
        }
        book.loan = { memberId, dueDate: addDays(day, LOAN_DAYS), renewals: 0 };
        member.loans.push(bookId);
        return { ok: true, dueDate: formatDay(book.loan.dueDate) };
      } catch {
        return fail();
      }
    },

    returnBook(arg) {
      try {
        if (!isObj(arg)) return fail();
        const day = tick(arg.date);
        if (day === null) return fail();
        const { memberId, bookId } = arg;
        if (!isId(memberId) || !isId(bookId)) return fail();
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail();
        if (!book.loan || book.loan.memberId !== memberId) return fail();

        const loan = book.loan;
        const daysLate = day - loan.dueDate;
        const fine = daysLate <= GRACE_DAYS
          ? 0
          : Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);

        member.owed += fine;
        removeValue(member.loans, bookId);
        book.loan = null;

        if (book.queue.length > 0) {
          const head = book.queue[0];
          head.ready = true;
          head.readyUntil = addDays(day, PICKUP_DAYS);
        }
        return { ok: true, fine };
      } catch {
        return fail();
      }
    },

    renew(arg) {
      try {
        if (!isObj(arg)) return fail();
        const day = tick(arg.date);
        if (day === null) return fail();
        const { memberId, bookId } = arg;
        if (!isId(memberId) || !isId(bookId)) return fail();
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail();
        if (!book.loan || book.loan.memberId !== memberId) return fail();

        const loan = book.loan;
        if (day > loan.dueDate) return fail();
        if (loan.renewals >= MAX_RENEWALS) return fail();
        if (book.queue.length > 0) return fail();

        loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
        loan.renewals += 1;
        return { ok: true, dueDate: formatDay(loan.dueDate) };
      } catch {
        return fail();
      }
    },

    placeHold(arg) {
      try {
        if (!isObj(arg)) return fail();
        const day = tick(arg.date);
        if (day === null) return fail();
        const { memberId, bookId } = arg;
        if (!isId(memberId) || !isId(bookId)) return fail();
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return fail();

        // Available: no loan and empty queue.
        if (!book.loan && book.queue.length === 0) return fail();
        if (book.loan && book.loan.memberId === memberId) return fail();
        if (book.queue.some((h) => h.memberId === memberId)) return fail();

        book.queue.push({ memberId, ready: false, readyUntil: null });
        member.holds.push(bookId);
        return { ok: true, position: book.queue.length };
      } catch {
        return fail();
      }
    },

    payFine(arg) {
      try {
        if (!isObj(arg)) return fail();
        const day = tick(arg.date);
        if (day === null) return fail();
        const { memberId, amount } = arg;
        if (!isId(memberId) || !isAmount(amount)) return fail();
        const member = members.get(memberId);
        if (!member) return fail();
        if (amount > member.owed) return fail();

        member.owed -= amount;
        return { ok: true, owed: member.owed };
      } catch {
        return fail();
      }
    },

    getMember(arg) {
      try {
        if (!isObj(arg)) return fail();
        const day = tick(arg.date);
        if (day === null) return fail();
        const { memberId } = arg;
        if (!isId(memberId)) return fail();
        const member = members.get(memberId);
        if (!member) return fail();

        const loans = member.loans.map((bookId) => {
          const book = books.get(bookId);
          return { bookId, dueDate: formatDay(book.loan.dueDate) };
        });

        const holds = member.holds.map((bookId) => {
          const queue = books.get(bookId).queue;
          const idx = queue.findIndex((h) => h.memberId === memberId);
          const h = queue[idx];
          return {
            bookId,
            position: idx + 1,
            readyUntil: h.ready ? formatDay(h.readyUntil) : null,
          };
        });

        return { ok: true, loans, owed: member.owed, holds };
      } catch {
        return fail();
      }
    },
  };
}
