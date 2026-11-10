const DAY = 86400000;
const parse = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  return Number.isNaN(t) ? null : t;
};
const fmt = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (s, n) => fmt(parse(s) + n * DAY);

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  const fail = (reason) => ({ ok: false, reason });

  function advance(date) {
    for (const b of books.values()) {
      while (b.ready && date > b.ready.until) {
        const old = b.ready;
        b.holds = b.holds.filter((m) => m !== old.memberId);
        b.ready = b.holds.length
          ? { memberId: b.holds[0], until: addDays(old.until, 3) }
          : null;
      }
    }
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('bad');
      books.set(bookId, { loan: null, holds: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('bad');
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (m.loans.size >= 5) return fail('limit');
      if (m.owed >= 1000) return fail('owed');
      if (b.loan) return fail('onloan');
      if (b.ready) {
        if (b.ready.memberId !== memberId) return fail('reserved');
        b.holds = b.holds.filter((x) => x !== memberId);
        b.ready = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      const late = Math.round((parse(date) - parse(b.loan.dueDate)) / DAY);
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.holds.length) b.ready = { memberId: b.holds[0], until: addDays(date, 3) };
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('noloan');
      if (b.loan.renewals >= 2) return fail('max');
      if (b.holds.length) return fail('held');
      if (date > b.loan.dueDate) return fail('overdue');
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.ready) return fail('free');
      if (b.loan && b.loan.memberId === memberId) return fail('own');
      if (b.holds.includes(memberId)) return fail('dup');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (parse(date) === null) return fail('date');
      advance(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      if (parse(date) === null) return fail('date');
      advance(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      const loans = [], holds = [];
      for (const [id, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId: id, dueDate: b.loan.dueDate });
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId: id,
            position: i + 1,
            readyUntil: b.ready && b.ready.memberId === memberId ? b.ready.until : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
