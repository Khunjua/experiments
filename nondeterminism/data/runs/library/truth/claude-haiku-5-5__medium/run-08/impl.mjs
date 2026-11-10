const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
const LATE_FREE_DAYS = 2;
const LATE_FEE = 25;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_WINDOW = 3;

function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDay(toDay(s) + n);
}

function isId(v) {
  return v !== undefined && v !== null;
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null,
  //             queue: [memberId, ...]  (position 1 = index 0),
  //             reservedFor: { memberId, readyUntil } | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Apply hold expiries up to the given date (lazy, in time order).
  function settle(date) {
    const today = toDay(date);
    for (const book of books.values()) {
      while (book.reservedFor && today > toDay(book.reservedFor.readyUntil)) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.reservedFor = {
            memberId: book.queue[0],
            readyUntil: addDays(book.reservedFor.readyUntil, HOLD_WINDOW),
          };
        } else {
          book.reservedFor = null;
        }
      }
    }
  }

  function activeLoansOf(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) {
        out.push({ bookId, loan: book.loan });
      }
    }
    return out;
  }

  return {
    addBook({ bookId } = {}) {
      if (!isId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], reservedFor: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!isId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      settle(date);
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member) return { ok: false };
      if (book.loan) return { ok: false };
      if (book.reservedFor && book.reservedFor.memberId !== memberId) return { ok: false };
      if (member.owed >= BORROW_BLOCK_OWED) return { ok: false };
      if (activeLoansOf(memberId).length >= MAX_LOANS) return { ok: false };

      book.loan = { memberId, dueDate: addDays(date, LOAN_DAYS), renewals: 0 };
      if (book.reservedFor) {
        // The reserved member is queue[0]; their hold ends here.
        book.queue.shift();
        book.reservedFor = null;
      }
      return { ok: true, dueDate: book.loan.dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      settle(date);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }
      const member = members.get(memberId);
      const lateDays = toDay(date) - toDay(book.loan.dueDate);
      let fine = 0;
      if (lateDays > LATE_FREE_DAYS) {
        fine = Math.min(lateDays * LATE_FEE, FINE_CAP);
      }
      book.loan = null;
      member.owed += fine;
      if (book.queue.length > 0) {
        book.reservedFor = {
          memberId: book.queue[0],
          readyUntil: addDays(date, HOLD_WINDOW),
        };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      settle(date);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) return { ok: false };
      const loan = book.loan;
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (book.queue.length > 0) return { ok: false };
      if (toDay(date) > toDay(loan.dueDate)) return { ok: false };
      loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      settle(date);
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member) return { ok: false };
      if (!book.loan && !book.reservedFor) return { ok: false };
      if (book.loan && book.loan.memberId === memberId) return { ok: false };
      if (book.queue.includes(memberId)) return { ok: false };
      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      settle(date);
      const member = members.get(memberId);
      if (!member) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return { ok: false };
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      settle(date);
      const member = members.get(memberId);
      if (!member) return { loans: [], owed: 0, holds: [] };

      const loans = activeLoansOf(memberId).map(({ bookId, loan }) => ({
        bookId,
        dueDate: loan.dueDate,
      }));

      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.queue.indexOf(memberId);
        if (idx >= 0) {
          const readyUntil =
            book.reservedFor && book.reservedFor.memberId === memberId
              ? book.reservedFor.readyUntil
              : null;
          holds.push({ bookId, position: idx + 1, readyUntil });
        }
      }

      return { loans, owed: member.owed, holds };
    },
  };
}
