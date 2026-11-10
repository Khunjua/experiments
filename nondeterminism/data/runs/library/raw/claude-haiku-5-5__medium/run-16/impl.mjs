const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

function fromDay(n) {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDay(toDay(s) + n);
}

// number of days from b to a (a - b)
function daysBetween(a, b) {
  return toDay(a) - toDay(b);
}

function isId(v) {
  return v !== undefined && v !== null;
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null, queue: [{ memberId, readyUntil }] }
  // queue[0] is set aside (readyUntil is a date string) only when loan is null.
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Expire pickup windows that ended before `date`, passing the book along the line.
  function sweep(date) {
    for (const book of books.values()) {
      if (book.loan) continue;
      while (
        book.queue.length &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < date
      ) {
        const expired = book.queue.shift();
        if (book.queue.length) {
          // next window starts the day after the expired window ended
          book.queue[0].readyUntil = addDays(expired.readyUntil, PICKUP_DAYS);
        }
      }
    }
  }

  // Set aside a free book for the first member in line, starting on `date`.
  function setAside(book, date) {
    if (book.queue.length) {
      book.queue[0].readyUntil = addDays(date, PICKUP_DAYS - 1);
    }
  }

  function loanOf(bookId, memberId) {
    const book = books.get(bookId);
    if (!book || !book.loan || book.loan.memberId !== memberId) return null;
    return book;
  }

  return {
    addBook({ bookId } = {}) {
      if (!isId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!isId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!members.has(memberId) || !book) return { ok: false };
      if (book.loan) return { ok: false };
      if (book.queue.length) {
        const head = book.queue[0];
        if (head.readyUntil === null || head.memberId !== memberId) {
          return { ok: false };
        }
        // picking up the set-aside book removes the hold
        book.queue.shift();
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!members.has(memberId) || !book || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false };
      }
      const late = daysBetween(date, book.loan.dueDate);
      const chargeable = Math.max(0, late - GRACE_DAYS);
      const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
      book.loan = null;
      if (fine > 0) members.get(memberId).owed += fine;
      setAside(book, date);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!members.has(memberId) || !book || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false };
      }
      const loan = book.loan;
      if (daysBetween(date, loan.dueDate) > 0) return { ok: false }; // overdue
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (book.queue.length) return { ok: false }; // someone is waiting
      loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!members.has(memberId) || !book) return { ok: false };
      // only books that are out (on loan or set aside) can be held
      if (!book.loan && book.queue.length === 0) return { ok: false };
      if (book.loan && book.loan.memberId === memberId) return { ok: false };
      if (book.queue.some((e) => e.memberId === memberId)) return { ok: false };
      book.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date }) {
      sweep(date);
      const member = members.get(memberId);
      if (!member) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return { ok: false };
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date }) {
      sweep(date);
      const member = members.get(memberId);
      if (!member) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        book.queue.forEach((entry, i) => {
          if (entry.memberId === memberId) {
            holds.push({
              bookId,
              position: i + 1,
              readyUntil: entry.readyUntil,
            });
          }
        });
      }
      return { loans, owed: member.owed, holds };
    },
  };
}
