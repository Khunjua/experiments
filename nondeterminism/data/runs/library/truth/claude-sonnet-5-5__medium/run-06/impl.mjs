const DAY = 86400000;

function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fmt(ms) {
  const dt = new Date(ms);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return fmt(parse(s) + n * DAY);
}

function diffDays(a, b) {
  return Math.round((parse(a) - parse(b)) / DAY);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  function sync(date) {
    if (typeof date !== 'string') return;
    for (const b of books.values()) {
      while (b.readyFor !== null && date > b.readyUntil) {
        const old = b.readyUntil;
        b.holds.shift();
        if (b.holds.length > 0) {
          b.readyFor = b.holds[0];
          b.readyUntil = addDays(old, 3);
        } else {
          b.readyFor = null;
          b.readyUntil = null;
        }
      }
    }
  }

  function loanCount(memberId) {
    let n = 0;
    for (const b of books.values()) if (b.loan && b.loan.memberId === memberId) n++;
    return n;
  }

  const fail = (reason) => ({ ok: false, reason });

  return {
    addBook({ bookId } = {}) {
      if (books.has(bookId)) return fail('exists');
      books.set(bookId, { loan: null, holds: [], readyFor: null, readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (members.has(memberId)) return fail('exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (m.owed >= 1000) return fail('owes');
      if (loanCount(memberId) >= 5) return fail('limit');
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

    returnBook({ memberId, bookId, date } = {}) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      const late = diffDays(date, b.loan.dueDate);
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

    renew({ memberId, bookId, date } = {}) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (b.holds.length > 0) return fail('held');
      if (date > b.loan.dueDate) return fail('overdue');
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      sync(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && b.readyFor === null) return fail('free');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.holds.includes(memberId)) return fail('duplicate');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      sync(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('bad amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      sync(date);
      const m = members.get(memberId);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: b.loan.dueDate });
        }
        const i = b.holds.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId,
            position: i + 1,
            readyUntil: b.readyFor === memberId ? b.readyUntil : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
