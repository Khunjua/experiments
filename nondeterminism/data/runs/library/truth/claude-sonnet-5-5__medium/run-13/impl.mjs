const DAY = 86400000;

function toDays(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY);
}

function fromDays(n) {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDays(toDays(s) + n);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  function advance(date) {
    if (typeof date !== 'string') return;
    for (const b of books.values()) {
      while (b.ready && date > b.ready.until) {
        const oldUntil = b.ready.until;
        b.holds.shift();
        if (b.holds.length > 0) {
          b.ready = { memberId: b.holds[0], until: addDays(oldUntil, 3) };
        } else {
          b.ready = null;
        }
      }
    }
  }

  const fail = (reason) => ({ ok: false, reason });

  function validDate(d) {
    return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('bad book');
      books.set(bookId, { loan: null, holds: [], ready: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('bad member');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      advance(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (m.owed >= 1000) return fail('owes');
      if (b.loan) return fail('on loan');
      let count = 0;
      for (const bk of books.values()) if (bk.loan && bk.loan.memberId === memberId) count++;
      if (count >= 5) return fail('limit');
      if (b.ready) {
        if (b.ready.memberId !== memberId) return fail('set aside');
        b.holds.shift();
        b.ready = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },

    returnBook({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      advance(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      const late = toDays(date) - toDays(b.loan.dueDate);
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      b.loan = null;
      if (b.holds.length > 0) {
        b.ready = { memberId: b.holds[0], until: addDays(date, 3) };
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      advance(date);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b || !b.loan || b.loan.memberId !== memberId) return fail('not on loan');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (b.holds.length > 0) return fail('held');
      if (date > b.loan.dueDate) return fail('overdue');
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold({ memberId, bookId, date } = {}) {
      if (!validDate(date)) return fail('date');
      advance(date);
      const b = books.get(bookId);
      if (!members.has(memberId) || !b) return fail('unknown');
      if (!b.loan && !b.ready) return fail('on shelf');
      if (b.loan && b.loan.memberId === memberId) return fail('has loan');
      if (b.holds.includes(memberId)) return fail('duplicate');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      if (validDate(date)) advance(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      if (validDate(date)) advance(date);
      const m = members.get(memberId);
      if (!m) return { ok: false, loans: [], owed: 0, holds: [] };
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
      return { loans, owed: m.owed, holds };
    },
  };
}
