const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const PICKUP_DAYS = 3;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const BLOCK_OWED = 500;
const DAY_MS = 86400000;

function toMs(s) {
  return Date.parse(s + 'T00:00:00Z');
}

function addDays(s, n) {
  return new Date(toMs(s) + n * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

function fineFor(dueDate, returnDate) {
  const late = daysBetween(dueDate, returnDate);
  const chargeable = Math.max(0, late - GRACE_DAYS);
  return Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: null | loan, queue: [{ memberId, readyUntil, seq }] }
  const members = new Map(); // memberId -> { owed: number, loans: Map<bookId, loan> }
  let seq = 0;

  // Expire set-aside holds whose pickup window ended before `date`.
  function sync(date) {
    for (const book of books.values()) {
      while (
        book.queue.length > 0 &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < date
      ) {
        const expired = book.queue.shift();
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = addDays(expired.readyUntil, PICKUP_DAYS);
        }
      }
    }
  }

  function holdCount(memberId) {
    let n = 0;
    for (const b of books.values()) {
      if (b.queue.some((e) => e.memberId === memberId)) n++;
    }
    return n;
  }

  return {
    addBook({ bookId }) {
      if (typeof bookId !== 'string' || bookId === '' || books.has(bookId)) {
        return { ok: false };
      }
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (typeof memberId !== 'string' || memberId === '' || members.has(memberId)) {
        return { ok: false };
      }
      members.set(memberId, { owed: 0, loans: new Map() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.owed >= BLOCK_OWED || m.loans.size >= MAX_LOANS) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.queue.length > 0) {
        const head = b.queue[0];
        if (head.memberId !== memberId || head.readyUntil === null) return { ok: false };
        b.queue.shift();
      }
      const loan = { bookId, memberId, dueDate: addDays(date, LOAN_DAYS), renewals: 0 };
      b.loan = loan;
      m.loans.set(bookId, loan);
      return { ok: true, dueDate: loan.dueDate };
    },

    returnBook({ memberId, bookId, date }) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }
      const fine = fineFor(b.loan.dueDate, date);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.queue.length > 0) {
        b.queue[0].readyUntil = addDays(date, PICKUP_DAYS - 1);
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      const loan = b.loan;
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (date > loan.dueDate) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      loan.renewals += 1;
      loan.dueDate = addDays(date, LOAN_DAYS);
      return { ok: true, dueDate: loan.dueDate };
    },

    placeHold({ memberId, bookId, date }) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.owed >= BLOCK_OWED || holdCount(memberId) >= MAX_HOLDS) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (!b.loan && b.queue.length === 0) return { ok: false }; // book is on the shelf
      if (b.queue.some((e) => e.memberId === memberId)) return { ok: false };
      b.queue.push({ memberId, readyUntil: null, seq: ++seq });
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      sync(date);
      const m = members.get(memberId);
      if (!m) return { ok: false, owed: 0 };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false, owed: m.owed };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      sync(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };

      const loans = [...m.loans.values()].map((l) => ({
        bookId: l.bookId,
        dueDate: l.dueDate,
      }));

      const entries = [];
      for (const [bookId, b] of books) {
        b.queue.forEach((e, i) => {
          if (e.memberId === memberId) {
            entries.push({ seq: e.seq, bookId, position: i + 1, readyUntil: e.readyUntil });
          }
        });
      }
      entries.sort((x, y) => x.seq - y.seq);
      const holds = entries.map((e) => ({
        bookId: e.bookId,
        position: e.position,
        readyUntil: e.readyUntil,
      }));

      return { loans, owed: m.owed, holds };
    },
  };
}
