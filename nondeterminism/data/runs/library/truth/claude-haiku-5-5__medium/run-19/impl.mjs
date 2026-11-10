const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const MAX_RENEWALS = 2;
const HOLD_DAYS = 3;
const FREE_LATE_DAYS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const DEBT_LIMIT = 1000;

function toMs(date) {
  return Date.parse(date + 'T00:00:00Z');
}

function addDays(date, days) {
  return new Date(toMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

// Whole days from `from` to `to` (positive when `to` is later).
function daysBetween(from, to) {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null,
  //             queue: [memberId, ...],   // holds in line; queue[0] is the set-aside member if reservedFor is set
  //             reservedFor: memberId | null,
  //             readyUntil: date | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Drop set-aside holds whose pickup window ended before `date`,
  // passing the book on to the next member in line.
  function expireReservations(date) {
    for (const book of books.values()) {
      while (book.reservedFor !== null && book.readyUntil < date) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.reservedFor = book.queue[0];
          book.readyUntil = addDays(book.readyUntil, HOLD_DAYS);
        } else {
          book.reservedFor = null;
          book.readyUntil = null;
        }
      }
    }
  }

  function countLoans(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) n++;
    }
    return n;
  }

  function isOnLoanTo(memberId, bookId) {
    const book = books.get(bookId);
    return Boolean(book && book.loan && book.loan.memberId === memberId);
  }

  function addBook({ bookId }) {
    if (books.has(bookId)) return { ok: false };
    books.set(bookId, { loan: null, queue: [], reservedFor: null, readyUntil: null });
    return { ok: true };
  }

  function addMember({ memberId }) {
    if (members.has(memberId)) return { ok: false };
    members.set(memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date }) {
    expireReservations(date);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    if (book.loan) return { ok: false };
    if (countLoans(memberId) >= MAX_LOANS) return { ok: false };
    if (member.owed >= DEBT_LIMIT) return { ok: false };
    if (book.reservedFor !== null && book.reservedFor !== memberId) return { ok: false };

    if (book.reservedFor === memberId) {
      // Their hold ends; the members behind them move up automatically.
      book.queue.shift();
      book.reservedFor = null;
      book.readyUntil = null;
    }

    const dueDate = addDays(date, LOAN_DAYS);
    book.loan = { memberId, dueDate, renewals: 0 };
    return { ok: true, dueDate };
  }

  function returnBook({ memberId, bookId, date }) {
    expireReservations(date);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book || !isOnLoanTo(memberId, bookId)) return { ok: false };

    const lateDays = Math.max(0, daysBetween(book.loan.dueDate, date));
    let fine = 0;
    if (lateDays > FREE_LATE_DAYS) {
      fine = Math.min(lateDays * FINE_PER_DAY, FINE_CAP);
    }
    member.owed += fine;

    book.loan = null;
    if (book.queue.length > 0) {
      book.reservedFor = book.queue[0];
      book.readyUntil = addDays(date, HOLD_DAYS);
    }
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date }) {
    expireReservations(date);
    const book = books.get(bookId);
    if (!members.has(memberId) || !book || !isOnLoanTo(memberId, bookId)) return { ok: false };
    if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (book.queue.length > 0) return { ok: false };
    if (date > book.loan.dueDate) return { ok: false };

    book.loan.dueDate = addDays(book.loan.dueDate, LOAN_DAYS);
    book.loan.renewals += 1;
    return { ok: true, dueDate: book.loan.dueDate };
  }

  function placeHold({ memberId, bookId, date }) {
    expireReservations(date);
    const book = books.get(bookId);
    if (!members.has(memberId) || !book) return { ok: false };
    if (!book.loan && book.reservedFor === null) return { ok: false };
    if (isOnLoanTo(memberId, bookId)) return { ok: false };
    if (book.queue.includes(memberId)) return { ok: false };

    book.queue.push(memberId);
    return { ok: true, position: book.queue.length };
  }

  function payFine({ memberId, amount, date }) {
    expireReservations(date);
    const member = members.get(memberId);
    if (!member) return { ok: false };
    if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) return { ok: false };

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember({ memberId, date }) {
    expireReservations(date);
    const member = members.get(memberId);
    if (!member) return null;

    const loans = [];
    const holds = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) {
        loans.push({ bookId, dueDate: book.loan.dueDate });
      }
      const index = book.queue.indexOf(memberId);
      if (index !== -1) {
        holds.push({
          bookId,
          position: index + 1,
          readyUntil: book.reservedFor === memberId ? book.readyUntil : null,
        });
      }
    }
    return { loans, owed: member.owed, holds };
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
