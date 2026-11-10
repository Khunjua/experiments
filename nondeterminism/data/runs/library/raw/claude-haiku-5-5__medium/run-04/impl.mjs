const LOAN_DAYS = 21;
const RENEWAL_LIMIT = 2;
const MAX_LOANS = 5;
const PICKUP_DAYS = 3;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const BORROW_BLOCK_OWED = 1000;
const DAY_MS = 86400000;

function toMs(d) {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
}

function addDays(d, n) {
  return new Date(toMs(d) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null, queue: [memberId], readyUntil: string | null }
  // When readyUntil is set, the book is free and queue[0] is the member it is set aside for.
  const books = new Map();
  // memberId -> { owed: cents }
  const members = new Map();

  function sync(date) {
    for (const book of books.values()) {
      if (book.readyUntil !== null && book.readyUntil < date) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = addDays(date, PICKUP_DAYS);
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  function setAsideIfFree(book, date) {
    if (book.loan === null && book.queue.length > 0 && book.readyUntil === null) {
      book.readyUntil = addDays(date, PICKUP_DAYS);
    }
  }

  function activeLoanCount(memberId) {
    let n = 0;
    for (const b of books.values()) {
      if (b.loan && b.loan.memberId === memberId) n++;
    }
    return n;
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
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.owed >= BORROW_BLOCK_OWED) return { ok: false };
      if (activeLoanCount(memberId) >= MAX_LOANS) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.queue.length > 0) {
        if (b.readyUntil === null || b.queue[0] !== memberId) return { ok: false };
        b.queue.shift();
        b.readyUntil = null;
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sync(date);
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) return { ok: false, fine: 0 };
      const late = daysBetween(b.loan.dueDate, date);
      const fine = late > GRACE_DAYS
        ? Math.min(FINE_PER_DAY * (late - GRACE_DAYS), FINE_CAP)
        : 0;
      b.loan = null;
      if (fine > 0) members.get(memberId).owed += fine;
      setAsideIfFree(b, date);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sync(date);
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (b.loan.renewals >= RENEWAL_LIMIT) return { ok: false };
      if (date > b.loan.dueDate) return { ok: false };
      b.loan.renewals++;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (!b.loan && b.queue.length === 0) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      sync(date);
      const m = members.get(memberId);
      if (!m || !Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      sync(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate });
        }
        const idx = b.queue.indexOf(memberId);
        if (idx !== -1) {
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: idx === 0 && b.readyUntil !== null ? b.readyUntil : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
