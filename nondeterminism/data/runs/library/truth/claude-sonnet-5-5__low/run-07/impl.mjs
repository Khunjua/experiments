export function createLibrary() {
  const books = new Map();
  const members = new Map();

  const toDay = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };
  const toStr = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

  function sync(date) {
    const today = toDay(date);
    for (const b of books.values()) {
      while (b.ready && today > b.readyUntil) {
        b.holds.shift();
        if (b.holds.length > 0) {
          b.readyUntil += 3;
        } else {
          b.ready = false;
          b.readyUntil = null;
        }
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false, reason: 'exists' };
      books.set(bookId, { loan: null, holds: [], ready: false, readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false, reason: 'exists' };
      members.set(memberId, { loans: new Set(), owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date }) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loan) return { ok: false };
      if (m.loans.size >= 5) return { ok: false };
      if (m.owed >= 1000) return { ok: false };
      if (b.ready) {
        if (b.holds[0] !== memberId) return { ok: false };
        b.holds.shift();
        b.ready = false;
        b.readyUntil = null;
      }
      const due = toDay(date) + 21;
      b.loan = { memberId, due, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate: toStr(due) };
    },
    returnBook({ memberId, bookId, date }) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      const late = toDay(date) - b.loan.due;
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.holds.length > 0) {
        b.ready = true;
        b.readyUntil = toDay(date) + 3;
      }
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date }) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= 2) return { ok: false };
      if (b.holds.length > 0) return { ok: false };
      if (toDay(date) > b.loan.due) return { ok: false };
      b.loan.due += 21;
      b.loan.renewals++;
      return { ok: true, dueDate: toStr(b.loan.due) };
    },
    placeHold({ memberId, bookId, date }) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (!b.loan && !b.ready) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.holds.includes(memberId)) return { ok: false };
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date }) {
      sync(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date }) {
      sync(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      for (const id of m.loans) loans.push({ bookId: id, dueDate: toStr(books.get(id).loan.due) });
      const holds = [];
      for (const [id, b] of books) {
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId: id,
            position: i + 1,
            readyUntil: b.ready && i === 0 ? toStr(b.readyUntil) : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
