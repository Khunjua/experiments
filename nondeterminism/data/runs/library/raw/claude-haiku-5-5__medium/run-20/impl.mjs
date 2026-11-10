const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const PICKUP_DAYS = 2;

function toDay(s) {
  return Date.parse(s + 'T00:00:00Z') / DAY_MS;
}

function toStr(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function fineFor(dueDay, returnDay) {
  const late = returnDay - dueDay;
  if (late <= GRACE_DAYS) return 0;
  return Math.min(MAX_FINE_PER_LOAN, (late - GRACE_DAYS) * FINE_PER_DAY);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDay, renewals } | null, queue: [{ memberId, readyUntil }] }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Expire set-aside holds whose pickup window ended before `day`.
  function sweep(day) {
    for (const book of books.values()) {
      while (
        book.queue.length > 0 &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < day
      ) {
        const lapsed = book.queue.shift();
        if (book.queue.length > 0) {
          const lapseDay = lapsed.readyUntil + 1;
          book.queue[0].readyUntil = lapseDay + PICKUP_DAYS;
        }
      }
    }
  }

  // If a book is on the shelf and someone is waiting, set it aside for the first in line.
  function setAside(book, day) {
    if (book.loan === null && book.queue.length > 0 && book.queue[0].readyUntil === null) {
      book.queue[0].readyUntil = day + PICKUP_DAYS;
    }
  }

  function activeLoans(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      if (book.loan !== null && book.loan.memberId === memberId) {
        out.push({ bookId, loan: book.loan });
      }
    }
    return out;
  }

  return {
    addBook({ bookId }) {
      if (!isId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (!isId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      const day = toDay(date);
      sweep(day);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.owed > 0) return { ok: false };
      const mine = activeLoans(memberId);
      if (mine.length >= MAX_LOANS) return { ok: false };
      if (mine.some(({ bookId: id, loan }) => id === bookId || day > loan.dueDay)) {
        return { ok: false };
      }
      if (b.loan !== null) return { ok: false };
      if (b.queue.length > 0) {
        const first = b.queue[0];
        if (first.memberId !== memberId || first.readyUntil === null) return { ok: false };
        b.queue.shift();
      }
      b.loan = { memberId, dueDay: day + LOAN_DAYS, renewals: 0 };
      return { ok: true, dueDate: toStr(b.loan.dueDay) };
    },

    returnBook({ memberId, bookId, date }) {
      const day = toDay(date);
      sweep(day);
      const b = books.get(bookId);
      if (!b || b.loan === null || b.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }
      const fine = fineFor(b.loan.dueDay, day);
      b.loan = null;
      if (fine > 0) members.get(memberId).owed += fine;
      setAside(b, day);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const day = toDay(date);
      sweep(day);
      const b = books.get(bookId);
      if (!b || b.loan === null || b.loan.memberId !== memberId) return { ok: false };
      if (day > b.loan.dueDay) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      b.loan.dueDay = day + LOAN_DAYS;
      b.loan.renewals += 1;
      return { ok: true, dueDate: toStr(b.loan.dueDay) };
    },

    placeHold({ memberId, bookId, date }) {
      const day = toDay(date);
      sweep(day);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      // Only books that are out (or already set aside) can be held.
      if (b.loan === null && b.queue.length === 0) return { ok: false };
      if (b.loan !== null && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.some((e) => e.memberId === memberId)) return { ok: false };
      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      const day = toDay(date);
      sweep(day);
      const m = members.get(memberId);
      if (!m) return { ok: false, owed: 0 };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false, owed: m.owed };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      const day = toDay(date);
      sweep(day);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = activeLoans(memberId).map(({ bookId, loan }) => ({
        bookId,
        dueDate: toStr(loan.dueDay),
      }));
      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.findIndex((e) => e.memberId === memberId);
        if (idx >= 0) {
          const r = b.queue[idx].readyUntil;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: r === null ? null : toStr(r),
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
