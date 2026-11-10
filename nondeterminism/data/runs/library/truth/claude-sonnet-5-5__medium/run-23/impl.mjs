export function createLibrary() {
  const books = new Map();
  const members = new Map();

  const toDays = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  };
  const fromDays = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const addDays = (s, n) => fromDays(toDays(s) + n);

  function expire(date) {
    if (typeof date !== 'string') return;
    for (const b of books.values()) {
      while (b.ready && b.ready.until < date) {
        const oldUntil = b.ready.until;
        b.holds.shift();
        if (b.holds.length > 0) {
          b.ready = { memberId: b.holds[0], until: addDays(oldUntil, 3) };
        } else {
          b.ready = null;
        }
      }
    }
  }

  const fail = (reason) => ({ ok: false, reason });

  return {
    addBook({ bookId } = {}) {
      if (books.has(bookId)) return fail('exists');
      books.set(bookId, { loan: null, holds: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (members.has(memberId)) return fail('exists');
      members.set(memberId, { owed: 0, loans: new Map() });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('onloan');
      if (m.loans.size >= 5) return fail('limit');
      if (m.owed >= 1000) return fail('owes');
      if (b.ready && b.ready.memberId !== memberId) return fail('reserved');
      if (b.ready) {
        b.holds = b.holds.filter((x) => x !== memberId);
        b.ready = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.set(bookId, b.loan);
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      const late = toDays(date) - toDays(b.loan.dueDate);
      let fine = 0;
      if (late >= 3) fine = Math.min(500, 25 * late);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.holds.length > 0) {
        b.ready = { memberId: b.holds[0], until: addDays(date, 3) };
      }
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      if (b.loan.renewals >= 2) return fail('maxrenew');
      if (b.holds.length > 0) return fail('held');
      if (toDays(date) > toDays(b.loan.dueDate)) return fail('overdue');
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.ready) return fail('free');
      if (b.loan && b.loan.memberId === memberId) return fail('ownloan');
      if (b.holds.includes(memberId)) return fail('duplicate');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      for (const [bookId, l] of m.loans) loans.push({ bookId, dueDate: l.dueDate });
      const holds = [];
      for (const [bookId, b] of books) {
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId,
            position: i + 1,
            readyUntil: b.ready && b.ready.memberId === memberId ? b.ready.until : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
