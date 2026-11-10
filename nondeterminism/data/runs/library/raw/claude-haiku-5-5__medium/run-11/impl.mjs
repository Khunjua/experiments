const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const PICKUP_DAYS = 7;

const DAY_MS = 86400000;

function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function toStr(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null, queue: [{ memberId, readyUntil }] }
  // readyUntil is a day number, or null while waiting. Only queue[0] can be ready.
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Process pickup-window expirations up to and including day `now`.
  function sync(now) {
    for (const book of books.values()) {
      while (
        book.queue.length > 0 &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < now
      ) {
        const expired = book.queue.shift();
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = expired.readyUntil + PICKUP_DAYS;
        }
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (bookId === undefined || bookId === null || books.has(bookId)) {
        return { ok: false };
      }
      books.set(bookId, { loan: null, queue: [] });
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
      const d = toDay(date);
      sync(d);
      const book = books.get(bookId);
      if (!book || !members.has(memberId)) return { ok: false };
      if (book.loan) return { ok: false };
      if (book.queue.length > 0) {
        const front = book.queue[0];
        if (
          front.memberId !== memberId ||
          front.readyUntil === null ||
          d > front.readyUntil
        ) {
          return { ok: false };
        }
        book.queue.shift();
      }
      const due = d + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      return { ok: true, dueDate: toStr(due) };
    },

    returnBook({ memberId, bookId, date }) {
      const d = toDay(date);
      sync(d);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }
      const lateDays = d - book.loan.due;
      const chargeable = Math.max(0, lateDays - GRACE_DAYS);
      const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
      if (fine > 0) {
        members.get(memberId).owed += fine;
      }
      book.loan = null;
      if (book.queue.length > 0) {
        book.queue[0].readyUntil = d + PICKUP_DAYS - 1;
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const d = toDay(date);
      sync(d);
      const book = books.get(bookId);
      if (!book || !book.loan || book.loan.memberId !== memberId) {
        return { ok: false };
      }
      if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (d > book.loan.due) return { ok: false };
      if (book.queue.length > 0) return { ok: false };
      book.loan.due = d + LOAN_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: toStr(book.loan.due) };
    },

    placeHold({ memberId, bookId, date }) {
      const d = toDay(date);
      sync(d);
      const book = books.get(bookId);
      if (!book || !members.has(memberId)) return { ok: false };
      const available = !book.loan && book.queue.length === 0;
      if (available) return { ok: false };
      if (book.loan && book.loan.memberId === memberId) return { ok: false };
      if (book.queue.some((h) => h.memberId === memberId)) return { ok: false };
      book.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date }) {
      sync(toDay(date));
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      sync(toDay(date));
      const m = members.get(memberId);
      if (!m) return { ok: false, loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: toStr(book.loan.due) });
        }
        book.queue.forEach((h, i) => {
          if (h.memberId === memberId) {
            holds.push({
              bookId,
              position: i + 1,
              readyUntil: h.readyUntil === null ? null : toStr(h.readyUntil),
            });
          }
        });
      }
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
