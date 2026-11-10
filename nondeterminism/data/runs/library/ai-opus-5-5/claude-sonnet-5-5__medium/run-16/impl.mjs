const DAY = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.getTime();
}

function fmt(ms) {
  const t = new Date(ms);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return fmt(parseDate(s) + n * DAY);
}

function diffDays(a, b) {
  return Math.round((parseDate(a) - parseDate(b)) / DAY);
}

const validId = (x) => typeof x === 'string' && x.length > 0;
const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map(); // id -> {loan:{memberId,dueDate,renewals}|null, queue:[memberId], readyUntil:string|null}
  const members = new Map(); // id -> {loans:[bookId], owed, holds:[bookId]}
  let current = null;

  function expire(date) {
    for (const b of books.values()) {
      if (b.loan) continue;
      while (b.queue.length > 0 && b.readyUntil !== null && date > b.readyUntil) {
        const gone = b.queue.shift();
        const m = members.get(gone);
        if (m) {
          const i = m.holds.indexOf(b.id);
          if (i >= 0) m.holds.splice(i, 1);
        }
        if (b.queue.length > 0) {
          b.readyUntil = addDays(b.readyUntil, 8);
        } else {
          b.readyUntil = null;
        }
      }
    }
  }

  // validates date and advances clock; returns args or null
  function begin(args, fields, needBook, needMember) {
    if (args === null || typeof args !== 'object') return null;
    if (parseDate(args.date) === null) return null;
    if (current !== null && args.date < current) return null;
    for (const f of fields) if (!validId(args[f])) return null;
    return args;
  }

  function tick(date) {
    current = date;
    expire(date);
  }

  return {
    addBook(a) {
      if (a === null || typeof a !== 'object' || !validId(a.bookId)) return FAIL('invalid');
      if (books.has(a.bookId)) return FAIL('exists');
      books.set(a.bookId, { id: a.bookId, loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(a) {
      if (a === null || typeof a !== 'object' || !validId(a.memberId)) return FAIL('invalid');
      if (members.has(a.memberId)) return FAIL('exists');
      members.set(a.memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },
    borrow(a) {
      a = begin(a, ['memberId', 'bookId']);
      if (!a) return FAIL('invalid');
      tick(a.date);
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.loan) return FAIL('on loan');
      if (b.queue.length > 0 && b.queue[0] !== a.memberId) return FAIL('set aside');
      if (m.loans.length >= 5) return FAIL('limit');
      for (const id of m.loans) if (books.get(id).loan.dueDate < a.date) return FAIL('overdue');
      if (m.owed >= 1000) return FAIL('owed');
      if (b.queue.length > 0) {
        b.queue.shift();
        b.readyUntil = null;
        const i = m.holds.indexOf(b.id);
        if (i >= 0) m.holds.splice(i, 1);
      }
      const dueDate = addDays(a.date, 21);
      b.loan = { memberId: a.memberId, dueDate, renewals: 0 };
      m.loans.push(b.id);
      return { ok: true, dueDate };
    },
    returnBook(a) {
      a = begin(a, ['memberId', 'bookId']);
      if (!a) return FAIL('invalid');
      tick(a.date);
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan || b.loan.memberId !== a.memberId) return FAIL('not loaned');
      const late = Math.max(0, diffDays(a.date, b.loan.dueDate));
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      m.loans.splice(m.loans.indexOf(b.id), 1);
      b.loan = null;
      if (b.queue.length > 0) b.readyUntil = addDays(a.date, 7);
      else b.readyUntil = null;
      return { ok: true, fine };
    },
    renew(a) {
      a = begin(a, ['memberId', 'bookId']);
      if (!a) return FAIL('invalid');
      tick(a.date);
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan || b.loan.memberId !== a.memberId) return FAIL('not loaned');
      if (b.loan.renewals >= 2) return FAIL('max renewals');
      if (a.date > b.loan.dueDate) return FAIL('overdue');
      if (b.queue.length > 0) return FAIL('holds');
      b.loan.dueDate = addDays(a.date, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold(a) {
      a = begin(a, ['memberId', 'bookId']);
      if (!a) return FAIL('invalid');
      tick(a.date);
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan && b.queue.length === 0) return FAIL('available');
      if (b.loan && b.loan.memberId === a.memberId) return FAIL('own loan');
      if (b.queue.includes(a.memberId)) return FAIL('duplicate');
      if (m.holds.length >= 5) return FAIL('limit');
      b.queue.push(a.memberId);
      m.holds.push(b.id);
      return { ok: true, position: b.queue.length };
    },
    payFine(a) {
      if (a === null || typeof a !== 'object') return FAIL('invalid');
      if (parseDate(a.date) === null || (current !== null && a.date < current)) return FAIL('invalid');
      if (!validId(a.memberId)) return FAIL('invalid');
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return FAIL('amount');
      tick(a.date);
      const m = members.get(a.memberId);
      if (!m) return FAIL('unknown');
      if (a.amount > m.owed) return FAIL('overpay');
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },
    getMember(a) {
      a = begin(a, ['memberId']);
      if (!a) return FAIL('invalid');
      tick(a.date);
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
