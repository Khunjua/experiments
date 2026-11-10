const LOAN_DAYS = 21;
const RENEW_DAYS = 21;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 3;
const GRACE_DAYS = 7;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;

function addDays(date, n) {
  const t = Date.parse(date + 'T00:00:00Z') + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000);
}

function computeFine(dueDate, returnDate) {
  const late = daysBetween(dueDate, returnDate);
  if (late <= GRACE_DAYS) return 0;
  return Math.min((late - GRACE_DAYS) * FINE_PER_DAY, FINE_CAP);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, queue, readyUntil }
  const members = new Map(); // memberId -> { owed }

  // Expire set-aside holds whose pickup window has passed; pass them on.
  function sync(date) {
    for (const book of books.values()) {
      while (book.loan === null && book.readyUntil !== null && book.readyUntil < date) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = addDays(book.readyUntil, 1 + PICKUP_DAYS);
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  function addBook({ bookId }) {
    if (books.has(bookId)) return { ok: false };
    books.set(bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember({ memberId }) {
    if (members.has(memberId)) return { ok: false };
    members.set(memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow({ memberId, bookId, date }) {
    sync(date);
    const book = books.get(bookId);
    if (!book || !members.has(memberId)) return { ok: false };
    if (book.loan !== null) return { ok: false };
    if (book.readyUntil !== null && book.queue[0] !== memberId) return { ok: false };

    const dueDate = addDays(date, LOAN_DAYS);
    book.loan = { memberId, dueDate, renewals: 0 };
    if (book.readyUntil !== null) {
      book.queue.shift();
      book.readyUntil = null;
    }
    return { ok: true, dueDate };
  }

  function returnBook({ memberId, bookId, date }) {
    sync(date);
    const book = books.get(bookId);
    if (!book || book.loan === null || book.loan.memberId !== memberId) return { ok: false };

    const fine = computeFine(book.loan.dueDate, date);
    book.loan = null;
    if (fine > 0) members.get(memberId).owed += fine;

    if (book.queue.length > 0) {
      book.readyUntil = addDays(date, PICKUP_DAYS);
    }
    return { ok: true, fine };
  }

  function renew({ memberId, bookId, date }) {
    sync(date);
    const book = books.get(bookId);
    if (!book || book.loan === null || book.loan.memberId !== memberId) return { ok: false };
    if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (book.queue.length > 0) return { ok: false };
    if (date > book.loan.dueDate) return { ok: false };

    book.loan.dueDate = addDays(date, RENEW_DAYS);
    book.loan.renewals += 1;
    return { ok: true, dueDate: book.loan.dueDate };
  }

  function placeHold({ memberId, bookId, date }) {
    sync(date);
    const book = books.get(bookId);
    if (!book || !members.has(memberId)) return { ok: false };
    if (book.loan === null) return { ok: false };
    if (book.loan.memberId === memberId) return { ok: false };
    if (book.queue.includes(memberId)) return { ok: false };

    book.queue.push(memberId);
    return { ok: true, position: book.queue.length };
  }

  function payFine({ memberId, amount, date }) {
    sync(date);
    const member = members.get(memberId);
    if (!member) return { ok: false };
    if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) return { ok: false };

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember({ memberId, date }) {
    sync(date);
    const member = members.get(memberId);
    if (!member) return { loans: [], owed: 0, holds: [] };

    const loans = [];
    const holds = [];
    for (const [bookId, book] of books) {
      if (book.loan !== null && book.loan.memberId === memberId) {
        loans.push({ bookId, dueDate: book.loan.dueDate });
      }
      const index = book.queue.indexOf(memberId);
      if (index !== -1) {
        const setAside = index === 0 && book.readyUntil !== null;
        holds.push({
          bookId,
          position: index + 1,
          readyUntil: setAside ? book.readyUntil : null,
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
