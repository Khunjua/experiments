const LOAN_DAYS = 21;
const RENEWAL_LIMIT = 2;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const FINE_PER_DAY = 25;
const FINE_GRACE_DAYS = 3;
const FINE_CAP = 500;
const BORROW_BLOCK_OWED = 1000;
const DAY_MS = 86400000;

function toDayNum(s) {
  return Date.parse(s + 'T00:00:00Z') / DAY_MS;
}

function addDays(s, n) {
  return new Date((toDayNum(s) + n) * DAY_MS).toISOString().slice(0, 10);
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDate, renewals }, queue: [{ memberId, readyUntil }] }
  // queue[0] is set aside (readyUntil is a date string) only while the book is on the shelf.
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  function countLoans(memberId) {
    let n = 0;
    for (const b of books.values()) {
      if (b.loan && b.loan.memberId === memberId) n++;
    }
    return n;
  }

  function countHolds(memberId) {
    let n = 0;
    for (const b of books.values()) {
      if (b.queue.some((e) => e.memberId === memberId)) n++;
    }
    return n;
  }

  // Expire set-aside holds that were not picked up before `date`.
  function advance(date) {
    for (const book of books.values()) {
      if (book.loan) continue;
      while (
        book.queue.length &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < date
      ) {
        const expired = book.queue.shift();
        if (book.queue.length) {
          // Next in line is set aside from the day after the expired window ends.
          book.queue[0].readyUntil = addDays(expired.readyUntil, PICKUP_DAYS + 1);
        }
      }
    }
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
      advance(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || b.loan) return { ok: false };
      if (m.owed >= BORROW_BLOCK_OWED) return { ok: false };
      if (countLoans(memberId) >= MAX_LOANS) return { ok: false };
      const head = b.queue[0];
      if (head && head.memberId !== memberId) return { ok: false };
      if (head) b.queue.shift();
      const dueDate = addDays(date, LOAN_DAYS);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      advance(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      const late = Math.max(0, toDayNum(date) - toDayNum(b.loan.dueDate));
      const fine = Math.min(
        FINE_CAP,
        FINE_PER_DAY * Math.max(0, late - FINE_GRACE_DAYS)
      );
      m.owed += fine;
      b.loan = null;
      if (b.queue.length) {
        b.queue[0].readyUntil = addDays(date, PICKUP_DAYS);
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      advance(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= RENEWAL_LIMIT) return { ok: false };
      if (b.queue.length) return { ok: false };
      if (toDayNum(date) > toDayNum(b.loan.dueDate)) return { ok: false };
      b.loan.renewals += 1;
      b.loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      advance(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan) return { ok: false };
      if (b.loan.memberId === memberId) return { ok: false };
      if (b.queue.some((e) => e.memberId === memberId)) return { ok: false };
      if (countHolds(memberId) >= MAX_HOLDS) return { ok: false };
      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      advance(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      advance(date);
      const m = members.get(memberId);
      if (!m) return { ok: false, loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate });
        }
        const idx = b.queue.findIndex((e) => e.memberId === memberId);
        if (idx >= 0) {
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: b.queue[idx].readyUntil,
          });
        }
      }
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
