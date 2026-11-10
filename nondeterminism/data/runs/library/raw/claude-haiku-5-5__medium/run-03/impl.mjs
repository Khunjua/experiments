const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 7;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const DAY_MS = 86400000;

function toMs(date) {
  return Date.parse(date + 'T00:00:00Z');
}

function addDays(date, days) {
  return new Date(toMs(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

function fineFor(dueDate, returnDate) {
  const late = daysBetween(dueDate, returnDate);
  const chargeable = late - GRACE_DAYS;
  if (chargeable <= 0) return 0;
  return Math.min(FINE_CAP, chargeable * FINE_PER_DAY);
}

export function createLibrary() {
  const members = new Map();
  // book: { loan: null | { memberId, dueDate, renewals }, queue: [memberId], readyUntil: null | date }
  const books = new Map();

  // Lazily applies the pickup-window expiry for every shelf-reserved book as of `date`.
  function expire(date) {
    for (const book of books.values()) {
      while (book.loan === null && book.readyUntil !== null && book.readyUntil < date) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = addDays(book.readyUntil, PICKUP_DAYS);
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) {
        return { ok: false };
      }
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) {
        return { ok: false };
      }
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      expire(date);
      if (b.loan !== null) return { ok: false };
      if (b.queue.length > 0) {
        // Book is shelf-reserved: only the member set aside for it may take it.
        if (b.queue[0] !== memberId || b.readyUntil === null) return { ok: false };
        b.queue.shift();
        b.readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || b.loan === null || b.loan.memberId !== memberId) {
        return { ok: false };
      }
      expire(date);
      const fine = fineFor(b.loan.dueDate, date);
      m.owed += fine;
      b.loan = null;
      if (b.queue.length > 0) {
        b.readyUntil = addDays(date, PICKUP_DAYS);
      } else {
        b.readyUntil = null;
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || b.loan === null || b.loan.memberId !== memberId) {
        return { ok: false };
      }
      expire(date);
      if (date > b.loan.dueDate) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      b.loan.renewals += 1;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      expire(date);
      if (b.loan === null) return { ok: false };
      if (b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      expire(date);
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan !== null && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate });
        }
        const index = b.queue.indexOf(memberId);
        if (index !== -1) {
          const setAside = index === 0 && b.loan === null && b.readyUntil !== null;
          holds.push({
            bookId,
            position: index + 1,
            readyUntil: setAside ? b.readyUntil : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
