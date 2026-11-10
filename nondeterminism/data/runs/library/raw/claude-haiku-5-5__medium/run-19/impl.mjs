const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const HOLD_PICKUP_DAYS = 3;
const GRACE_DAYS = 3;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;

function toDayNumber(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function toDateString(dayNumber) {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null,
  //             queue: [memberId, ...],   // hold line; queue[0] is ready holder when ready is set
  //             ready: { memberId, until } | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Lapse set-aside reservations whose pickup window has passed.
  function sweep(day) {
    for (const b of books.values()) {
      while (b.ready && day > b.ready.until) {
        let until = b.ready.until;
        b.queue.shift();
        if (b.queue.length > 0) {
          until += HOLD_PICKUP_DAYS;
          b.ready = { memberId: b.queue[0], until };
        } else {
          b.ready = null;
        }
      }
    }
  }

  // Set a returned book aside for the first person in line.
  function setAside(b, day) {
    if (!b.loan && !b.ready && b.queue.length > 0) {
      b.ready = { memberId: b.queue[0], until: day + HOLD_PICKUP_DAYS };
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], ready: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      const day = toDayNumber(date);
      sweep(day);
      const b = books.get(bookId);
      const m = members.get(memberId);
      if (!b || !m) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.ready && b.ready.memberId !== memberId) return { ok: false };
      if (b.ready && b.ready.memberId === memberId) {
        b.queue.shift();
        b.ready = null;
      }
      b.loan = { memberId, due: day + LOAN_DAYS, renewals: 0 };
      return { ok: true, dueDate: toDateString(b.loan.due) };
    },

    returnBook({ memberId, bookId, date }) {
      const day = toDayNumber(date);
      sweep(day);
      const b = books.get(bookId);
      const m = members.get(memberId);
      if (!b || !m || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      const overdue = day - b.loan.due;
      const fine = overdue > GRACE_DAYS
        ? Math.min(FINE_CAP, (overdue - GRACE_DAYS) * FINE_PER_DAY)
        : 0;
      m.owed += fine;
      b.loan = null;
      setAside(b, day);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const day = toDayNumber(date);
      sweep(day);
      const b = books.get(bookId);
      if (!b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (day > b.loan.due) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      b.loan.due = day + LOAN_DAYS;
      b.loan.renewals += 1;
      return { ok: true, dueDate: toDateString(b.loan.due) };
    },

    placeHold({ memberId, bookId, date }) {
      const day = toDayNumber(date);
      sweep(day);
      const b = books.get(bookId);
      if (!b || !members.has(memberId)) return { ok: false };
      if (!b.loan && !b.ready) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      const day = toDayNumber(date);
      sweep(day);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      const day = toDayNumber(date);
      sweep(day);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };

      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: toDateString(b.loan.due) });
        }
        const idx = b.queue.indexOf(memberId);
        if (idx >= 0) {
          const isReady = b.ready !== null && b.ready.memberId === memberId;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: isReady ? toDateString(b.ready.until) : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
