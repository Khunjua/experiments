export function createLibrary() {
  const books = new Map();
  const members = new Map();
  const DAY = 86400000;
  const toDays = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / DAY);
  };
  const fromDays = (n) => new Date(n * DAY).toISOString().slice(0, 10);
  const addDays = (s, n) => fromDays(toDays(s) + n);
  const valid = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  function expire(date) {
    for (const b of books.values()) {
      while (b.ready && b.ready.until < date) {
        const until = b.ready.until;
        b.holds.shift();
        b.ready = b.holds.length ? { until: addDays(until, 3) } : null;
      }
    }
  }

  const fail = (reason) => ({ ok: false, reason });

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || books.has(bookId)) return fail('exists');
      books.set(bookId, { loan: null, holds: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || members.has(memberId)) return fail('exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (m.owed >= 1000) return fail('owes');
      let count = 0;
      for (const x of books.values()) if (x.loan && x.loan.memberId === memberId) count++;
      if (count >= 5) return fail('limit');
      if (b.ready) {
        if (b.holds[0] !== memberId) return fail('set aside');
        b.holds.shift();
        b.ready = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      const late = toDays(date) - toDays(b.loan.dueDate);
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      b.loan = null;
      if (b.holds.length) b.ready = { until: addDays(date, 3) };
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (b.holds.length) return fail('held');
      if (date > b.loan.dueDate) return fail('overdue');
      b.loan.renewals++;
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (!valid(date)) return fail('date');
      expire(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.ready) return fail('on shelf');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.holds.includes(memberId)) return fail('duplicate');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (valid(date)) expire(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      if (valid(date)) expire(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      const loans = [], holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: b.loan.dueDate });
        const i = b.holds.indexOf(memberId);
        if (i >= 0) holds.push({ bookId, position: i + 1, readyUntil: i === 0 && b.ready ? b.ready.until : null });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
