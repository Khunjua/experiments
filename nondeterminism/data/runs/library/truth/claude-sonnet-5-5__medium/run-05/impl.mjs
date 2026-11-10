const DAY = 86400000;

function parse(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, dd] = d.split('-').map(Number);
  const t = Date.UTC(y, m - 1, dd);
  if (Number.isNaN(t)) return null;
  const x = new Date(t);
  if (x.getUTCFullYear() !== y || x.getUTCMonth() !== m - 1 || x.getUTCDate() !== dd) return null;
  return Math.round(t / DAY);
}

function fmt(n) {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  const fail = (reason) => ({ ok: false, reason });

  function expire(day) {
    for (const b of books.values()) {
      while (b.readyUntil !== null && day > b.readyUntil) {
        b.holds.shift();
        if (b.holds.length) b.readyUntil += 3;
        else b.readyUntil = null;
      }
    }
  }

  function prep(date) {
    const day = parse(date);
    if (day === null) return null;
    expire(day);
    return day;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, holds: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('onloan');
      if (m.loans.size >= 5) return fail('limit');
      if (m.owed >= 1000) return fail('owes');
      if (b.readyUntil !== null) {
        if (b.holds[0] !== memberId) return fail('reserved');
        b.holds.shift();
        b.readyUntil = null;
      }
      const due = day + 21;
      b.loan = { memberId, due, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate: fmt(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('notloaned');
      const late = day - b.loan.due;
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.holds.length) b.readyUntil = day + 3;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('notloaned');
      if (b.loan.renewals >= 2) return fail('maxrenew');
      if (b.holds.length) return fail('held');
      if (day > b.loan.due) return fail('overdue');
      b.loan.due += 21;
      b.loan.renewals++;
      return { ok: true, dueDate: fmt(b.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && b.readyUntil === null) return fail('free');
      if (b.loan && b.loan.memberId === memberId) return fail('ownloan');
      if (b.holds.includes(memberId)) return fail('dup');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('date');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      prep(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      for (const bookId of m.loans) {
        loans.push({ bookId, dueDate: fmt(books.get(bookId).loan.due) });
      }
      const holds = [];
      for (const [bookId, b] of books) {
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId,
            position: i + 1,
            readyUntil: i === 0 && b.readyUntil !== null ? fmt(b.readyUntil) : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
