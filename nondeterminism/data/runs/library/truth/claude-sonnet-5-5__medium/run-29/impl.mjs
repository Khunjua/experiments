export function createLibrary() {
  const books = new Map();
  const members = new Map();

  const toDay = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  };
  const fromDay = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const addDays = (s, n) => fromDay(toDay(s) + n);

  function advance(date) {
    for (const b of books.values()) {
      while (b.ready && date > b.ready.until) {
        b.holds.shift();
        if (b.holds.length) {
          b.ready = { memberId: b.holds[0], until: addDays(b.ready.until, 3) };
        } else {
          b.ready = null;
        }
      }
    }
  }

  const loanCount = (memberId) => {
    let c = 0;
    for (const b of books.values()) if (b.loan && b.loan.memberId === memberId) c++;
    return c;
  };

  const fail = (reason) => ({ ok: false, reason });

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return fail('exists');
      books.set(bookId, { loan: null, holds: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId }) {
      if (members.has(memberId)) return fail('exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date }) {
      advance(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (b.ready && b.ready.memberId !== memberId) return fail('set aside');
      if (m.owed >= 1000) return fail('owes');
      if (loanCount(memberId) >= 5) return fail('limit');
      if (b.ready) {
        b.holds = b.holds.filter((x) => x !== memberId);
        b.ready = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date }) {
      advance(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      const late = toDay(date) - toDay(b.loan.dueDate);
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      b.loan = null;
      if (b.holds.length) b.ready = { memberId: b.holds[0], until: addDays(date, 3) };
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date }) {
      advance(date);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (b.holds.length > 0) return fail('held');
      if (toDay(date) > toDay(b.loan.dueDate)) return fail('overdue');
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date }) {
      advance(date);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b) return fail('unknown');
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
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: b.loan.dueDate });
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId,
            position: i + 1,
            readyUntil: b.ready && b.ready.memberId === memberId ? b.ready.until : null,
          });
        }
      }
      return { loans, owed: m ? m.owed : 0, holds };
    },
  };
}
