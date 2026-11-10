const DAY = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const HOLD_DAYS = 7;

function parse(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  const d = Math.round(t / DAY);
  return fmt(d) === s ? d : null;
}
function fmt(d) {
  return new Date(d * DAY).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  const fail = (reason) => ({ ok: false, reason });

  function advance(d) {
    for (const b of books.values()) {
      while (b.holds.length && b.holds[0].ready !== null && b.holds[0].ready < d) {
        const expired = b.holds.shift().ready;
        if (b.holds.length) b.holds[0].ready = expired + 1 + HOLD_DAYS;
      }
    }
  }

  function start(date) {
    const d = parse(date);
    if (d === null) return null;
    advance(d);
    return d;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, holds: [] });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const d = start(date);
      if (d === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (m.owed > 0) return fail('owes');
      if (b.holds.length) {
        const h = b.holds[0];
        if (h.memberId !== memberId || h.ready === null) return fail('reserved');
        b.holds.shift();
        if (b.holds.length) {
          // should not normally happen; keep next waiting without ready date until return
          b.holds[0].ready = null;
        }
      }
      b.loan = { memberId, due: d + LOAN_DAYS, renewals: 0 };
      return { ok: true, dueDate: fmt(b.loan.due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const d = start(date);
      if (d === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('no loan');
      const late = Math.max(0, d - b.loan.due);
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      b.loan = null;
      if (b.holds.length) b.holds[0].ready = d + HOLD_DAYS;
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const d = start(date);
      if (d === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('no loan');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (d > b.loan.due) return fail('overdue');
      if (b.holds.length) return fail('held');
      b.loan.renewals++;
      b.loan.due = d + LOAN_DAYS;
      return { ok: true, dueDate: fmt(b.loan.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const d = start(date);
      if (d === null) return fail('date');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.holds.length) return fail('available');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.holds.some((h) => h.memberId === memberId)) return fail('duplicate');
      b.holds.push({ memberId, ready: null });
      return { ok: true, position: b.holds.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const d = start(date);
      if (d === null) return fail('date');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      start(date);
      const m = members.get(memberId);
      const loans = [], holds = [];
      if (!m) return { loans, owed: 0, holds };
      for (const [bookId, b] of books) {
        if (b.loan && b.loan.memberId === memberId) loans.push({ bookId, dueDate: fmt(b.loan.due) });
        const i = b.holds.findIndex((h) => h.memberId === memberId);
        if (i >= 0) {
          const r = b.holds[i].ready;
          holds.push({ bookId, position: i + 1, readyUntil: r === null ? null : fmt(r) });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
