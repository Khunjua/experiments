const isId = (x) => typeof x === 'string' && x.length > 0;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.getTime();
}
const DAY = 86400000;
function fmt(ms) {
  const t = new Date(ms);
  const p = (n, w) => String(n).padStart(w, '0');
  return `${p(t.getUTCFullYear(), 4)}-${p(t.getUTCMonth() + 1, 2)}-${p(t.getUTCDate(), 2)}`;
}
function addDays(s, n) {
  return fmt(parseDate(s) + n * DAY);
}
function diffDays(a, b) {
  return Math.round((parseDate(a) - parseDate(b)) / DAY);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;
  const FAIL = (reason) => ({ ok: false, reason });

  function expire(date) {
    for (const [bookId, b] of books) {
      while (b.readyUntil !== null && date > b.readyUntil) {
        const mid = b.queue.shift();
        const m = members.get(mid);
        m.holds = m.holds.filter((x) => x !== bookId);
        if (b.queue.length > 0) {
          b.readyUntil = addDays(b.readyUntil, 8);
        } else {
          b.readyUntil = null;
        }
      }
    }
  }

  // returns null if clock/date invalid, else true after updating clock
  function tick(args) {
    if (args === null || typeof args !== 'object') return false;
    const date = args.date;
    if (parseDate(date) === null) return false;
    if (current !== null && date < current) return false;
    current = date;
    expire(date);
    return true;
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object') return FAIL('args');
      const { bookId } = args;
      if (!isId(bookId) || books.has(bookId)) return FAIL('invalid');
      books.set(bookId, { loanMember: null, dueDate: null, renewals: 0, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(args) {
      if (args === null || typeof args !== 'object') return FAIL('args');
      const { memberId } = args;
      if (!isId(memberId) || members.has(memberId)) return FAIL('invalid');
      members.set(memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },
    borrow(args) {
      if (!tick(args)) return FAIL('date');
      const { memberId, bookId, date } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.loanMember !== null) return FAIL('on loan');
      if (b.readyUntil !== null && b.queue[0] !== memberId) return FAIL('set aside');
      if (m.loans.length >= 5) return FAIL('limit');
      if (m.owed >= 1000) return FAIL('owed');
      for (const id of m.loans) if (books.get(id).dueDate < date) return FAIL('overdue');
      if (b.readyUntil !== null) {
        b.queue.shift();
        b.readyUntil = null;
        m.holds = m.holds.filter((x) => x !== bookId);
      }
      b.loanMember = memberId;
      b.dueDate = addDays(date, 21);
      b.renewals = 0;
      m.loans.push(bookId);
      return { ok: true, dueDate: b.dueDate };
    },
    returnBook(args) {
      if (!tick(args)) return FAIL('date');
      const { memberId, bookId, date } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.loanMember !== memberId) return FAIL('not borrowed');
      const late = Math.max(0, diffDays(date, b.dueDate));
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      m.loans = m.loans.filter((x) => x !== bookId);
      b.loanMember = null;
      b.dueDate = null;
      b.renewals = 0;
      b.readyUntil = b.queue.length > 0 ? addDays(date, 7) : null;
      return { ok: true, fine };
    },
    renew(args) {
      if (!tick(args)) return FAIL('date');
      const { memberId, bookId, date } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.loanMember !== memberId) return FAIL('not borrowed');
      if (b.renewals >= 2) return FAIL('max renewals');
      if (date > b.dueDate) return FAIL('overdue');
      if (b.queue.length > 0) return FAIL('holds');
      b.dueDate = addDays(date, 21);
      b.renewals++;
      return { ok: true, dueDate: b.dueDate };
    },
    placeHold(args) {
      if (!tick(args)) return FAIL('date');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return FAIL('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.loanMember === null && b.readyUntil === null) return FAIL('available');
      if (b.loanMember === memberId) return FAIL('own loan');
      if (b.queue.includes(memberId)) return FAIL('duplicate');
      if (m.holds.length >= 5) return FAIL('hold limit');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },
    payFine(args) {
      if (!tick(args)) return FAIL('date');
      const { memberId, amount } = args;
      if (!isId(memberId)) return FAIL('id');
      const m = members.get(memberId);
      if (!m) return FAIL('unknown');
      if (!Number.isSafeInteger(amount) || amount <= 0) return FAIL('amount');
      if (amount > m.owed) return FAIL('overpay');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember(args) {
      if (!tick(args)) return FAIL('date');
      const { memberId } = args;
      if (!isId(memberId)) return FAIL('id');
      const m = members.get(memberId);
      if (!m) return FAIL('unknown');
      return {
        ok: true,
        loans: m.loans.map((id) => ({ bookId: id, dueDate: books.get(id).dueDate })),
        owed: m.owed,
        holds: m.holds.map((id) => {
          const b = books.get(id);
          const idx = b.queue.indexOf(memberId);
          return {
            bookId: id,
            position: idx + 1,
            readyUntil: idx === 0 && b.readyUntil !== null ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}
