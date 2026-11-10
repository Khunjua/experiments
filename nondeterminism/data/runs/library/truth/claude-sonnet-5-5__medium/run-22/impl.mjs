const DAY = 86400000;
const toNum = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY;
};
const toStr = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const addDays = (s, k) => toStr(toNum(s) + k);

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  const fail = (reason) => ({ ok: false, reason });

  function expire(date) {
    for (const b of books.values()) {
      while (b.ready && b.ready < date) {
        b.holds.shift();
        if (b.holds.length > 0) b.ready = addDays(b.ready, 3);
        else b.ready = null;
      }
    }
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return fail('exists');
      books.set(bookId, { loan: null, holds: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId }) {
      if (members.has(memberId)) return fail('exists');
      members.set(memberId, { loans: new Map(), owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (m.loans.size >= 5) return fail('limit');
      if (m.owed >= 1000) return fail('owes');
      if (b.ready && b.holds[0] !== memberId) return fail('set aside');
      if (b.ready) {
        b.holds.shift();
        b.ready = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.set(bookId, b.loan);
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      const late = toNum(date) - toNum(b.loan.dueDate);
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.holds.length > 0) b.ready = addDays(date, 3);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      const l = b.loan;
      if (!l || l.memberId !== memberId) return fail('not on loan');
      if (l.renewals >= 2) return fail('max renewals');
      if (b.holds.length > 0) return fail('holds');
      if (toNum(date) > toNum(l.dueDate)) return fail('overdue');
      l.dueDate = addDays(l.dueDate, 21);
      l.renewals++;
      return { ok: true, dueDate: l.dueDate };
    },
    placeHold({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.ready) return fail('on shelf');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.holds.includes(memberId)) return fail('duplicate');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date }) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('bad amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date }) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      const loans = [];
      for (const [bookId, l] of m.loans) loans.push({ bookId, dueDate: l.dueDate });
      const holds = [];
      for (const [bookId, b] of books) {
        const i = b.holds.indexOf(memberId);
        if (i >= 0) holds.push({ bookId, position: i + 1, readyUntil: i === 0 && b.ready ? b.ready : null });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
