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
      while (b.readyFor !== null && date > b.readyUntil) {
        const idx = b.holds.indexOf(b.readyFor);
        if (idx >= 0) b.holds.splice(idx, 1);
        if (b.holds.length > 0) {
          b.readyFor = b.holds[0];
          b.readyUntil = addDays(b.readyUntil, 3);
        } else {
          b.readyFor = null;
          b.readyUntil = null;
        }
      }
    }
  }

  const fail = (reason) => ({ ok: false, reason });

  function memberLoanCount(memberId) {
    let n = 0;
    for (const b of books.values()) if (b.loan && b.loan.memberId === memberId) n++;
    return n;
  }

  return {
    addBook({ bookId } = {}) {
      if (books.has(bookId)) return fail('exists');
      books.set(bookId, { loan: null, holds: [], readyFor: null, readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (members.has(memberId)) return fail('exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (m.owed >= 1000) return fail('owes');
      if (b.loan) return fail('on loan');
      if (memberLoanCount(memberId) >= 5) return fail('limit');
      if (b.readyFor !== null && b.readyFor !== memberId) return fail('reserved');
      if (b.readyFor === memberId) {
        const idx = b.holds.indexOf(memberId);
        if (idx >= 0) b.holds.splice(idx, 1);
        b.readyFor = null;
        b.readyUntil = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      const late = diffDays(date, b.loan.dueDate);
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      b.loan = null;
      if (b.holds.length > 0) {
        b.readyFor = b.holds[0];
        b.readyUntil = addDays(date, 3);
      }
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
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
    placeHold({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && b.readyFor === null) return fail('free');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.holds.includes(memberId)) return fail('duplicate');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('bad amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate });
        }
        const idx = b.holds.indexOf(memberId);
        if (idx >= 0) {
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: b.readyFor === memberId ? b.readyUntil : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
