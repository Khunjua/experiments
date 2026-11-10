export function createLibrary() {
  const books = new Map();
  const members = new Map();

  const toDay = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  };
  const toStr = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

  function advance(date) {
    const today = toDay(date);
    for (const b of books.values()) {
      while (b.ready && today > b.ready.until) {
        b.holds.shift();
        if (b.holds.length) {
          b.ready = { memberId: b.holds[0], until: b.ready.until + 3 };
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
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },
    borrow({ memberId, bookId, date }) {
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (m.loans.size >= 5) return fail('limit');
      if (m.owed >= 1000) return fail('owes');
      if (b.ready) {
        if (b.ready.memberId !== memberId) return fail('reserved');
        b.holds.shift();
        b.ready = null;
      }
      const due = toDay(date) + 21;
      b.loan = { memberId, due, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate: toStr(due) };
    },
    returnBook({ memberId, bookId, date }) {
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      const today = toDay(date);
      const late = today - b.loan.due;
      let fine = 0;
      if (late >= 3) fine = Math.min(500, 25 * late);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.holds.length) {
        b.ready = { memberId: b.holds[0], until: today + 3 };
      }
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date }) {
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (b.holds.length > 0) return fail('held');
      if (toDay(date) > b.loan.due) return fail('overdue');
      b.loan.due += 21;
      b.loan.renewals++;
      return { ok: true, dueDate: toStr(b.loan.due) };
    },
    placeHold({ memberId, bookId, date }) {
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.ready) return fail('on shelf');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.holds.includes(memberId)) return fail('duplicate');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date }) {
      advance(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('bad amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date }) {
      advance(date);
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
            readyUntil: b.ready && b.ready.memberId === memberId ? toStr(b.ready.until) : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
