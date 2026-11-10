const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BORROW_BLOCK_CENTS = 1000;
const LATE_FEE_CENTS = 25;
const FREE_LATE_DAYS = 2;
const FINE_CAP_CENTS = 500;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 3;

function toDay(str) {
  const [y, m, d] = str.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function toStr(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function fineFor(lateDays) {
  if (lateDays <= FREE_LATE_DAYS) return 0;
  return Math.min(lateDays * LATE_FEE_CENTS, FINE_CAP_CENTS);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loanedTo: memberId|null, queue: [memberId], reserved: {memberId, readyUntil}|null }
  const members = new Map(); // memberId -> { loans: Map(bookId -> {dueDate, renewals}), owed: cents }

  // Applies lapsed set-asides up to day `today` (day numbers).
  function advance(today) {
    for (const book of books.values()) {
      while (book.reserved && today > book.reserved.readyUntil) {
        book.queue.shift();
        if (book.queue.length === 0) {
          book.reserved = null;
        } else {
          book.reserved = {
            memberId: book.queue[0],
            readyUntil: book.reserved.readyUntil + PICKUP_DAYS,
          };
        }
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loanedTo: null, queue: [], reserved: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { loans: new Map(), owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      const t = toDay(date);
      advance(t);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.loans.size >= MAX_LOANS) return { ok: false };
      if (m.owed >= BORROW_BLOCK_CENTS) return { ok: false };
      if (b.loanedTo !== null) return { ok: false };
      if (b.reserved) {
        if (b.reserved.memberId !== memberId) return { ok: false };
        b.queue.shift();
        b.reserved = null;
      }
      const due = t + LOAN_DAYS;
      b.loanedTo = memberId;
      m.loans.set(bookId, { dueDate: due, renewals: 0 });
      return { ok: true, dueDate: toStr(due) };
    },

    returnBook({ memberId, bookId, date }) {
      const t = toDay(date);
      advance(t);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false, fine: 0 };
      const loan = m.loans.get(bookId);
      if (!loan || b.loanedTo !== memberId) return { ok: false, fine: 0 };
      const fine = fineFor(t - loan.dueDate);
      m.loans.delete(bookId);
      m.owed += fine;
      b.loanedTo = null;
      if (b.queue.length > 0) {
        b.reserved = { memberId: b.queue[0], readyUntil: t + PICKUP_DAYS };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const t = toDay(date);
      advance(t);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      const loan = m.loans.get(bookId);
      if (!loan || b.loanedTo !== memberId) return { ok: false };
      if (loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (t > loan.dueDate) return { ok: false };
      loan.dueDate += LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: toStr(loan.dueDate) };
    },

    placeHold({ memberId, bookId, date }) {
      const t = toDay(date);
      advance(t);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loanedTo === null && !b.reserved) return { ok: false };
      if (b.loanedTo === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      advance(toDay(date));
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      const t = toDay(date);
      advance(t);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };

      const loans = [...m.loans].map(([bookId, loan]) => ({
        bookId,
        dueDate: toStr(loan.dueDate),
      }));

      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.indexOf(memberId);
        if (idx === -1) continue;
        const readyUntil =
          b.reserved && b.reserved.memberId === memberId
            ? toStr(b.reserved.readyUntil)
            : null;
        holds.push({ bookId, position: idx + 1, readyUntil });
      }

      return { loans, owed: m.owed, holds };
    },
  };
}
