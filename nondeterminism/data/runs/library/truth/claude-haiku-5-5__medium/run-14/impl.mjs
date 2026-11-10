const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const DEBT_LIMIT = 1000;
const FINE_PER_DAY = 25;
const FREE_LATE_DAYS = 2;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;
const HOLD_WINDOW = 3;

function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function fromDay(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function addDays(s, k) {
  return fromDay(toDay(s) + k);
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDate, renewals }, queue: [memberId...], reserve: null | { memberId, readyUntil } }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Expire set-aside books whose readyUntil is before `date`, passing them down the line.
  function settle(date) {
    const today = toDay(date);
    for (const book of books.values()) {
      while (book.reserve && toDay(book.reserve.readyUntil) < today) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.reserve = {
            memberId: book.queue[0],
            readyUntil: addDays(book.reserve.readyUntil, HOLD_WINDOW),
          };
        } else {
          book.reserve = null;
        }
      }
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
      books.set(bookId, { loan: null, queue: [], reserve: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loan) return { ok: false };
      if (activeLoanCount(memberId) >= MAX_LOANS) return { ok: false };
      if (m.owed >= DEBT_LIMIT) return { ok: false };
      if (b.reserve && b.reserve.memberId !== memberId) return { ok: false };

      if (b.reserve && b.reserve.memberId === memberId) {
        // Hold ends; everyone behind moves up.
        b.queue.shift();
        b.reserve = null;
      }

      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      settle(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (!b.loan || b.loan.memberId !== memberId) return { ok: false, fine: 0 };

      const lateDays = toDay(date) - toDay(b.loan.dueDate);
      let fine = 0;
      if (lateDays > FREE_LATE_DAYS) {
        fine = Math.min(lateDays * FINE_PER_DAY, FINE_CAP);
      }

      b.loan = null;
      m.owed += fine;

      if (b.queue.length > 0) {
        b.reserve = { memberId: b.queue[0], readyUntil: addDays(date, HOLD_WINDOW) };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      settle(date);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b) return { ok: false };
      if (!b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (toDay(date) > toDay(b.loan.dueDate)) return { ok: false };

      b.loan.dueDate = addDays(b.loan.dueDate, LOAN_DAYS);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      settle(date);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b) return { ok: false };
      if (!b.loan && !b.reserve) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };

      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      settle(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      settle(date);
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
          const setAside = b.reserve && b.reserve.memberId === memberId;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: setAside ? b.reserve.readyUntil : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
