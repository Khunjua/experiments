const MS_PER_DAY = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const FINE_CAP = 1000;
const HOLD_DAYS = 7;

function dayNum(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

function dayStr(n) {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

// Expire lapsed pickup windows. An expired holder is removed from the queue,
// and the next waiting member (if any) is set aside from the day after the lapse.
function sync(book, t) {
  while (book.readyUntil !== null && book.readyUntil < t) {
    const lapsed = book.readyUntil;
    book.queue.shift();
    book.readyUntil = null;
    if (book.queue.length > 0 && !book.loan) {
      book.readyUntil = lapsed + HOLD_DAYS;
    }
  }
}

// If a book is free and someone is waiting, set it aside for the first in line.
function offerShelf(book, t) {
  if (!book.loan && book.readyUntil === null && book.queue.length > 0) {
    book.readyUntil = t + HOLD_DAYS - 1;
  }
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, queue, readyUntil }
  const members = new Map(); // memberId -> { owed }

  return {
    addBook({ bookId }) {
      if (!isId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (!isId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      const t = dayNum(date);
      sync(b, t);
      if (b.loan) return { ok: false };
      if (m.owed > 0) return { ok: false };
      if (b.queue.length > 0 && b.queue[0].memberId !== memberId) return { ok: false };
      if (b.queue.length > 0) {
        b.queue.shift();
        b.readyUntil = null;
      }
      b.loan = { memberId, dueDay: t + LOAN_DAYS, renewals: 0 };
      return { ok: true, dueDate: dayStr(t + LOAN_DAYS) };
    },

    returnBook({ memberId, bookId, date }) {
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      const t = dayNum(date);
      sync(b, t);
      if (!b.loan || b.loan.memberId !== memberId) return { ok: false };
      const late = t - b.loan.dueDay;
      const chargeable = Math.max(0, late - GRACE_DAYS);
      const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
      m.owed += fine;
      b.loan = null;
      offerShelf(b, t);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const b = books.get(bookId);
      if (!members.has(memberId) || !b) return { ok: false };
      const t = dayNum(date);
      sync(b, t);
      if (!b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (t > b.loan.dueDay) return { ok: false };
      b.loan.dueDay = t + LOAN_DAYS;
      b.loan.renewals += 1;
      return { ok: true, dueDate: dayStr(b.loan.dueDay) };
    },

    placeHold({ memberId, bookId, date }) {
      const b = books.get(bookId);
      if (!members.has(memberId) || !b) return { ok: false };
      const t = dayNum(date);
      sync(b, t);
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.some(q => q.memberId === memberId)) return { ok: false };
      if (!b.loan && b.readyUntil === null) return { ok: false };
      b.queue.push({ memberId });
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      const t = dayNum(date);
      for (const b of books.values()) sync(b, t);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };

      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: dayStr(b.loan.dueDay) });
        }
        const idx = b.queue.findIndex(q => q.memberId === memberId);
        if (idx >= 0) {
          const setAside = idx === 0 && b.readyUntil !== null;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: setAside ? dayStr(b.readyUntil) : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
