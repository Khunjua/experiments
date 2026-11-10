const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 7;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const DAY_MS = 86400000;

const toDay = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};
const toStr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null, queue: [{ memberId, readyUntil }] }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Lapse pickup windows that have passed; pass the reservation to the next in line.
  function settle(now) {
    for (const book of books.values()) {
      while (
        book.queue.length > 0 &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < now
      ) {
        const lapsed = book.queue.shift();
        const next = book.queue[0];
        if (next) next.readyUntil = lapsed.readyUntil + PICKUP_DAYS;
      }
    }
  }

  // Set aside a returned book for the first person waiting.
  function reserveFront(book, now) {
    const front = book.queue[0];
    if (front && !book.loan) front.readyUntil = now + PICKUP_DAYS;
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      const now = toDay(date);
      settle(now);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || b.loan) return { ok: false };
      if (b.queue.length > 0 && b.queue[0].memberId !== memberId) return { ok: false };
      b.queue.shift(); // collect own reservation, if any
      b.loan = { memberId, due: now + LOAN_DAYS, renewals: 0 };
      return { ok: true, dueDate: toStr(b.loan.due) };
    },

    returnBook({ memberId, bookId, date }) {
      const now = toDay(date);
      settle(now);
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      const late = now - b.loan.due;
      const fine = Math.min(Math.max(0, late - GRACE_DAYS) * FINE_PER_DAY, FINE_CAP);
      members.get(memberId).owed += fine;
      b.loan = null;
      reserveFront(b, now);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const now = toDay(date);
      settle(now);
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (
        now > b.loan.due ||
        b.loan.renewals >= MAX_RENEWALS ||
        b.queue.length > 0
      ) {
        return { ok: false };
      }
      b.loan.due = now + LOAN_DAYS;
      b.loan.renewals += 1;
      return { ok: true, dueDate: toStr(b.loan.due) };
    },

    placeHold({ memberId, bookId, date }) {
      const now = toDay(date);
      settle(now);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !b.loan || b.loan.memberId === memberId) {
        return { ok: false };
      }
      if (b.queue.some((e) => e.memberId === memberId)) return { ok: false };
      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      settle(toDay(date));
      const m = members.get(memberId);
      if (!m || !Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      settle(toDay(date));
      const m = members.get(memberId);
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: toStr(b.loan.due) });
        }
        const idx = b.queue.findIndex((e) => e.memberId === memberId);
        if (idx >= 0) {
          const e = b.queue[idx];
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: e.readyUntil === null ? null : toStr(e.readyUntil),
          });
        }
      }
      return { loans, owed: m ? m.owed : 0, holds };
    },
  };
}
