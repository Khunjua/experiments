export function createLibrary() {
  const books = new Map();
  const members = new Map();

  const parse = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const addDays = (s, n) => {
    return new Date(parse(s) + n * 86400000).toISOString().slice(0, 10);
  };
  const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / 86400000);

  function expire(date) {
    for (const b of books.values()) {
      while (b.readyFor !== null && b.readyUntil < date) {
        b.holds.shift();
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

  function loanCount(memberId) {
    let n = 0;
    for (const b of books.values()) if (b.loan && b.loan.memberId === memberId) n++;
    return n;
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return { ok: false, reason: 'exists' };
      books.set(bookId, { loan: null, holds: [], readyFor: null, readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId }) {
      if (members.has(memberId)) return { ok: false, reason: 'exists' };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false, reason: 'unknown' };
      if (m.owed >= 1000) return { ok: false, reason: 'owes' };
      if (b.loan) return { ok: false, reason: 'on loan' };
      if (b.readyFor !== null && b.readyFor !== memberId) return { ok: false, reason: 'set aside' };
      if (loanCount(memberId) >= 5) return { ok: false, reason: 'limit' };
      if (b.readyFor === memberId) {
        b.holds = b.holds.filter((x) => x !== memberId);
        b.readyFor = null;
        b.readyUntil = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false, reason: 'not on loan' };
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
    renew({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false, reason: 'not on loan' };
      if (b.loan.renewals >= 2) return { ok: false, reason: 'max renewals' };
      if (b.holds.length > 0) return { ok: false, reason: 'held' };
      if (date > b.loan.dueDate) return { ok: false, reason: 'overdue' };
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false, reason: 'unknown' };
      if (!b.loan && b.readyFor === null) return { ok: false, reason: 'free' };
      if (b.loan && b.loan.memberId === memberId) return { ok: false, reason: 'own loan' };
      if (b.holds.includes(memberId)) return { ok: false, reason: 'duplicate' };
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date }) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return { ok: false, reason: 'unknown' };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false, reason: 'bad amount' };
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date }) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: b.loan.dueDate });
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId,
            position: i + 1,
            readyUntil: b.readyFor === memberId ? b.readyUntil : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
