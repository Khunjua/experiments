export function createLibrary() {
  const books = new Map();
  const members = new Map();

  const toMs = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const addDays = (s, n) => {
    const t = new Date(toMs(s) + n * 86400000);
    const p = (x, l) => String(x).padStart(l, '0');
    return `${p(t.getUTCFullYear(), 4)}-${p(t.getUTCMonth() + 1, 2)}-${p(t.getUTCDate(), 2)}`;
  };
  const diffDays = (a, b) => Math.round((toMs(a) - toMs(b)) / 86400000);
  const fail = (reason) => ({ ok: false, reason });

  function expire(date) {
    for (const b of books.values()) {
      while (b.ready && b.readyUntil < date) {
        b.holds.shift();
        if (b.holds.length) {
          b.readyUntil = addDays(b.readyUntil, 3);
        } else {
          b.ready = false;
          b.readyUntil = null;
        }
      }
    }
  }

  const loanCount = (memberId) => {
    let n = 0;
    for (const b of books.values()) if (b.loan && b.loan.memberId === memberId) n++;
    return n;
  };

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return fail('exists');
      books.set(bookId, { loan: null, holds: [], ready: false, readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId }) {
      if (members.has(memberId)) return fail('exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date }) {
      expire(date);
      const b = books.get(bookId);
      const m = members.get(memberId);
      if (!b || !m) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (m.owed >= 1000) return fail('owes');
      if (loanCount(memberId) >= 5) return fail('limit');
      if (b.ready) {
        if (b.holds[0] !== memberId) return fail('set aside');
        b.holds.shift();
        b.ready = false;
        b.readyUntil = null;
      } else if (b.holds.length) {
        return fail('holds');
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date }) {
      expire(date);
      const b = books.get(bookId);
      const m = members.get(memberId);
      if (!b || !m || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      const late = diffDays(date, b.loan.dueDate);
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      b.loan = null;
      if (b.holds.length) {
        b.ready = true;
        b.readyUntil = addDays(date, 3);
      }
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date }) {
      expire(date);
      const b = books.get(bookId);
      if (!b || !members.has(memberId) || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (b.holds.length) return fail('holds');
      if (date > b.loan.dueDate) return fail('overdue');
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date }) {
      expire(date);
      const b = books.get(bookId);
      if (!b || !members.has(memberId)) return fail('unknown');
      if (!b.loan && !b.ready) return fail('free');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.holds.includes(memberId)) return fail('duplicate');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date }) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date }) {
      expire(date);
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
            readyUntil: i === 0 && b.ready ? b.readyUntil : null,
          });
        }
      }
      return { loans, owed: m ? m.owed : 0, holds };
    },
  };
}
