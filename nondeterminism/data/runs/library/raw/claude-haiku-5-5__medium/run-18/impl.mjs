const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const PICKUP_DAYS = 7;

const MS_PER_DAY = 86400000;
const toDay = (s) => Date.parse(`${s}T00:00:00Z`) / MS_PER_DAY;
const fromDay = (n) => new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
const addDays = (s, n) => fromDay(toDay(s) + n);
const daysBetween = (a, b) => toDay(b) - toDay(a);

export function createLibrary() {
  const books = new Map();   // bookId -> { loanedTo, loan: {dueDate, renewals}|null, queue: [memberId], ready: {memberId, readyUntil}|null }
  const members = new Map(); // memberId -> { owed }

  // Lapse expired pickup reservations and pass them down the line.
  function sweep(date) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const book of books.values()) {
        if (book.ready && book.ready.readyUntil < date) {
          const release = addDays(book.ready.readyUntil, 1);
          book.ready = null;
          if (book.queue.length > 0) {
            const next = book.queue.shift();
            book.ready = { memberId: next, readyUntil: addDays(release, PICKUP_DAYS - 1) };
          }
          changed = true;
        }
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (!bookId || books.has(bookId)) return { ok: false };
      books.set(bookId, { loanedTo: null, loan: null, queue: [], ready: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (!memberId || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member) return { ok: false };
      if (book.loanedTo !== null) return { ok: false };
      if (book.ready && book.ready.memberId !== memberId) return { ok: false };
      if (countLoans(memberId) >= MAX_LOANS) return { ok: false };

      const dueDate = addDays(date, LOAN_DAYS);
      book.loanedTo = memberId;
      book.loan = { dueDate, renewals: 0 };
      book.ready = null;
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member || book.loanedTo !== memberId) return { ok: false };

      const late = Math.max(0, daysBetween(book.loan.dueDate, date));
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      member.owed += fine;

      book.loanedTo = null;
      book.loan = null;
      if (book.queue.length > 0) {
        const next = book.queue.shift();
        book.ready = { memberId: next, readyUntil: addDays(date, PICKUP_DAYS - 1) };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!book || book.loanedTo !== memberId || !book.loan) return { ok: false };
      if (date > book.loan.dueDate) return { ok: false };
      if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (book.queue.length > 0) return { ok: false };

      book.loan.dueDate = addDays(date, LOAN_DAYS);
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sweep(date);
      const book = books.get(bookId);
      if (!book || !members.has(memberId)) return { ok: false };
      if (book.loanedTo === memberId) return { ok: false };
      if (book.loanedTo === null && book.ready === null) return { ok: false };
      if (book.ready && book.ready.memberId === memberId) return { ok: false };
      if (book.queue.includes(memberId)) return { ok: false };

      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date }) {
      sweep(date);
      const member = members.get(memberId);
      if (!member) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) return { ok: false };

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
        if (book.loanedTo === memberId && book.loan) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        if (book.ready && book.ready.memberId === memberId) {
          holds.push({ bookId, position: 0, readyUntil: book.ready.readyUntil });
        }
        const idx = book.queue.indexOf(memberId);
        if (idx !== -1) {
          holds.push({ bookId, position: idx + 1, readyUntil: null });
        }
      }
      return { loans, owed: member.owed, holds };
    },
  };

  function countLoans(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loanedTo === memberId) n++;
    }
    return n;
  }
}
