const DAY_MS = 24 * 60 * 60 * 1000;
const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BORROW_BLOCK_CENTS = 1000;
const FREE_LATE_DAYS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const READY_DAYS = 3;

function addDays(date, n) {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
}

// Number of calendar days from `from` to `to` (positive if `to` is later).
function daysBetween(from, to) {
  return Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDate, renewals } | null,
  //             queue: [memberId, ...],            // holds in line order
  //             reserve: { memberId, readyUntil } | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Drops expired set-asides up to `date`, passing the book to the next in line.
  function expire(date) {
    for (const book of books.values()) {
      while (book.reserve && daysBetween(book.reserve.readyUntil, date) > 0) {
        const oldUntil = book.reserve.readyUntil;
        const idx = book.queue.indexOf(book.reserve.memberId);
        if (idx !== -1) book.queue.splice(idx, 1);
        if (book.queue.length === 0) {
          book.reserve = null;
          break;
        }
        book.reserve = {
          memberId: book.queue[0],
          readyUntil: addDays(oldUntil, READY_DAYS),
        };
      }
    }
  }

  function loanCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook({ bookId }) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], reserve: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.reserve && b.reserve.memberId !== memberId) return { ok: false };
      if (loanCount(memberId) >= MAX_LOANS) return { ok: false };
      if (m.owed >= BORROW_BLOCK_CENTS) return { ok: false };

      if (b.reserve) {
        // Borrowing the set-aside book ends this member's hold.
        const idx = b.queue.indexOf(memberId);
        if (idx !== -1) b.queue.splice(idx, 1);
        b.reserve = null;
      }

      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false, fine: 0 };

      const late = daysBetween(b.loan.dueDate, date);
      let fine = 0;
      if (late > FREE_LATE_DAYS) {
        fine = Math.min(late * FINE_PER_DAY, FINE_CAP);
      }
      m.owed += fine;
      b.loan = null;

      if (b.queue.length > 0) {
        b.reserve = { memberId: b.queue[0], readyUntil: addDays(date, READY_DAYS) };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      expire(date);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false };
      }
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (daysBetween(b.loan.dueDate, date) > 0) return { ok: false };

      b.loan.dueDate = addDays(b.loan.dueDate, LOAN_DAYS);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      expire(date);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b) return { ok: false };
      if (!b.loan && !b.reserve) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };

      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      expire(date);
      const m = members.get(memberId);
      if (!m || !Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      expire(date);
      const m = members.get(memberId);
      const loans = [];
      const holds = [];

      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate });
        }
        const idx = b.queue.indexOf(memberId);
        if (idx !== -1) {
          const isSetAside = b.reserve !== null && b.reserve.memberId === memberId;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: isSetAside ? b.reserve.readyUntil : null,
          });
        }
      }

      return { loans, owed: m ? m.owed : 0, holds };
    },
  };
}
