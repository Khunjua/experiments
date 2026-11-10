const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const DEBT_LIMIT = 1000;
const MAX_RENEWALS = 2;
const HOLD_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_FREE_DAYS = 2;
const FINE_CAP = 500;

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isDate(x) {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x)) return false;
  return !Number.isNaN(Date.parse(x + 'T00:00:00Z'));
}

function toMs(date) {
  return Date.parse(date + 'T00:00:00Z');
}

function addDays(date, n) {
  return new Date(toMs(date) + n * DAY_MS).toISOString().slice(0, 10);
}

// Whole days from b to a (positive when a is after b).
function daysBetween(a, b) {
  return Math.round((toMs(a) - toMs(b)) / DAY_MS);
}

function fineFor(lateDays) {
  if (lateDays <= FINE_FREE_DAYS) return 0;
  return Math.min(FINE_CAP, lateDays * FINE_PER_DAY);
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDate, renewals }, queue: [memberId], readyUntil: string | null }
  // queue[0] is the member the book is set aside for when readyUntil is set.
  const books = new Map();
  // memberId -> { owed: number, loanBooks: Set<bookId> }
  const members = new Map();

  // Lazily applies time-based hold expiry to every book up to the given date.
  function settle(date) {
    for (const book of books.values()) {
      while (
        book.queue.length > 0 &&
        book.readyUntil !== null &&
        daysBetween(date, book.readyUntil) > 0
      ) {
        book.queue.shift();
        book.readyUntil =
          book.queue.length > 0 ? addDays(book.readyUntil, HOLD_DAYS) : null;
      }
    }
  }

  function addBook(args) {
    const bookId = args?.bookId;
    if (!isId(bookId) || books.has(bookId)) return { ok: false };
    books.set(bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    const memberId = args?.memberId;
    if (!isId(memberId) || members.has(memberId)) return { ok: false };
    members.set(memberId, { owed: 0, loanBooks: new Set() });
    return { ok: true };
  }

  function borrow(args) {
    const { memberId, bookId, date } = args ?? {};
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b || !isDate(date)) return { ok: false };
    settle(date);

    if (b.loan) return { ok: false };
    // Set-aside books may only be borrowed by the member at the front of the line.
    if (b.queue.length > 0 && b.queue[0] !== memberId) return { ok: false };
    if (m.owed >= DEBT_LIMIT) return { ok: false };
    if (m.loanBooks.size >= MAX_LOANS) return { ok: false };

    if (b.queue.length > 0) {
      // queue[0] === memberId: their hold ends and everyone behind moves up.
      b.queue.shift();
    }
    b.readyUntil = null;

    const dueDate = addDays(date, LOAN_DAYS);
    b.loan = { memberId, dueDate, renewals: 0 };
    m.loanBooks.add(bookId);
    return { ok: true, dueDate };
  }

  function returnBook(args) {
    const { memberId, bookId, date } = args ?? {};
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b || !isDate(date)) return { ok: false, fine: 0 };
    settle(date);

    if (!b.loan || b.loan.memberId !== memberId) return { ok: false, fine: 0 };

    const lateDays = Math.max(0, daysBetween(date, b.loan.dueDate));
    const fine = fineFor(lateDays);
    m.owed += fine;

    m.loanBooks.delete(bookId);
    b.loan = null;

    if (b.queue.length > 0) {
      b.readyUntil = addDays(date, HOLD_DAYS);
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const { memberId, bookId, date } = args ?? {};
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b || !isDate(date)) return { ok: false };
    settle(date);

    const loan = b.loan;
    if (!loan || loan.memberId !== memberId) return { ok: false };
    // Overdue: date is after the due date.
    if (daysBetween(date, loan.dueDate) > 0) return { ok: false };
    if (loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (b.queue.length > 0) return { ok: false };

    loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: loan.dueDate };
  }

  function placeHold(args) {
    const { memberId, bookId, date } = args ?? {};
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b || !isDate(date)) return { ok: false };
    settle(date);

    if (b.loan && b.loan.memberId === memberId) return { ok: false };
    if (b.queue.includes(memberId)) return { ok: false };
    // A free book (no loan, nobody set aside) cannot be held.
    if (!b.loan && b.queue.length === 0) return { ok: false };

    b.queue.push(memberId);
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    const { memberId, amount, date } = args ?? {};
    const m = members.get(memberId);
    if (!m || !isDate(date)) return { ok: false };
    settle(date);

    if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
      return { ok: false, owed: m.owed };
    }
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const { memberId, date } = args ?? {};
    const m = members.get(memberId);
    if (!m || !isDate(date)) return { loans: [], owed: 0, holds: [] };
    settle(date);

    const loans = [];
    for (const bookId of m.loanBooks) {
      loans.push({ bookId, dueDate: books.get(bookId).loan.dueDate });
    }

    const holds = [];
    for (const [bookId, b] of books) {
      const idx = b.queue.indexOf(memberId);
      if (idx >= 0) {
        holds.push({
          bookId,
          position: idx + 1,
          readyUntil: idx === 0 && b.readyUntil !== null ? b.readyUntil : null,
        });
      }
    }

    return { loans, owed: m.owed, holds };
  }

  return {
    addBook,
    addMember,
    borrow,
    returnBook,
    renew,
    placeHold,
    payFine,
    getMember,
  };
}
