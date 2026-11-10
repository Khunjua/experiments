export function createLibrary() {
  const books = new Map();
  const members = new Map();

  const DAY = 86400000;
  const parse = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const fmt = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (s, n) => fmt(parse(s) + n * DAY);
  const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / DAY);

  function expire(date) {
    if (typeof date !== 'string') return;
    for (const b of books.values()) {
      while (b.ready && b.readyUntil < date) {
        b.holds.shift();
        if (b.holds.length) {
          b.readyUntil = addDays(b.readyUntil, 3);
        } else {
          b.ready = false;
          b.readyUntil = null;
        }
      }
    }
  }

  return {
    addBook({ bookId } = {}) {
      if (books.has(bookId)) return { ok: false, reason: 'exists' };
      books.set(bookId, { loan: null, holds: [], ready: false, readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (members.has(memberId)) return { ok: false, reason: 'exists' };
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
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
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      const late = diffDays(date, b.loan.dueDate);
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.holds.length) {
        b.ready = true;
        b.readyUntil = addDays(date, 3);
      }
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= 2) return { ok: false };
      if (b.holds.length > 0) return { ok: false };
      if (date > b.loan.dueDate) return { ok: false };
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (!b.loan && !b.ready) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.holds.includes(memberId)) return { ok: false };
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      for (const id of m.loans) loans.push({ bookId: id, dueDate: books.get(id).loan.dueDate });
      const holds = [];
      for (const [id, b] of books) {
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId: id,
            position: i + 1,
            readyUntil: i === 0 && b.ready ? b.readyUntil : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
