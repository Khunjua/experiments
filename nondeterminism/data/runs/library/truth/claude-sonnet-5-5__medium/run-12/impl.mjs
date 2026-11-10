export function createLibrary() {
  const books = new Map();
  const members = new Map();

  const DAY = 86400000;
  const toMs = (s) => Date.parse(s + 'T00:00:00Z');
  const addDays = (s, n) => new Date(toMs(s) + n * DAY).toISOString().slice(0, 10);
  const diffDays = (a, b) => Math.round((toMs(a) - toMs(b)) / DAY);

  function expire(date) {
    for (const b of books.values()) {
      while (b.ready && b.ready < date) {
        b.holds.shift();
        if (b.holds.length > 0) {
          b.ready = addDays(b.ready, 3);
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
      books.set(bookId, { borrower: null, due: null, renewals: 0, holds: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (members.has(memberId)) return fail('exists');
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.borrower !== null) return fail('on loan');
      if (m.loans.size >= 5) return fail('limit');
      if (m.owed >= 1000) return fail('owes');
      if (b.ready) {
        if (b.holds[0] !== memberId) return fail('set aside');
        b.holds.shift();
        b.ready = null;
      }
      b.borrower = memberId;
      b.due = addDays(date, 21);
      b.renewals = 0;
      m.loans.add(bookId);
      return { ok: true, dueDate: b.due };
    },
    returnBook({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || b.borrower !== memberId) return fail('not on loan');
      const late = diffDays(date, b.due);
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      m.loans.delete(bookId);
      b.borrower = null;
      b.due = null;
      b.renewals = 0;
      if (b.holds.length > 0) b.ready = addDays(date, 3);
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || b.borrower !== memberId) return fail('not on loan');
      if (b.renewals >= 2) return fail('max renewals');
      if (b.holds.length > 0) return fail('held');
      if (date > b.due) return fail('overdue');
      b.due = addDays(b.due, 21);
      b.renewals++;
      return { ok: true, dueDate: b.due };
    },
    placeHold({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.borrower === null && !b.ready) return fail('free');
      if (b.borrower === memberId) return fail('own loan');
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
      for (const id of m.loans) loans.push({ bookId: id, dueDate: books.get(id).due });
      const holds = [];
      for (const [id, b] of books) {
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({ bookId: id, position: i + 1, readyUntil: i === 0 && b.ready ? b.ready : null });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
