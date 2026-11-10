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
  const y = dt.getUTCFullYear();
  return String(y).padStart(4, '0') + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
}

function addDays(s, n) {
  const p = parseDate(s);
  if (p === null) return null;
  const r = p + n;
  return fmt(r);
}

const validId = (x) => typeof x === 'string' && x.length > 0;
const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  function expire(date) {
    for (const b of books.values()) {
      while (b.ready && date > b.readyUntil) {
        const mid = b.queue.shift();
        const m = members.get(mid);
        if (m) {
          const i = m.holds.indexOf(b.id);
          if (i >= 0) m.holds.splice(i, 1);
        }
        if (b.queue.length > 0) {
          b.readyUntil = addDays(b.readyUntil, 8);
        } else {
          b.ready = false;
          b.readyUntil = null;
        }
      }
    }
  }

  // Common prologue for dated calls. Returns null on failure, else {date}
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    const date = args.date;
    if (parseDate(date) === null) return null;
    if (current !== null && date < current) return null;
    current = date;
    expire(date);
    return { date };
  }

  function addBook(args) {
    if (args === null || typeof args !== 'object') return FAIL('invalid');
    const { bookId } = args;
    if (!validId(bookId) || books.has(bookId)) return FAIL('invalid');
    books.set(bookId, { id: bookId, loan: null, ready: false, readyUntil: null, queue: [] });
    return { ok: true };
  }

  function addMember(args) {
    if (args === null || typeof args !== 'object') return FAIL('invalid');
    const { memberId } = args;
    if (!validId(memberId) || members.has(memberId)) return FAIL('invalid');
    members.set(memberId, { id: memberId, loans: [], owed: 0, holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const c = begin(args);
    if (!c) return FAIL('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return FAIL('unknown');
    if (b.loan) return FAIL('on loan');
    if (b.ready && b.queue[0] !== memberId) return FAIL('set aside');
    if (m.loans.length >= 5) return FAIL('limit');
    for (const id of m.loans) if (books.get(id).loan.dueDate < c.date) return FAIL('overdue');
    if (m.owed >= 1000) return FAIL('owed');
    if (b.ready) {
      b.queue.shift();
      b.ready = false;
      b.readyUntil = null;
      const i = m.holds.indexOf(bookId);
      if (i >= 0) m.holds.splice(i, 1);
    }
    const dueDate = addDays(c.date, 21);
    b.loan = { memberId, dueDate, renewals: 0 };
    m.loans.push(bookId);
    return { ok: true, dueDate };
  }

  function returnBook(args) {
    const c = begin(args);
    if (!c) return FAIL('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return FAIL('unknown');
    if (!b.loan || b.loan.memberId !== memberId) return FAIL('not loaned');
    const late = Math.max(0, parseDate(c.date) - parseDate(b.loan.dueDate));
    const fine = Math.min(500, 25 * Math.max(0, late - 2));
    m.owed += fine;
    b.loan = null;
    m.loans.splice(m.loans.indexOf(bookId), 1);
    if (b.queue.length > 0) {
      b.ready = true;
      b.readyUntil = addDays(c.date, 7);
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const c = begin(args);
    if (!c) return FAIL('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return FAIL('unknown');
    if (!b.loan || b.loan.memberId !== memberId) return FAIL('not loaned');
    if (b.loan.renewals >= 2) return FAIL('max renewals');
    if (c.date > b.loan.dueDate) return FAIL('overdue');
    if (b.queue.length > 0) return FAIL('holds');
    b.loan.dueDate = addDays(c.date, 21);
    b.loan.renewals++;
    return { ok: true, dueDate: b.loan.dueDate };
  }

  function placeHold(args) {
    const c = begin(args);
    if (!c) return FAIL('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return FAIL('unknown');
    if (!b.loan && !b.ready) return FAIL('available');
    if (b.loan && b.loan.memberId === memberId) return FAIL('own loan');
    if (b.queue.includes(memberId)) return FAIL('duplicate');
    if (m.holds.length >= 5) return FAIL('limit');
    b.queue.push(memberId);
    m.holds.push(bookId);
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    const c = begin(args);
    if (!c) return FAIL('invalid');
    const { memberId, amount } = args;
    if (!validId(memberId)) return FAIL('invalid');
    if (!Number.isSafeInteger(amount) || amount <= 0) return FAIL('amount');
    const m = members.get(memberId);
    if (!m) return FAIL('unknown');
    if (amount > m.owed) return FAIL('overpay');
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const c = begin(args);
    if (!c) return FAIL('invalid');
    const { memberId } = args;
    if (!validId(memberId)) return FAIL('invalid');
    const m = members.get(memberId);
    if (!m) return FAIL('unknown');
    return {
      ok: true,
      loans: m.loans.map((id) => ({ bookId: id, dueDate: books.get(id).loan.dueDate })),
      owed: m.owed,
      holds: m.holds.map((id) => {
        const b = books.get(id);
        const pos = b.queue.indexOf(memberId);
        return { bookId: id, position: pos + 1, readyUntil: b.ready && pos === 0 ? b.readyUntil : null };
      }),
    };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
