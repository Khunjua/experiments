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

  function expire(date) {
    for (const b of books.values()) {
      while (b.ready && b.ready.until < date) {
        b.holds.shift();
        if (b.holds.length > 0) {
          b.ready = { memberId: b.holds[0], until: addDays(b.ready.until, 3) };
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
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (m.loans.size >= 5) return fail('limit');
      if (m.owed >= 1000) return fail('owes');
      if (b.ready) {
        if (b.ready.memberId !== memberId) return fail('set aside');
        b.holds.shift();
        b.ready = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      const late = toDays(date) - toDays(b.loan.dueDate);
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
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
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (b.holds.length > 0) return fail('held');
      if (toDays(date) > toDays(b.loan.dueDate)) return fail('overdue');
      b.loan.renewals++;
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.ready) return fail('on shelf');
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
      if (!m) return fail('unknown');
      const loans = [];
      for (const id of m.loans) loans.push({ bookId: id, dueDate: books.get(id).loan.dueDate });
      const holds = [];
      for (const [id, b] of books) {
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId: id,
            position: i + 1,
            readyUntil: b.ready && b.ready.memberId === memberId ? b.ready.until : null,
          });
        }
      }
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
