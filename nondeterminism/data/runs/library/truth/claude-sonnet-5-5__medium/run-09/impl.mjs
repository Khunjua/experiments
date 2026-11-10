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
    for (const b of books.values()) {
      while (b.ready && b.ready.until < date) {
        b.holds.shift();
        if (b.holds.length > 0) {
          b.ready = { until: addDays(b.ready.until, 3) };
        } else {
          b.ready = null;
        }
      }
    }
  }

  const fail = (reason) => ({ ok: false, reason });

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return fail('exists');
      books.set(bookId, { loan: null, holds: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId }) {
      if (members.has(memberId)) return fail('exists');
      members.set(memberId, { owed: 0, loans: new Map() });
      return { ok: true };
    },
    borrow({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (m.owed >= 1000) return fail('owes');
      if (m.loans.size >= 5) return fail('limit');
      if (b.ready) {
        if (b.holds[0] !== memberId) return fail('set aside');
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
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      const late = diffDays(date, b.loan.dueDate);
      let fine = 0;
      if (late >= 3) fine = Math.min(late * 25, 500);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.holds.length > 0) b.ready = { until: addDays(date, 3) };
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (b.holds.length > 0) return fail('held');
      if (date > b.loan.dueDate) return fail('overdue');
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.ready) return fail('available');
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
        if (i >= 0) {
          holds.push({
            bookId,
            position: i + 1,
            readyUntil: i === 0 && b.ready ? b.ready.until : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
