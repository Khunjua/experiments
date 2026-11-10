const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;

function toMs(s) {
  return Date.parse(s + 'T00:00:00Z');
}

function addDays(s, n) {
  return new Date(toMs(s) + n * DAY_MS).toISOString().slice(0, 10);
}

// whole days from a to b (b - a)
function daysBetween(a, b) {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

function computeFine(dueDate, returnDate) {
  const late = daysBetween(dueDate, returnDate);
  const chargeable = late - GRACE_DAYS;
  if (chargeable <= 0) return 0;
  return Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
}

export function createLibrary() {
  // bookId -> { loan: {memberId, dueDate, renewals} | null, queue: [{memberId, readyUntil}] }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  function setAside(hold, start) {
    hold.readyUntil = addDays(start, PICKUP_DAYS);
  }

  // Release lapsed set-asides on this date. Only the first hold in a
  // queue can be set aside, and only while the book is not on loan.
  function sweep(date) {
    for (const book of books.values()) {
      while (
        !book.loan &&
        book.queue.length > 0 &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < date
      ) {
        const lapsed = book.queue.shift();
        if (book.queue.length > 0) {
          setAside(book.queue[0], addDays(lapsed.readyUntil, 1));
        }
      }
    }
  }

  // Book becomes free on date; set aside for the next hold if any.
  function release(book, date) {
    book.loan = null;
    if (book.queue.length > 0) {
      setAside(book.queue[0], date);
    }
  }

  function validId(id) {
    return id !== undefined && id !== null;
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loan) return { ok: false };

      if (b.queue.length > 0) {
        // Book is free but set aside: only the set-aside member may take it.
        if (b.queue[0].memberId !== memberId) return { ok: false };
        b.queue.shift();
      }

      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false };
      }
      const fine = computeFine(b.loan.dueDate, date);
      m.owed += fine;
      release(b, date);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      sweep(date);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !b.loan) return { ok: false };
      if (b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (date > b.loan.dueDate) return { ok: false }; // overdue
      if (b.queue.length > 0) return { ok: false };    // someone is waiting

      b.loan.dueDate = addDays(date, LOAN_DAYS);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      sweep(date);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.some((h) => h.memberId === memberId)) return { ok: false };
      // An available book with nobody waiting should be borrowed, not held.
      if (!b.loan && b.queue.length === 0) return { ok: false };

      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      sweep(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      sweep(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };

      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate });
        }
        b.queue.forEach((h, i) => {
          if (h.memberId === memberId) {
            holds.push({
              bookId,
              position: i + 1,
              readyUntil: h.readyUntil ?? null,
            });
          }
        });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
