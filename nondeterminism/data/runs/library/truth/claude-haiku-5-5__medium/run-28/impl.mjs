const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const HOLD_DAYS = 3;
const MAX_LOANS = 5;
const DEBT_LIMIT = 1000;
const LATE_FREE_DAYS = 2;
const LATE_RATE = 25;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;

function toDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function createLibrary() {
  // book: { loan: { memberId, dueDay, renewals } | null,
  //         queue: [memberId, ...],   // holds in line; queue[0] is set aside when reserve is set
  //         reserve: { memberId, readyUntil (day number) } | null }
  // member: { owed: cents, loans: Set<bookId> }
  const books = new Map();
  const members = new Map();

  // Applies expirations of set-aside books up to and including today.
  function settleAll(today) {
    for (const book of books.values()) {
      while (book.reserve && today > book.reserve.readyUntil) {
        book.queue.shift();
        if (book.queue.length === 0) {
          book.reserve = null;
        } else {
          book.reserve = {
            memberId: book.queue[0],
            readyUntil: book.reserve.readyUntil + HOLD_DAYS,
          };
        }
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], reserve: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      const today = toDay(date);
      settleAll(today);
      const b = books.get(bookId);
      const m = members.get(memberId);
      if (!b || !m) return { ok: false };
      if (m.owed >= DEBT_LIMIT) return { ok: false };
      if (m.loans.size >= MAX_LOANS) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.reserve && b.reserve.memberId !== memberId) return { ok: false };

      if (b.reserve && b.reserve.memberId === memberId) {
        // Hold ends; everyone behind moves up via the shift.
        b.queue.shift();
        b.reserve = null;
      }

      const dueDay = today + LOAN_DAYS;
      b.loan = { memberId, dueDay, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate: fromDay(dueDay) };
    },

    returnBook({ memberId, bookId, date }) {
      const today = toDay(date);
      settleAll(today);
      const b = books.get(bookId);
      const m = members.get(memberId);
      if (!b || !m || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false, fine: 0 };
      }

      const lateDays = today - b.loan.dueDay;
      let fine = 0;
      if (lateDays > LATE_FREE_DAYS) {
        fine = Math.min(lateDays * LATE_RATE, FINE_CAP);
      }

      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;

      if (b.queue.length > 0) {
        b.reserve = { memberId: b.queue[0], readyUntil: today + HOLD_DAYS };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const today = toDay(date);
      settleAll(today);
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (today > b.loan.dueDay) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };

      b.loan.dueDay += LOAN_DAYS;
      b.loan.renewals += 1;
      return { ok: true, dueDate: fromDay(b.loan.dueDay) };
    },

    placeHold({ memberId, bookId, date }) {
      const today = toDay(date);
      settleAll(today);
      const b = books.get(bookId);
      const m = members.get(memberId);
      if (!b || !m) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      if (!b.loan && !b.reserve) return { ok: false };

      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      const today = toDay(date);
      settleAll(today);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false, owed: m.owed };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      const today = toDay(date);
      settleAll(today);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };

      const loans = [];
      for (const bookId of m.loans) {
        const b = books.get(bookId);
        loans.push({ bookId, dueDate: fromDay(b.loan.dueDay) });
      }

      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.indexOf(memberId);
        if (idx === -1) continue;
        const setAside = b.reserve !== null && b.reserve.memberId === memberId;
        holds.push({
          bookId,
          position: idx + 1,
          readyUntil: setAside ? fromDay(b.reserve.readyUntil) : null,
        });
      }

      return { loans, owed: m.owed, holds };
    },
  };
}
