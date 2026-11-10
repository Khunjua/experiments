const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(dt.getTime() / 86400000);
}

function fmt(n) {
  const dt = new Date(n * 86400000);
  const y = dt.getUTCFullYear();
  return String(y).padStart(4, '0') + '-' +
    String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(dt.getUTCDate()).padStart(2, '0');
}

function addDays(s, n) {
  return fmt(parseDate(s) + n);
}

const validId = (x) => typeof x === 'string' && x.length > 0;
const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  function expire(date) {
    for (const [bookId, b] of books) {
      if (b.loan) continue;
      while (b.queue.length > 0 && b.readyUntil !== null && date > b.readyUntil) {
        const mid = b.queue.shift();
        const m = members.get(mid);
        const i = m.holds.indexOf(bookId);
        if (i >= 0) m.holds.splice(i, 1);
        if (b.queue.length > 0) b.readyUntil = addDays(b.readyUntil, 8);
        else b.readyUntil = null;
      }
    }
  }

  // Validates and advances clock; returns null on failure
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    if (parseDate(args.date) === null) return null;
    if (current !== null && args.date < current) return null;
    current = args.date;
    expire(args.date);
    return args.date;
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object') return FAIL('invalid');
      const { bookId } = args;
      if (!validId(bookId) || books.has(bookId)) return FAIL('invalid');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(args) {
      if (args === null || typeof args !== 'object') return FAIL('invalid');
      const { memberId } = args;
      if (!validId(memberId) || members.has(memberId)) return FAIL('invalid');
      members.set(memberId, { owed: 0, loans: [], holds: [] });
      return { ok: true };
    },
    borrow(args) {
      const date = begin(args);
      if (date === null) return FAIL('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return FAIL('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.loan) return FAIL('on loan');
      if (b.queue.length > 0 && b.queue[0] !== memberId) return FAIL('set aside');
      if (m.loans.length >= 5) return FAIL('limit');
      if (m.owed >= 1000) return FAIL('owed');
      for (const id of m.loans) {
        if (books.get(id).loan.dueDate < date) return FAIL('overdue');
      }
      if (b.queue.length > 0 && b.queue[0] === memberId) {
        b.queue.shift();
        const i = m.holds.indexOf(bookId);
        if (i >= 0) m.holds.splice(i, 1);
        b.readyUntil = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate };
    },
    returnBook(args) {
      const date = begin(args);
      if (date === null) return FAIL('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return FAIL('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return FAIL('not loaned');
      const late = Math.max(0, parseDate(date) - parseDate(b.loan.dueDate));
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      b.loan = null;
      m.loans.splice(m.loans.indexOf(bookId), 1);
      if (b.queue.length > 0) b.readyUntil = addDays(date, 7);
      else b.readyUntil = null;
      return { ok: true, fine };
    },
    renew(args) {
      const date = begin(args);
      if (date === null) return FAIL('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return FAIL('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return FAIL('not loaned');
      if (b.loan.renewals >= 2) return FAIL('max renewals');
      if (date > b.loan.dueDate) return FAIL('overdue');
      if (b.queue.length > 0) return FAIL('holds');
      b.loan.dueDate = addDays(date, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold(args) {
      const date = begin(args);
      if (date === null) return FAIL('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return FAIL('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan && b.queue.length === 0) return FAIL('available');
      if (b.loan && b.loan.memberId === memberId) return FAIL('own loan');
      if (b.queue.includes(memberId)) return FAIL('duplicate');
      if (m.holds.length >= 5) return FAIL('limit');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },
    payFine(args) {
      const date = begin(args);
      if (date === null) return FAIL('date');
      const { memberId, amount } = args;
      if (!validId(memberId)) return FAIL('id');
      if (!Number.isSafeInteger(amount) || amount <= 0) return FAIL('amount');
      const m = members.get(memberId);
      if (!m) return FAIL('unknown');
      if (amount > m.owed) return FAIL('overpay');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember(args) {
      const date = begin(args);
      if (date === null) return FAIL('date');
      const { memberId } = args;
      if (!validId(memberId)) return FAIL('id');
      const m = members.get(memberId);
      if (!m) return FAIL('unknown');
      return {
        ok: true,
        loans: m.loans.map((id) => ({ bookId: id, dueDate: books.get(id).loan.dueDate })),
        owed: m.owed,
        holds: m.holds.map((id) => {
          const b = books.get(id);
          const idx = b.queue.indexOf(memberId);
          return {
            bookId: id,
            position: idx + 1,
            readyUntil: !b.loan && idx === 0 ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}
