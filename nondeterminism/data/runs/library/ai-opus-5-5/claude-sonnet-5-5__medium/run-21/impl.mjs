const ID = (x) => typeof x === 'string' && x.length > 0;
const DAY = 86400000;

function parse(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime() / DAY;
}
function fmt(n) {
  const dt = new Date(n * DAY);
  const p = (v, l) => String(v).padStart(l, '0');
  return `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1, 2)}-${p(dt.getUTCDate(), 2)}`;
}
function addDays(s, n) { return fmt(parse(s) + n); }

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;
  const FAIL = (reason) => ({ ok: false, reason });

  function expire(date) {
    for (const [bookId, b] of books) {
      while (!b.loan && b.queue.length > 0 && b.readyUntil !== null && date > b.readyUntil) {
        const gone = b.queue.shift();
        const m = members.get(gone);
        const i = m.holds.indexOf(bookId);
        if (i >= 0) m.holds.splice(i, 1);
        if (b.queue.length > 0) b.readyUntil = addDays(b.readyUntil, 8);
        else b.readyUntil = null;
      }
    }
  }

  // returns null on failure, else date string
  function tick(args) {
    if (args === null || typeof args !== 'object') return null;
    if (parse(args.date) === null) return null;
    if (current !== null && args.date < current) return null;
    current = args.date;
    expire(args.date);
    return args.date;
  }

  return {
    addBook(a) {
      if (!a || typeof a !== 'object' || !ID(a.bookId)) return FAIL('invalid');
      if (books.has(a.bookId)) return FAIL('exists');
      books.set(a.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(a) {
      if (!a || typeof a !== 'object' || !ID(a.memberId)) return FAIL('invalid');
      if (members.has(a.memberId)) return FAIL('exists');
      members.set(a.memberId, { loans: [], holds: [], owed: 0 });
      return { ok: true };
    },
    borrow(a) {
      const date = tick(a);
      if (!date) return FAIL('invalid');
      if (!ID(a.memberId) || !ID(a.bookId)) return FAIL('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.loan) return FAIL('on loan');
      if (b.queue.length > 0 && b.queue[0] !== a.memberId) return FAIL('set aside');
      if (m.loans.length >= 5) return FAIL('limit');
      if (m.owed >= 1000) return FAIL('owed');
      for (const id of m.loans) if (books.get(id).loan.dueDate < date) return FAIL('overdue');
      const dueDate = addDays(date, 21);
      if (b.queue.length > 0) {
        b.queue.shift();
        b.readyUntil = null;
        const i = m.holds.indexOf(a.bookId);
        if (i >= 0) m.holds.splice(i, 1);
      }
      b.loan = { memberId: a.memberId, dueDate, renewals: 0 };
      m.loans.push(a.bookId);
      return { ok: true, dueDate };
    },
    returnBook(a) {
      const date = tick(a);
      if (!date) return FAIL('invalid');
      if (!ID(a.memberId) || !ID(a.bookId)) return FAIL('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan || b.loan.memberId !== a.memberId) return FAIL('not loaned');
      const late = Math.max(0, parse(date) - parse(b.loan.dueDate));
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      b.loan = null;
      m.loans.splice(m.loans.indexOf(a.bookId), 1);
      b.readyUntil = b.queue.length > 0 ? addDays(date, 7) : null;
      return { ok: true, fine };
    },
    renew(a) {
      const date = tick(a);
      if (!date) return FAIL('invalid');
      if (!ID(a.memberId) || !ID(a.bookId)) return FAIL('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan || b.loan.memberId !== a.memberId) return FAIL('not loaned');
      if (b.loan.renewals >= 2) return FAIL('max renewals');
      if (date > b.loan.dueDate) return FAIL('overdue');
      if (b.queue.length > 0) return FAIL('holds');
      b.loan.dueDate = addDays(date, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold(a) {
      const date = tick(a);
      if (!date) return FAIL('invalid');
      if (!ID(a.memberId) || !ID(a.bookId)) return FAIL('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan && b.queue.length === 0) return FAIL('available');
      if (b.loan && b.loan.memberId === a.memberId) return FAIL('own loan');
      if (b.queue.includes(a.memberId)) return FAIL('duplicate');
      if (m.holds.length >= 5) return FAIL('limit');
      b.queue.push(a.memberId);
      m.holds.push(a.bookId);
      return { ok: true, position: b.queue.length };
    },
    payFine(a) {
      const date = tick(a);
      if (!date) return FAIL('invalid');
      if (!ID(a.memberId)) return FAIL('invalid');
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return FAIL('amount');
      const m = members.get(a.memberId);
      if (!m) return FAIL('unknown');
      if (a.amount > m.owed) return FAIL('overpay');
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },
    getMember(a) {
      const date = tick(a);
      if (!date) return FAIL('invalid');
      if (!ID(a.memberId)) return FAIL('invalid');
      const m = members.get(a.memberId);
      if (!m) return FAIL('unknown');
      return {
        ok: true,
        loans: m.loans.map((id) => ({ bookId: id, dueDate: books.get(id).loan.dueDate })),
        owed: m.owed,
        holds: m.holds.map((id) => {
          const b = books.get(id);
          const pos = b.queue.indexOf(a.memberId);
          return {
            bookId: id,
            position: pos + 1,
            readyUntil: pos === 0 && !b.loan ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}
