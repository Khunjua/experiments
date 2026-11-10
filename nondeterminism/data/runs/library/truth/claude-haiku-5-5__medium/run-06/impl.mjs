const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BLOCK_OWED_CENTS = 1000;
const LATE_FREE_DAYS = 2;
const LATE_DAY_CENTS = 25;
const FINE_CAP_CENTS = 500;
const MAX_RENEWALS = 2;
const HOLD_WINDOW_DAYS = 3;

function dayNum(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function dayStr(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDay, renewals } | null,
  //             queue: [memberId],            // hold line, index 0 = next
  //             reserve: { memberId, untilDay } | null }  // set aside for queue[0]
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Expire set-aside holds that were not collected by their last day.
  function sweep(day) {
    for (const b of books.values()) {
      while (b.reserve && day > b.reserve.untilDay) {
        b.queue = b.queue.filter((id) => id !== b.reserve.memberId);
        if (b.queue.length > 0) {
          b.reserve = {
            memberId: b.queue[0],
            untilDay: b.reserve.untilDay + HOLD_WINDOW_DAYS,
          };
        } else {
          b.reserve = null;
        }
      }
    }
  }

  function loanCount(memberId) {
    let n = 0;
    for (const b of books.values()) {
      if (b.loan && b.loan.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], reserve: null });
      return { ok: true };
    },

    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date }) {
      const d = dayNum(date);
      sweep(d);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (m.owed >= BLOCK_OWED_CENTS) return { ok: false };
      if (loanCount(memberId) >= MAX_LOANS) return { ok: false };
      if (b.loan) return { ok: false };
      if (b.reserve) {
        if (b.reserve.memberId !== memberId) return { ok: false };
        b.queue = b.queue.filter((id) => id !== memberId);
        b.reserve = null;
      } else if (b.queue.length > 0) {
        return { ok: false };
      }
      const dueDay = d + LOAN_DAYS;
      b.loan = { memberId, dueDay, renewals: 0 };
      return { ok: true, dueDate: dayStr(dueDay) };
    },

    returnBook({ memberId, bookId, date }) {
      const d = dayNum(date);
      sweep(d);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (!b.loan || b.loan.memberId !== memberId) return { ok: false };

      const late = Math.max(0, d - b.loan.dueDay);
      let fine = 0;
      if (late > LATE_FREE_DAYS) {
        fine = Math.min(late * LATE_DAY_CENTS, FINE_CAP_CENTS);
      }
      m.owed += fine;
      b.loan = null;

      if (b.queue.length > 0) {
        b.reserve = { memberId: b.queue[0], untilDay: d + HOLD_WINDOW_DAYS };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date }) {
      const d = dayNum(date);
      sweep(d);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (!b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      if (d > b.loan.dueDay) return { ok: false };

      b.loan.dueDay += LOAN_DAYS;
      b.loan.renewals += 1;
      return { ok: true, dueDate: dayStr(b.loan.dueDay) };
    },

    placeHold({ memberId, bookId, date }) {
      const d = dayNum(date);
      sweep(d);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      if (!b.loan && !b.reserve) return { ok: false };

      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },

    payFine({ memberId, amount, date }) {
      const d = dayNum(date);
      sweep(d);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date }) {
      const d = dayNum(date);
      sweep(d);
      const m = members.get(memberId);
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: dayStr(b.loan.dueDay) });
        }
        const idx = b.queue.indexOf(memberId);
        if (idx >= 0) {
          const setAside = b.reserve && b.reserve.memberId === memberId;
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: setAside ? dayStr(b.reserve.untilDay) : null,
          });
        }
      }
      return { loans, owed: m ? m.owed : 0, holds };
    },
  };
}
