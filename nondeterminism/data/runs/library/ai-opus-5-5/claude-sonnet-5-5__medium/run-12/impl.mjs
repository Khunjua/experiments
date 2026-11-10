const ID = (x) => typeof x === 'string' && x.length > 0;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime();
}
const DAY = 86400000;
function fmt(t) {
  const dt = new Date(t);
  const p = (n, w) => String(n).padStart(w, '0');
  return p(dt.getUTCFullYear(), 4) + '-' + p(dt.getUTCMonth() + 1, 2) + '-' + p(dt.getUTCDate(), 2);
}
function addDays(s, n) { return fmt(parseDate(s) + n * DAY); }
function diffDays(a, b) { return Math.round((parseDate(a) - parseDate(b)) / DAY); }

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;
  let seq = 0;
  const FAIL = (reason) => ({ ok: false, reason });

  function expire(date) {
    for (const b of books.values()) {
      while (b.readyUntil !== null && date > b.readyUntil) {
        b.queue.shift();
        if (b.queue.length > 0) b.readyUntil = addDays(b.readyUntil, 8);
        else b.readyUntil = null;
      }
    }
  }

  // Common prologue for dated calls. Returns null if ok, else a failure.
  function enter(args, needBook) {
    if (args === null || typeof args !== 'object') return { f: FAIL('args') };
    if (parseDate(args.date) === null) return { f: FAIL('date') };
    if (current !== null && args.date < current) return { f: FAIL('past') };
    current = args.date;
    expire(args.date);
    if (!ID(args.memberId)) return { f: FAIL('member') };
    const m = members.get(args.memberId);
    if (!m) return { f: FAIL('member') };
    let b = null;
    if (needBook) {
      if (!ID(args.bookId)) return { f: FAIL('book') };
      b = books.get(args.bookId);
      if (!b) return { f: FAIL('book') };
    }
    return { m, b };
  }

  function activeHoldCount(memberId) {
    let n = 0;
    for (const b of books.values()) for (const h of b.queue) if (h.memberId === memberId) n++;
    return n;
  }

  return {
    addBook(a) {
      if (!a || !ID(a.bookId) || books.has(a.bookId)) return FAIL('invalid');
      books.set(a.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(a) {
      if (!a || !ID(a.memberId) || members.has(a.memberId)) return FAIL('invalid');
      members.set(a.memberId, { owed: 0, loans: [] });
      return { ok: true };
    },
    borrow(a) {
      const r = enter(a, true);
      if (r.f) return r.f;
      const { m, b } = r;
      if (b.loan) return FAIL('on loan');
      if (b.readyUntil !== null && b.queue[0].memberId !== a.memberId) return FAIL('set aside');
      if (m.loans.length >= 5) return FAIL('limit');
      for (const id of m.loans) if (books.get(id).loan.dueDate < a.date) return FAIL('overdue');
      if (m.owed >= 1000) return FAIL('owed');
      if (b.readyUntil !== null) { b.queue.shift(); b.readyUntil = null; }
      const dueDate = addDays(a.date, 21);
      b.loan = { memberId: a.memberId, dueDate, renewals: 0 };
      m.loans.push(a.bookId);
      return { ok: true, dueDate };
    },
    returnBook(a) {
      const r = enter(a, true);
      if (r.f) return r.f;
      const { m, b } = r;
      if (!b.loan || b.loan.memberId !== a.memberId) return FAIL('not loaned');
      const late = Math.max(0, diffDays(a.date, b.loan.dueDate));
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      m.loans.splice(m.loans.indexOf(a.bookId), 1);
      b.loan = null;
      b.readyUntil = b.queue.length > 0 ? addDays(a.date, 7) : null;
      return { ok: true, fine };
    },
    renew(a) {
      const r = enter(a, true);
      if (r.f) return r.f;
      const { b } = r;
      if (!b.loan || b.loan.memberId !== a.memberId) return FAIL('not loaned');
      if (b.loan.renewals >= 2) return FAIL('max renewals');
      if (a.date > b.loan.dueDate) return FAIL('overdue');
      if (b.queue.length > 0) return FAIL('holds');
      b.loan.dueDate = addDays(a.date, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold(a) {
      const r = enter(a, true);
      if (r.f) return r.f;
      const { b } = r;
      if (!b.loan && b.readyUntil === null) return FAIL('available');
      if (b.loan && b.loan.memberId === a.memberId) return FAIL('own loan');
      if (b.queue.some((h) => h.memberId === a.memberId)) return FAIL('dup');
      if (activeHoldCount(a.memberId) >= 5) return FAIL('limit');
      b.queue.push({ memberId: a.memberId, seq: seq++ });
      return { ok: true, position: b.queue.length };
    },
    payFine(a) {
      if (a === null || typeof a !== 'object') return FAIL('args');
      if (parseDate(a.date) === null) return FAIL('date');
      if (current !== null && a.date < current) return FAIL('past');
      current = a.date;
      expire(a.date);
      if (!ID(a.memberId)) return FAIL('member');
      const m = members.get(a.memberId);
      if (!m) return FAIL('member');
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return FAIL('amount');
      if (a.amount > m.owed) return FAIL('overpay');
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },
    getMember(a) {
      const r = enter(a, false);
      if (r.f) return r.f;
      const { m } = r;
      const loans = m.loans.map((id) => ({ bookId: id, dueDate: books.get(id).loan.dueDate }));
      const hs = [];
      for (const [id, b] of books) {
        b.queue.forEach((h, i) => {
          if (h.memberId === a.memberId) {
            hs.push({ seq: h.seq, bookId: id, position: i + 1, readyUntil: i === 0 && b.readyUntil !== null ? b.readyUntil : null });
          }
        });
      }
      hs.sort((x, y) => x.seq - y.seq);
      return {
        ok: true,
        loans,
        owed: m.owed,
        holds: hs.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil })),
      };
    },
  };
}
