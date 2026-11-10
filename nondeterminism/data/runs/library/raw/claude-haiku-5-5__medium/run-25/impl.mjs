const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 3;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const DAY_MS = 86400000;

function toDayNumber(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDayNumber(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  return fromDayNumber(toDayNumber(dateStr) + n);
}

function computeFine(dueDate, returnDate) {
  const lateDays = toDayNumber(returnDate) - toDayNumber(dueDate);
  if (lateDays <= GRACE_DAYS) return 0;
  return Math.min(FINE_CAP, (lateDays - GRACE_DAYS) * FINE_PER_DAY);
}

export function createLibrary() {
  // book: { loan: null | { memberId, dueDate, renewals }, queue: [memberId], readyUntil: null | date }
  // queue[0] is the member the book is set aside for when it is on the shelf.
  const books = new Map();
  // member: { owed: cents }
  const members = new Map();

  function settleBook(book, date) {
    if (book.loan === null && book.readyUntil !== null && date > book.readyUntil) {
      book.queue.shift();
      book.readyUntil = book.queue.length > 0 ? addDays(date, PICKUP_DAYS) : null;
    }
  }

  function settleAll(date) {
    for (const book of books.values()) {
      settleBook(book, date);
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      settleAll(date);
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member || book.loan !== null) return { ok: false };

      if (book.queue.length > 0) {
        if (book.queue[0] !== memberId) return { ok: false };
        book.queue.shift();
        book.readyUntil = null;
      }

      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      settleAll(date);
      const book = books.get(bookId);
      if (!book || book.loan === null || book.loan.memberId !== memberId) {
        return { ok: false };
      }

      const fine = computeFine(book.loan.dueDate, date);
      book.loan = null;

      if (fine > 0) {
        members.get(memberId).owed += fine;
      }

      if (book.queue.length > 0) {
        book.readyUntil = addDays(date, PICKUP_DAYS);
      }

      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      settleAll(date);
      const book = books.get(bookId);
      if (!book || book.loan === null || book.loan.memberId !== memberId) {
        return { ok: false };
      }

      const loan = book.loan;
      if (
        loan.renewals >= MAX_RENEWALS ||
        book.queue.length > 0 ||
        date > loan.dueDate
      ) {
        return { ok: false };
      }

      loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      settleAll(date);
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member) return { ok: false };

      // Only books that are out (on loan or already set aside) can be held.
      if (book.loan === null && book.queue.length === 0) return { ok: false };
      if (book.loan !== null && book.loan.memberId === memberId) return { ok: false };
      if (book.queue.includes(memberId)) return { ok: false };

      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date }) {
      settleAll(date);
      const member = members.get(memberId);
      if (!member) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return { ok: false };
      }

      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date }) {
      settleAll(date);
      const member = members.get(memberId);
      if (!member) return { loans: [], owed: 0, holds: [] };

      const loans = [];
      const holds = [];

      for (const [bookId, book] of books) {
        if (book.loan !== null && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }

        const idx = book.queue.indexOf(memberId);
        if (idx >= 0) {
          const setAside = idx === 0 && book.loan === null;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: setAside ? book.readyUntil : null,
          });
        }
      }

      return { loans, owed: member.owed, holds };
    },
  };
}
