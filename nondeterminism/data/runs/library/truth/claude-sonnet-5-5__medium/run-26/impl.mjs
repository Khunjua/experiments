const DAY = 86400000;
const toDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY;
};
const fromDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  function expire(date) {
    const d = toDay(date);
    if (Number.isNaN(d)) return;
    for (const b of books.values()) {
      while (b.ready !== null && d > b.ready) {
        b.holds.shift();
        if (b.holds.length) b.ready += 3;
        else b.ready = null;
      }
    }
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, holds: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const d = toDay(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || Number.isNaN(d)) return { ok: false };
      expire(date);
      if (b.loan) return { ok: false };
      if (m.loans.size >= 5) return { ok: false };
      if (m.owed >= 1000) return { ok: false };
      if (b.ready !== null && b.holds[0] !== memberId) return { ok: false };
      if (b.ready !== null) {
        b.holds.shift();
        b.ready = null;
      }
      const due = d + 21;
      b.loan = { memberId, due, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate: fromDay(due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const d = toDay(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || Number.isNaN(d)) return { ok: false };
      expire(date);
      if (!b.loan || b.loan.memberId !== memberId) return { ok: false };
      const late = d - b.loan.due;
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.holds.length) b.ready = d + 3;
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const d = toDay(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || Number.isNaN(d)) return { ok: false };
      expire(date);
      if (!b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= 2) return { ok: false };
      if (b.holds.length > 0) return { ok: false };
      if (d > b.loan.due) return { ok: false };
      b.loan.due += 21;
      b.loan.renewals++;
      return { ok: true, dueDate: fromDay(b.loan.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const d = toDay(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || Number.isNaN(d)) return { ok: false };
      expire(date);
      if (!b.loan && b.ready === null) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.holds.includes(memberId)) return { ok: false };
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const m = members.get(memberId);
      if (!m) return { ok: false };
      expire(date);
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const m = members.get(memberId);
      if (!m) return { ok: false };
      expire(date);
      const loans = [];
      for (const id of m.loans) loans.push({ bookId: id, dueDate: fromDay(books.get(id).loan.due) });
      const holds = [];
      for (const [id, b] of books) {
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId: id,
            position: i + 1,
            readyUntil: b.ready !== null && i === 0 ? fromDay(b.ready) : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
