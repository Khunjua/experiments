const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const LOAN_LIMIT = 5;
const BORROW_OWED_LIMIT = 1000;
const LATE_FEE_PER_DAY = 25;
const FREE_LATE_DAYS = 2;
const FINE_CAP = 500;
const RENEWAL_LIMIT = 2;
const HOLD_GRACE_DAYS = 3;

function toDayNumber(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromDayNumber(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function addDays(s, k) {
  return fromDayNumber(toDayNumber(s) + k);
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDate, renewals },
  //             queue: [memberId, ...],            // hold line, index 0 = position 1
  //             setAside: null | { memberId, readyUntil } }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Applies set-aside expirations up to (not including) the given date.
  function expire(date) {
    for (const book of books.values()) {
      while (book.setAside && book.setAside.readyUntil < date) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.setAside = {
            memberId: book.queue[0],
            readyUntil: addDays(book.setAside.readyUntil, HOLD_GRACE_DAYS),
          };
        } else {
          book.setAside = null;
        }
      }
    }
  }

  function loanCount(memberId) {
    let count = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) count++;
    }
    return count;
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], setAside: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      expire(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return { ok: false };
      if (book.loan) return { ok: false };
      if (loanCount(memberId) >= LOAN_LIMIT) return { ok: false };
      if (member.owed >= BORROW_OWED_LIMIT) return { ok: false };

      if (book.setAside) {
        if (book.setAside.memberId !== memberId) return { ok: false };
        // Hold ends; everyone behind moves up one place.
        book.queue.shift();
        book.setAside = null;
      } else if (book.queue.length > 0) {
        // Should not happen: a queued book is always set aside or on loan.
        return { ok: false };
      }

      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      expire(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }

      const daysLate = toDayNumber(date) - toDayNumber(book.loan.dueDate);
      let fine = 0;
      if (daysLate > FREE_LATE_DAYS) {
        fine = Math.min(daysLate * LATE_FEE_PER_DAY, FINE_CAP);
      }
      member.owed += fine;

      book.loan = null;
      if (book.queue.length > 0) {
        book.setAside = {
          memberId: book.queue[0],
          readyUntil: addDays(date, HOLD_GRACE_DAYS),
        };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      expire(date);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) return { ok: false };
      if (book.loan.renewals >= RENEWAL_LIMIT) return { ok: false };
      if (book.queue.length > 0) return { ok: false };
      if (date > book.loan.dueDate) return { ok: false };

      book.loan.dueDate = addDays(book.loan.dueDate, LOAN_DAYS);
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      expire(date);
      if (!members.has(memberId)) return { ok: false };
      const book = books.get(bookId);
      if (!book) return { ok: false };
      if (!book.loan && !book.setAside) return { ok: false };
      if (book.loan && book.loan.memberId === memberId) return { ok: false };
      if (book.queue.includes(memberId)) return { ok: false };

      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date }) {
      expire(date);
      const member = members.get(memberId);
      if (!member) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return { ok: false };
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date }) {
      expire(date);
      const member = members.get(memberId);
      if (!member) return { loans: [], owed: 0, holds: [] };

      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        const index = book.queue.indexOf(memberId);
        if (index >= 0) {
          const setAsideForMe = book.setAside && book.setAside.memberId === memberId;
          holds.push({
            bookId,
            position: index + 1,
            readyUntil: setAsideForMe ? book.setAside.readyUntil : null,
          });
        }
      }
      return { loans, owed: member.owed, holds };
    },
  };
}
