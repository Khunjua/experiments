const DAY = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(dt.getTime() / DAY);
}

function fmt(n) {
  const dt = new Date(n * DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const validId = (x) => typeof x === 'string' && x.length > 0;
const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;
  let seq = 0;

  function expire(date) {
    for (const b of books.values()) {
      while (b.loan === null && b.queue.length > 0 && date > b.readyUntil) {
        b.queue.shift();
        if (b.queue.length > 0) b.readyUntil = b.readyUntil + 8;
        else b.readyUntil = null;
      }
    }
  }

  // returns {date} or null on failure; sets clock and expires
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    const d = parseDate(args.date);
    if (d === null) return null;
    if (current !== null && d < current) return null;
    current = d;
    expire(d);
    return d;
  }

  function activeHoldCount(memberId) {
    let n = 0;
    for (const b of books.values()) if (b.queue.some((h) => h.memberId === memberId)) n++;
    return n;
  }

  return {
    addBook(a) {
      if (!a || typeof a !== 'object' || !validId(a.bookId)) return FAIL('invalid');
      if (books.has(a.bookId)) return FAIL('exists');
      books.set(a.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(a) {
      if (!a || typeof a !== 'object' || !validId(a.memberId)) return FAIL('invalid');
      if (members.has(a.memberId)) return FAIL('exists');
      members.set(a.memberId, { loans: [], owed: 0 });
      return { ok: true };
    },
    borrow(a) {
      const date = begin(a);
      if (date === null) return FAIL('invalid');
      if (!validId(a.memberId) || !validId(a.bookId)) return FAIL('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.loan) return FAIL('on loan');
      if (b.queue.length > 0 && b.queue[0].memberId !== a.memberId) return FAIL('set aside');
      if (m.loans.length >= 5) return FAIL('limit');
      if (m.owed >= 1000) return FAIL('owed');
      for (const id of m.loans) if (books.get(id).loan.dueDate < date) return FAIL('overdue');
      if (b.queue.length > 0) { b.queue.shift(); b.readyUntil = null; }
      b.loan = { memberId: a.memberId, dueDate: date + 21, renewals: 0 };
      m.loans.push(a.bookId);
      return { ok: true, dueDate: fmt(date + 21) };
    },
    returnBook(a) {
      const date = begin(a);
      if (date === null) return FAIL('invalid');
      if (!validId(a.memberId) || !validId(a.bookId)) return FAIL('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan || b.loan.memberId !== a.memberId) return FAIL('not loaned');
      const late = Math.max(0, date - b.loan.dueDate);
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      b.loan = null;
      m.loans.splice(m.loans.indexOf(a.bookId), 1);
      b.readyUntil = b.queue.length > 0 ? date + 7 : null;
      return { ok: true, fine };
    },
    renew(a) {
      const date = begin(a);
      if (date === null) return FAIL('invalid');
      if (!validId(a.memberId) || !validId(a.bookId)) return FAIL('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan || b.loan.memberId !== a.memberId) return FAIL('not loaned');
      if (b.loan.renewals >= 2) return FAIL('max renewals');
      if (date > b.loan.dueDate) return FAIL('overdue');
      if (b.queue.length > 0) return FAIL('holds');
      b.loan.dueDate = date + 21;
      b.loan.renewals++;
      return { ok: true, dueDate: fmt(b.loan.dueDate) };
    },
    placeHold(a) {
      const date = begin(a);
      if (date === null) return FAIL('invalid');
      if (!validId(a.memberId) || !validId(a.bookId)) return FAIL('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan && b.queue.length === 0) return FAIL('available');
      if (b.loan && b.loan.memberId === a.memberId) return FAIL('own loan');
      if (b.queue.some((h) => h.memberId === a.memberId)) return FAIL('duplicate');
      if (activeHoldCount(a.memberId) >= 5) return FAIL('limit');
      b.queue.push({ memberId: a.memberId, seq: seq++ });
      return { ok: true, position: b.queue.length };
    },
    payFine(a) {
      const date = begin(a);
      if (date === null) return FAIL('invalid');
      if (!validId(a.memberId)) return FAIL('invalid');
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return FAIL('amount');
      const m = members.get(a.memberId);
      if (!m) return FAIL('unknown');
      if (a.amount > m.owed) return FAIL('overpay');
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },
    getMember(a) {
      const date = begin(a);
      if (date === null) return FAIL('invalid');
      if (!validId(a.memberId)) return FAIL('invalid');
      const m = members.get(a.memberId);
      if (!m) return FAIL('unknown');
      const loans = m.loans.map((id) => ({ bookId: id, dueDate: fmt(books.get(id).loan.dueDate) }));
      const hs = [];
      for (const [id, b] of books) {
        const i = b.queue.findIndex((h) => h.memberId === a.memberId);
        if (i >= 0) {
          hs.push({
            seq: b.queue[i].seq,
            h: {
              bookId: id,
              position: i + 1,
              readyUntil: i === 0 && !b.loan && b.readyUntil !== null ? fmt(b.readyUntil) : null,
            },
          });
        }
      }
      hs.sort((x, y) => x.seq - y.seq);
      return { ok: true, loans, owed: m.owed, holds: hs.map((x) => x.h) };
    },
  };
}
