const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 7;
const GRACE_DAYS = 3;
const FINE_PER_DAY_CENTS = 25;
const MAX_LOANS = 5;

function toMs(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(date, n) {
  return fromMs(toMs(date) + n * DAY_MS);
}

function daysBetween(from, to) {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

function validId(id) {
  return id !== undefined && id !== null;
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null, queue: [{ memberId, readyUntil }] }
  // queue[0] has readyUntil set when the book is set aside for that member.
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  function sweep(date) {
    for (const book of books.values()) {
      while (
        book.queue.length > 0 &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < date
      ) {
        const lapsed = book.queue.shift();
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = addDays(lapsed.readyUntil, PICKUP_DAYS);
        }
      }
    }
  }

  function openLoansOf(memberId) {
    const result = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) {
        result.push([bookId, book]);
      }
    }
    return result;
  }

  return {
    addBook({ bookId }) {
      if (!validId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (!validId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!book || !members.has(memberId) || book.loan) return { ok: false };

      const head = book.queue[0];
      const reserved = head !== undefined && head.readyUntil !== null;
      if (reserved && head.memberId !== memberId) return { ok: false };

      if (openLoansOf(memberId).length >= MAX_LOANS) return { ok: false };

      if (reserved) book.queue.shift();
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) return { ok: false };

      const late = Math.max(0, daysBetween(book.loan.dueDate, date));
      const fine = Math.max(0, late - GRACE_DAYS) * FINE_PER_DAY_CENTS;
      if (fine > 0) {
        members.get(memberId).owed += fine;
      }

      book.loan = null;
      if (book.queue.length > 0) {
        book.queue[0].readyUntil = addDays(date, PICKUP_DAYS);
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) return { ok: false };

      const loan = book.loan;
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (book.queue.length > 0) return { ok: false };
      if (date > loan.dueDate) return { ok: false };

      loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!book || !members.has(memberId) || !book.loan) return { ok: false };
      if (book.loan.memberId === memberId) return { ok: false };
      if (book.queue.some((entry) => entry.memberId === memberId)) return { ok: false };

      book.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date }) {
      sweep(date);
      const member = members.get(memberId);
      if (!member) return { ok: false, owed: 0 };
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return { ok: false, owed: member.owed };
      }

      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date }) {
      sweep(date);
      const member = members.get(memberId);
      if (!member) return { ok: false, loans: [], owed: 0, holds: [] };

      const loans = openLoansOf(memberId).map(([bookId, book]) => ({
        bookId,
        dueDate: book.loan.dueDate,
      }));

      const holds = [];
      for (const [bookId, book] of books) {
        book.queue.forEach((entry, index) => {
          if (entry.memberId === memberId) {
            holds.push({
              bookId,
              position: index + 1,
              readyUntil: entry.readyUntil,
            });
          }
        });
      }

      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
