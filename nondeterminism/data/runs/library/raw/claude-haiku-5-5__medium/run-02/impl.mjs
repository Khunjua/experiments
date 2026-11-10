const LOAN_DAYS = 21;
const RENEWAL_LIMIT = 2;
const LOAN_LIMIT = 5;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const BLOCK_OWED = 1000;
const PICKUP_DAYS = 3;
const DAY_MS = 86400000;

function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDate, renewals },
  //             queue: [memberId, ...],   // waiting line; queue[0] is the set-aside holder when readyUntil is set
  //             readyUntil: null | 'YYYY-MM-DD' }
  const books = new Map();
  // memberId -> { owed: cents }
  const members = new Map();

  // Lapse expired pickup windows, passing the book to the next in line.
  function sync(date) {
    for (const b of books.values()) {
      while (b.readyUntil !== null && b.readyUntil < date) {
        const lapsed = b.readyUntil;
        b.queue.shift();
        b.readyUntil = b.queue.length === 0 ? null : addDays(lapsed, PICKUP_DAYS);
      }
    }
  }

  // If a book is free and someone is waiting, set it aside for the first in line.
  function setAsideIfWaiting(b, date) {
    if (!b.loan && b.queue.length > 0 && b.readyUntil === null) {
      b.readyUntil = addDays(date, PICKUP_DAYS);
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
      if (b.loan) return { ok: false };
      if (b.readyUntil !== null && b.queue[0] !== memberId) return { ok: false };
      if (m.owed >= BLOCK_OWED) return { ok: false };
      if (activeLoanCount(memberId) >= LOAN_LIMIT) return { ok: false };

      if (b.readyUntil !== null) {
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
      if (!b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      const m = members.get(memberId);

      const late = daysBetween(b.loan.dueDate, date);
      const chargeable = Math.max(0, late - GRACE_DAYS);
      const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);

      m.owed += fine;
      b.loan = null;
      setAsideIfWaiting(b, date);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sync(date);
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= RENEWAL_LIMIT) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (date > b.loan.dueDate) return { ok: false };

      b.loan.renewals += 1;
      b.loan.dueDate = addDays(b.loan.dueDate, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.owed >= BLOCK_OWED) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      if (!b.loan && b.queue.length === 0) return { ok: false };

      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      sync(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      sync(date);
      const m = members.get(memberId);
      if (!m) return { ok: false, loans: [], owed: 0, holds: [] };

      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate });
        }
        const idx = b.queue.indexOf(memberId);
        if (idx !== -1) {
          const setAside = b.readyUntil !== null && idx === 0;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: setAside ? b.readyUntil : null,
          });
        }
      }
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
