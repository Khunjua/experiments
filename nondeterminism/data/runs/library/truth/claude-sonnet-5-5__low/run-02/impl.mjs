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
    for (const b of books.values()) {
      while (b.readyFor !== null && date > b.readyUntil) {
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

  const fail = (reason) => ({ ok: false, reason });

  function loansOf(memberId) {
    const out = [];
    for (const [bookId, b] of books) {
      if (b.loan && b.loan.memberId === memberId) out.push({ bookId, b });
    }
    return out;
  }

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return fail('exists');
      books.set(bookId, { loan: null, holds: [], readyFor: null, readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId }) {
      if (members.has(memberId)) return fail('exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (m.owed >= 1000) return fail('owes');
      if (b.loan) return fail('on loan');
      if (loansOf(memberId).length >= 5) return fail('limit');
      if (b.readyFor !== null) {
        if (b.readyFor !== memberId) return fail('set aside');
        b.holds.shift();
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
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not loaned');
      const late = toDays(date) - toDays(b.loan.dueDate);
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
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not loaned');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (b.holds.length > 0) return fail('held');
      if (toDays(date) > toDays(b.loan.dueDate)) return fail('overdue');
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date }) {
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
      const loans = loansOf(memberId).map(({ bookId, b }) => ({ bookId, dueDate: b.loan.dueDate }));
      const holds = [];
      for (const [bookId, b] of books) {
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId,
            position: i + 1,
            readyUntil: b.readyFor === memberId ? b.readyUntil : null,
          });
        }
      }
      return { loans, owed: m ? m.owed : 0, holds };
    },
  };
}
