const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const FINE_CAP = 1000;
const PICKUP_DAYS = 3;
const MAX_LOANS = 5;
const BLOCK_OWED = 500;

function toDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return t / 86400000;
}
function fmt(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals, seq}|null, queue: [{memberId, readyUntil}] }
  const members = new Map(); // memberId -> { owed }
  let seq = 0;
  const fail = (reason) => ({ ok: false, reason });

  function sync(day) {
    for (const b of books.values()) {
      while (!b.loan && b.queue.length && b.queue[0].readyUntil !== null && day > b.queue[0].readyUntil) {
        const prev = b.queue.shift().readyUntil;
        if (b.queue.length) b.queue[0].readyUntil = prev + PICKUP_DAYS;
      }
    }
  }
  function loansOf(memberId) {
    const out = [];
    for (const [bookId, b] of books) if (b.loan && b.loan.memberId === memberId) out.push({ bookId, loan: b.loan });
    return out.sort((a, b) => a.loan.seq - b.loan.seq);
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('bad book');
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('bad member');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      const day = toDay(date);
      if (day === null) return fail('date');
      sync(day);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (m.owed >= BLOCK_OWED) return fail('owes too much');
      const mine = loansOf(memberId);
      if (mine.length >= MAX_LOANS) return fail('limit');
      if (mine.some((l) => l.loan.due < day)) return fail('overdue loan');
      if (b.queue.length) {
        if (b.queue[0].memberId !== memberId) return fail('set aside for other');
        b.queue.shift();
        if (b.queue.length) b.queue[0].readyUntil = null;
      }
      const due = day + LOAN_DAYS;
      b.loan = { memberId, due, renewals: 0, seq: seq++ };
      return { ok: true, dueDate: fmt(due) };
    },
    returnBook({ memberId, bookId, date } = {}) {
      const day = toDay(date);
      if (day === null) return fail('date');
      sync(day);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('no loan');
      const late = day - b.loan.due;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(FINE_CAP, (late - GRACE_DAYS) * FINE_PER_DAY);
      m.owed += fine;
      b.loan = null;
      if (b.queue.length) b.queue[0].readyUntil = day + PICKUP_DAYS;
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      const day = toDay(date);
      if (day === null) return fail('date');
      sync(day);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail('no loan');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('max renewals');
      if (day > b.loan.due) return fail('overdue');
      if (b.queue.length) return fail('holds waiting');
      if (m.owed >= BLOCK_OWED) return fail('owes too much');
      b.loan.renewals++;
      b.loan.due = day + LOAN_DAYS;
      return { ok: true, dueDate: fmt(b.loan.due) };
    },
    placeHold({ memberId, bookId, date } = {}) {
      const day = toDay(date);
      if (day === null) return fail('date');
      sync(day);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.queue.length) return fail('available');
      if (b.loan && b.loan.memberId === memberId) return fail('already have it');
      if (b.queue.some((h) => h.memberId === memberId)) return fail('already held');
      b.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      const day = toDay(date);
      if (day === null) return fail('date');
      sync(day);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('bad amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      const day = toDay(date);
      const m = members.get(memberId);
      if (day !== null) sync(day);
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = loansOf(memberId).map((l) => ({ bookId: l.bookId, dueDate: fmt(l.loan.due) }));
      const holds = [];
      for (const [bookId, b] of books) {
        const i = b.queue.findIndex((h) => h.memberId === memberId);
        if (i >= 0) {
          const r = b.queue[i].readyUntil;
          holds.push({ bookId, position: i + 1, readyUntil: r === null ? null : fmt(r) });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
