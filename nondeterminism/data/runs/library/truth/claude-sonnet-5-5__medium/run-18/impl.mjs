const DAY = 86400000;

function parse(d) {
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, dd);
}
function fmt(t) {
  return new Date(t).toISOString().slice(0, 10);
}
function addDays(d, n) {
  return fmt(parse(d) + n * DAY);
}
function diffDays(a, b) {
  return Math.round((parse(a) - parse(b)) / DAY);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  function expire(date) {
    for (const b of books.values()) {
      while (b.ready && date > b.ready.until) {
        const old = b.ready.until;
        b.holds.shift();
        if (b.holds.length > 0) {
          b.ready = { memberId: b.holds[0], until: addDays(old, 3) };
        } else {
          b.ready = null;
        }
      }
    }
  }

  const no = (reason) => ({ ok: false, reason });

  return {
    addBook({ bookId }) {
      if (books.has(bookId)) return no('exists');
      books.set(bookId, { loan: null, holds: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId }) {
      if (members.has(memberId)) return no('exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return no('unknown');
      if (b.loan) return no('on loan');
      if (b.ready && b.ready.memberId !== memberId) return no('set aside');
      if (m.owed >= 1000) return no('owes');
      let count = 0;
      for (const bk of books.values()) if (bk.loan && bk.loan.memberId === memberId) count++;
      if (count >= 5) return no('limit');
      if (b.ready && b.ready.memberId === memberId) {
        b.holds = b.holds.filter((x) => x !== memberId);
        b.ready = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return no('not on loan');
      const late = diffDays(date, b.loan.dueDate);
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      b.loan = null;
      if (b.holds.length > 0) {
        b.ready = { memberId: b.holds[0], until: addDays(date, 3) };
      }
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return no('not on loan');
      if (b.loan.renewals >= 2) return no('max renewals');
      if (b.holds.length > 0) return no('held');
      if (date > b.loan.dueDate) return no('overdue');
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date }) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return no('unknown');
      if (!b.loan && !b.ready) return no('on shelf');
      if (b.loan && b.loan.memberId === memberId) return no('own loan');
      if (b.holds.includes(memberId)) return no('duplicate');
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date }) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return no('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return no('bad amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date }) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return no('unknown');
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
            readyUntil: b.ready && b.ready.memberId === memberId ? b.ready.until : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
