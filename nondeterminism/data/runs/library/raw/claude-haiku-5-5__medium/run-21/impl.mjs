const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 7;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE = 1000;

function toMs(d) {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
}

function addDays(d, n) {
  return new Date(toMs(d) + n * 86400000).toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((toMs(b) - toMs(a)) / 86400000);
}

function isValidDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(toMs(d));
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, dueDate, renewals} | null, queue: [{memberId, readyUntil}] }
  const members = new Map(); // memberId -> { owed }

  // Lapse expired pickup windows for a book, passing the set-aside to the next in line.
  function settle(book, date) {
    while (
      !book.loan &&
      book.queue.length > 0 &&
      book.queue[0].readyUntil !== null &&
      book.queue[0].readyUntil < date
    ) {
      const lapsed = book.queue.shift();
      if (book.queue.length > 0) {
        book.queue[0].readyUntil = addDays(lapsed.readyUntil, PICKUP_DAYS);
      }
    }
  }

  function settleAll(date) {
    for (const b of books.values()) settle(b, date);
  }

  return {
    addBook({ bookId }) {
      if (bookId == null || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (memberId == null || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !isValidDate(date)) return { ok: false };
      settle(b, date);
      if (b.loan) return { ok: false };
      if (b.queue.length > 0) {
        if (b.queue[0].memberId !== memberId || b.queue[0].readyUntil === null) return { ok: false };
        b.queue.shift();
      }
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !isValidDate(date)) return { ok: false };
      settle(b, date);
      if (!b.loan || b.loan.memberId !== memberId) return { ok: false };

      const lateDays = Math.max(0, daysBetween(b.loan.dueDate, date));
      const chargeable = Math.max(0, lateDays - GRACE_DAYS);
      const fine = Math.min(MAX_FINE, chargeable * FINE_PER_DAY);

      m.owed += fine;
      b.loan = null;
      if (b.queue.length > 0) {
        b.queue[0].readyUntil = addDays(date, PICKUP_DAYS);
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !isValidDate(date)) return { ok: false };
      settle(b, date);
      const l = b.loan;
      if (!l || l.memberId !== memberId) return { ok: false };
      if (date > l.dueDate) return { ok: false };
      if (l.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      l.renewals += 1;
      l.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: l.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !isValidDate(date)) return { ok: false };
      settle(b, date);
      if (!b.loan || b.loan.memberId === memberId) return { ok: false };
      if (b.queue.some((e) => e.memberId === memberId)) return { ok: false };
      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      const m = members.get(memberId);
      if (!m || !isValidDate(date)) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      const m = members.get(memberId);
      if (!m || !isValidDate(date)) return { ok: false };
      settleAll(date);

      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate });
        }
        b.queue.forEach((e, i) => {
          if (e.memberId === memberId) {
            holds.push({
              bookId,
              position: i + 1,
              readyUntil: i === 0 && !b.loan && e.readyUntil !== null ? e.readyUntil : null,
            });
          }
        });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
