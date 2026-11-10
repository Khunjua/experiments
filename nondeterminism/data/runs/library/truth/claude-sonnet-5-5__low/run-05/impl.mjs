export function createLibrary() {
  const books = new Map();
  const members = new Map();

  const toDay = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };
  const toStr = (n) => new Date(n * 86400000).toISOString().slice(0, 10);

  function expire(day) {
    for (const b of books.values()) {
      while (b.ready && day > b.ready.until) {
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

  function loanCount(memberId) {
    let n = 0;
    for (const b of books.values()) if (b.loan && b.loan.memberId === memberId) n++;
    return n;
  }

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
      const day = toDay(date);
      expire(day);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (m.owed >= 1000) return fail('owes');
      if (loanCount(memberId) >= 5) return fail('limit');
      if (b.ready) {
        if (b.ready.memberId !== memberId) return fail('reserved');
        b.holds.shift();
        b.ready = null;
      }
      b.loan = { memberId, due: day + 21, renewals: 0 };
      return { ok: true, dueDate: toStr(day + 21) };
    },
    returnBook({ memberId, bookId, date }) {
      const day = toDay(date);
      expire(day);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      const late = day - b.loan.due;
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      members.get(memberId).owed += fine;
      b.loan = null;
      if (b.holds.length) b.ready = { memberId: b.holds[0], until: day + 3 };
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date }) {
      const day = toDay(date);
      expire(day);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (b.holds.length) return fail('held');
      if (day > b.loan.due) return fail('overdue');
      b.loan.due += 21;
      b.loan.renewals++;
      return { ok: true, dueDate: toStr(b.loan.due) };
    },
    placeHold({ memberId, bookId, date }) {
      const day = toDay(date);
      expire(day);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b) return fail('unknown');
      if (!b.loan && !b.ready) return fail('free');
      if (b.loan && b.loan.memberId === memberId) return fail('has loan');
      if (b.holds.includes(memberId)) return fail('duplicate');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date }) {
      expire(toDay(date));
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('bad amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date }) {
      expire(toDay(date));
      const m = members.get(memberId);
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: toStr(b.loan.due) });
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId,
            position: i + 1,
            readyUntil: b.ready && b.ready.memberId === memberId ? toStr(b.ready.until) : null,
          });
        }
      }
      return { loans, owed: m ? m.owed : 0, holds };
    },
  };
}
