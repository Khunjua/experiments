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
  const p = (n, l) => String(n).padStart(l, '0');
  return p(dt.getUTCFullYear(), 4) + '-' + p(dt.getUTCMonth() + 1, 2) + '-' + p(dt.getUTCDate(), 2);
}
function addDays(s, n) { return fmt(parseDate(s) + n * DAY); }
function diffDays(a, b) { return Math.round((parseDate(a) - parseDate(b)) / DAY); }
const validId = (x) => typeof x === 'string' && x.length > 0;
const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  function expire(date) {
    for (const b of books.values()) {
      while (b.ready && date > b.readyUntil) {
        const first = b.queue.shift();
        const m = members.get(first);
        const i = m.holds.indexOf(b.id);
        if (i >= 0) m.holds.splice(i, 1);
        if (b.queue.length) {
          b.readyUntil = addDays(b.readyUntil, 8);
        } else {
          b.ready = false;
          b.readyUntil = null;
        }
      }
    }
  }

  // Common prologue for dated calls. Returns args or null.
  function begin(a) {
    if (a === null || typeof a !== 'object') return null;
    if (parseDate(a.date) === null) return null;
    if (current !== null && a.date < current) return null;
    current = a.date;
    expire(a.date);
    return a;
  }

  function addBook(a) {
    if (!a || typeof a !== 'object' || !validId(a.bookId) || books.has(a.bookId)) return FAIL('invalid');
    books.set(a.bookId, { id: a.bookId, loan: null, queue: [], ready: false, readyUntil: null });
    return { ok: true };
  }

  function addMember(a) {
    if (!a || typeof a !== 'object' || !validId(a.memberId) || members.has(a.memberId)) return FAIL('invalid');
    members.set(a.memberId, { loans: [], owed: 0, holds: [] });
    return { ok: true };
  }

  function lookup(a) {
    if (!validId(a.memberId) || !validId(a.bookId)) return null;
    const m = members.get(a.memberId), b = books.get(a.bookId);
    if (!m || !b) return null;
    return { m, b };
  }

  function borrow(arg) {
    const a = begin(arg); if (!a) return FAIL('invalid');
    const x = lookup(a); if (!x) return FAIL('unknown');
    const { m, b } = x;
    if (b.loan) return FAIL('on loan');
    if (b.ready && b.queue[0] !== a.memberId) return FAIL('set aside');
    if (m.loans.length >= 5) return FAIL('limit');
    for (const id of m.loans) if (books.get(id).loan.dueDate < a.date) return FAIL('overdue');
    if (m.owed >= 1000) return FAIL('owed');
    if (b.ready) {
      b.queue.shift();
      const i = m.holds.indexOf(b.id);
      if (i >= 0) m.holds.splice(i, 1);
      b.ready = false;
      b.readyUntil = null;
    }
    const dueDate = addDays(a.date, 21);
    b.loan = { memberId: a.memberId, dueDate, renewals: 0 };
    m.loans.push(b.id);
    return { ok: true, dueDate };
  }

  function returnBook(arg) {
    const a = begin(arg); if (!a) return FAIL('invalid');
    const x = lookup(a); if (!x) return FAIL('unknown');
    const { m, b } = x;
    if (!b.loan || b.loan.memberId !== a.memberId) return FAIL('not borrowed');
    const late = Math.max(0, diffDays(a.date, b.loan.dueDate));
    const fine = Math.min(500, 25 * Math.max(0, late - 2));
    m.owed += fine;
    m.loans.splice(m.loans.indexOf(b.id), 1);
    b.loan = null;
    if (b.queue.length) {
      b.ready = true;
      b.readyUntil = addDays(a.date, 7);
    }
    return { ok: true, fine };
  }

  function renew(arg) {
    const a = begin(arg); if (!a) return FAIL('invalid');
    const x = lookup(a); if (!x) return FAIL('unknown');
    const { b } = x;
    if (!b.loan || b.loan.memberId !== a.memberId) return FAIL('not borrowed');
    if (b.loan.renewals >= 2) return FAIL('max renewals');
    if (a.date > b.loan.dueDate) return FAIL('overdue');
    if (b.queue.length) return FAIL('holds');
    b.loan.dueDate = addDays(a.date, 21);
    b.loan.renewals++;
    return { ok: true, dueDate: b.loan.dueDate };
  }

  function placeHold(arg) {
    const a = begin(arg); if (!a) return FAIL('invalid');
    const x = lookup(a); if (!x) return FAIL('unknown');
    const { m, b } = x;
    if (!b.loan && !b.ready) return FAIL('available');
    if (b.loan && b.loan.memberId === a.memberId) return FAIL('own loan');
    if (b.queue.includes(a.memberId)) return FAIL('duplicate');
    if (m.holds.length >= 5) return FAIL('limit');
    b.queue.push(a.memberId);
    m.holds.push(b.id);
    return { ok: true, position: b.queue.length };
  }

  function payFine(arg) {
    const a = begin(arg); if (!a) return FAIL('invalid');
    if (!validId(a.memberId)) return FAIL('invalid');
    const m = members.get(a.memberId);
    if (!m) return FAIL('unknown');
    if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return FAIL('amount');
    if (a.amount > m.owed) return FAIL('overpay');
    m.owed -= a.amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(arg) {
    const a = begin(arg); if (!a) return FAIL('invalid');
    if (!validId(a.memberId)) return FAIL('invalid');
    const m = members.get(a.memberId);
    if (!m) return FAIL('unknown');
    return {
      ok: true,
      loans: m.loans.map((id) => ({ bookId: id, dueDate: books.get(id).loan.dueDate })),
      owed: m.owed,
      holds: m.holds.map((id) => {
        const b = books.get(id);
        const i = b.queue.indexOf(a.memberId);
        return { bookId: id, position: i + 1, readyUntil: b.ready && i === 0 ? b.readyUntil : null };
      }),
    };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
