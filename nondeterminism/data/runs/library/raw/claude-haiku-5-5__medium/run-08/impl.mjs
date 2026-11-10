const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const PICKUP_DAYS = 3;
const DAY_MS = 86400000;

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

function daysBetween(a, b) {
  return toDay(b) - toDay(a);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null, queue: [memberId...], offerUntil: string | null }
  // queue[0] is the member the book is set aside for when offerUntil is set.
  const books = new Map();
  // memberId -> { owed: cents }
  const members = new Map();

  // Lazily release set-aside holds whose pickup window has passed.
  function expire(date) {
    for (const book of books.values()) {
      while (book.queue.length > 0 && book.offerUntil !== null && book.offerUntil < date) {
        book.queue.shift();
        if (book.queue.length > 0) {
          const start = addDays(book.offerUntil, 1);
          book.offerUntil = addDays(start, PICKUP_DAYS - 1);
        } else {
          book.offerUntil = null;
        }
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (bookId === undefined || bookId === null || books.has(bookId)) {
        return { ok: false };
      }
      books.set(bookId, { loan: null, queue: [], offerUntil: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (memberId === undefined || memberId === null || members.has(memberId)) {
        return { ok: false };
      }
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      expire(date);
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member || book.loan) {
        return { ok: false };
      }
      if (book.queue.length > 0) {
        if (book.offerUntil === null || book.queue[0] !== memberId) {
          return { ok: false };
        }
        book.queue.shift();
        book.offerUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      expire(date);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false };
      }
      const late = Math.max(0, daysBetween(book.loan.dueDate, date));
      const fine = Math.min(Math.max(0, late - GRACE_DAYS) * FINE_PER_DAY, FINE_CAP);
      members.get(memberId).owed += fine;
      book.loan = null;
      if (book.queue.length > 0) {
        book.offerUntil = addDays(date, PICKUP_DAYS - 1);
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      expire(date);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false };
      }
      if (book.queue.length > 0) return { ok: false };
      if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (date > book.loan.dueDate) return { ok: false };
      const candidate = addDays(date, LOAN_DAYS);
      if (candidate > book.loan.dueDate) {
        book.loan.dueDate = candidate;
      }
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      expire(date);
      const book = books.get(bookId);
      const member = members.get(memberId);
      if (!book || !member) return { ok: false };
      if (!book.loan || book.loan.memberId === memberId) return { ok: false };
      if (book.queue.includes(memberId)) return { ok: false };
      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date }) {
      expire(date);
      const member = members.get(memberId);
      if (!member || !Number.isInteger(amount) || amount <= 0 || amount > member.owed) {
        return { ok: false };
      }
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date }) {
      expire(date);
      const member = members.get(memberId);
      if (!member) {
        return { loans: [], owed: 0, holds: [] };
      }
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: book.loan.dueDate });
        }
        const idx = book.queue.indexOf(memberId);
        if (idx !== -1) {
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: idx === 0 && book.offerUntil !== null ? book.offerUntil : null,
          });
        }
      }
      return { loans, owed: member.owed, holds };
    },
  };
}
