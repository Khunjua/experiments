const DAY = 86400000;

function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function fmt(t) {
  const d = new Date(t);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function addDays(s, n) {
  return fmt(parse(s) + n * DAY);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  function expire(date) {
    if (typeof date !== 'string') return;
    for (const b of books.values()) {
      while (b.ready && b.readyUntil < date) {
        b.holds.shift();
        if (b.holds.length > 0) {
          b.readyUntil = addDays(b.readyUntil, 3);
        } else {
          b.ready = false;
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

  return {
    addBook({ bookId } = {}) {
      if (books.has(bookId)) return { ok: false, reason: 'exists' };
      books.set(bookId, { loan: null, holds: [], ready: false, readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (members.has(memberId)) return { ok: false, reason: 'exists' };
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false, reason: 'unknown' };
      if (b.loan) return { ok: false, reason: 'on loan' };
      if (m.owed >= 1000) return { ok: false, reason: 'owes' };
      if (loanCount(memberId) >= 5) return { ok: false, reason: 'limit' };
      if (b.ready) {
        if (b.holds[0] !== memberId) return { ok: false, reason: 'set aside' };
        b.holds.shift();
        b.ready = false;
        b.readyUntil = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      return { ok: true, dueDate };
    },
    returnBook({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false, reason: 'not on loan' };
      }
      const late = Math.round((parse(date) - parse(b.loan.dueDate)) / DAY);
      let fine = 0;
      if (late >= 3) fine = Math.min(500, late * 25);
      m.owed += fine;
      b.loan = null;
      if (b.holds.length > 0) {
        b.ready = true;
        b.readyUntil = addDays(date, 3);
      }
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) {
        return { ok: false, reason: 'not on loan' };
      }
      if (b.loan.renewals >= 2) return { ok: false, reason: 'max renewals' };
      if (b.holds.length > 0) return { ok: false, reason: 'holds' };
      if (date > b.loan.dueDate) return { ok: false, reason: 'overdue' };
      b.loan.dueDate = addDays(b.loan.dueDate, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false, reason: 'unknown' };
      if (!b.loan && !b.ready) return { ok: false, reason: 'free' };
      if (b.loan && b.loan.memberId === memberId) return { ok: false, reason: 'own loan' };
      if (b.holds.includes(memberId)) return { ok: false, reason: 'duplicate' };
      b.holds.push(memberId);
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      expire(date);
      const m = members.get(memberId);
      if (!m) return { ok: false, reason: 'unknown' };
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) {
        return { ok: false, reason: 'bad amount' };
      }
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      expire(date);
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
            readyUntil: b.ready && i === 0 ? b.readyUntil : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
