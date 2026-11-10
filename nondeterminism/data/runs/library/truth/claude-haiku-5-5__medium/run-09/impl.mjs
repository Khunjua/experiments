const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BORROW_BLOCK_CENTS = 1000;
const FINE_PER_DAY = 25;
const FINE_FREE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_GRACE_DAYS = 3;

function toMs(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(date, n) {
  return new Date(toMs(date) + n * DAY_MS).toISOString().slice(0, 10);
}

// Number of days from `from` to `to` (positive when `to` is later).
function daysBetween(from, to) {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null,
  //             queue: [memberId, ...],           // hold line, index 0 = position 1
  //             reserved: { memberId, readyUntil } | null }
  // Invariant: reserved.memberId === queue[0] whenever reserved is set.
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Applies lapsed set-asides up to `date`. Called at the start of every method.
  function sweep(date) {
    for (const book of books.values()) {
      while (book.reserved && daysBetween(book.reserved.readyUntil, date) > 0) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.reserved = {
            memberId: book.queue[0],
            readyUntil: addDays(book.reserved.readyUntil, HOLD_GRACE_DAYS),
          };
        } else {
          book.reserved = null;
        }
      }
    }
  }

  function countLoans(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], reserved: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.reserved && b.reserved.memberId !== memberId) return { ok: false };
      if (m.owed >= BORROW_BLOCK_CENTS) return { ok: false };
      if (countLoans(memberId) >= MAX_LOANS) return { ok: false };

      if (b.reserved) {
        // Borrowing the set-aside book ends this member's hold.
        const idx = b.queue.indexOf(memberId);
        if (idx >= 0) b.queue.splice(idx, 1);
        b.reserved = null;
      }

      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }

      const late = Math.max(0, daysBetween(b.loan.dueDate, date));
      let fine = 0;
      if (late > FINE_FREE_DAYS) {
        fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      }
      m.owed += fine;

      b.loan = null;
      if (b.queue.length > 0) {
        b.reserved = {
          memberId: b.queue[0],
          readyUntil: addDays(date, HOLD_GRACE_DAYS),
        };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sweep(date);
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (daysBetween(b.loan.dueDate, date) > 0) return { ok: false };

      b.loan.dueDate = addDays(b.loan.dueDate, LOAN_DAYS);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (!b.loan && !b.reserved) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };

      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      sweep(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      sweep(date);
      const m = members.get(memberId);
      const loans = [];
      const holds = [];

      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate });
        }
        const idx = b.queue.indexOf(memberId);
        if (idx >= 0) {
          const setAside = b.reserved && b.reserved.memberId === memberId;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: setAside ? b.reserved.readyUntil : null,
          });
        }
      }

      return { loans, owed: m ? m.owed : 0, holds };
    },
  };
}
