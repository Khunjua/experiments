const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(dt.getTime() / DAY_MS);
}

function fmt(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const validId = (x) => typeof x === 'string' && x.length > 0;
const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // id -> { state, holder, queue, readyUntil, loan }
  const members = new Map(); // id -> { loans: [{bookId, due, renewals}], owed, holds: [bookId] }
  let current = null;

  function removeFrom(arr, v) {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1);
  }

  function expire(day) {
    for (const [bookId, b] of books) {
      while (b.state === 'aside' && day > b.readyUntil) {
        const first = b.queue.shift();
        const m = members.get(first);
        if (m) removeFrom(m.holds, bookId);
        if (b.queue.length > 0) {
          b.readyUntil = b.readyUntil + 1 + 7;
        } else {
          b.state = 'available';
          b.readyUntil = null;
        }
      }
    }
  }

  // Validates args object and date, advances clock, runs expiry.
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    expire(day);
    return day;
  }

  function addBook(args) {
    if (!args || typeof args !== 'object' || !validId(args.bookId)) return FAIL('invalid');
    if (books.has(args.bookId)) return FAIL('exists');
    books.set(args.bookId, { state: 'available', holder: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (!args || typeof args !== 'object' || !validId(args.memberId)) return FAIL('invalid');
    if (members.has(args.memberId)) return FAIL('exists');
    members.set(args.memberId, { loans: [], owed: 0, holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const day = begin(args);
    if (day === null) return FAIL('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return FAIL('unknown');
    if (b.state === 'loan') return FAIL('on loan');
    if (b.state === 'aside' && b.queue[0] !== memberId) return FAIL('set aside');
    if (m.loans.length >= 5) return FAIL('limit');
    if (m.loans.some((l) => l.due < day)) return FAIL('overdue');
    if (m.owed >= 1000) return FAIL('owed');
    if (b.state === 'aside') {
      b.queue.shift();
      removeFrom(m.holds, bookId);
    }
    b.state = 'loan';
    b.holder = memberId;
    b.readyUntil = null;
    const due = day + 21;
    m.loans.push({ bookId, due, renewals: 0 });
    return { ok: true, dueDate: fmt(due) };
  }

  function returnBook(args) {
    const day = begin(args);
    if (day === null) return FAIL('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return FAIL('unknown');
    if (b.state !== 'loan' || b.holder !== memberId) return FAIL('not loaned');
    const loan = m.loans.find((l) => l.bookId === bookId);
    const late = Math.max(0, day - loan.due);
    const fine = Math.min(500, 25 * Math.max(0, late - 2));
    m.owed += fine;
    removeFrom(m.loans, loan);
    b.holder = null;
    if (b.queue.length === 0) {
      b.state = 'available';
      b.readyUntil = null;
    } else {
      b.state = 'aside';
      b.readyUntil = day + 7;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const day = begin(args);
    if (day === null) return FAIL('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return FAIL('unknown');
    if (b.state !== 'loan' || b.holder !== memberId) return FAIL('not loaned');
    const loan = m.loans.find((l) => l.bookId === bookId);
    if (loan.renewals >= 2) return FAIL('max renewals');
    if (day > loan.due) return FAIL('overdue');
    if (b.queue.length > 0) return FAIL('holds');
    loan.due = day + 21;
    loan.renewals += 1;
    return { ok: true, dueDate: fmt(loan.due) };
  }

  function placeHold(args) {
    const day = begin(args);
    if (day === null) return FAIL('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return FAIL('invalid');
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return FAIL('unknown');
    if (b.state === 'available') return FAIL('available');
    if (b.state === 'loan' && b.holder === memberId) return FAIL('own loan');
    if (b.queue.includes(memberId)) return FAIL('duplicate');
    if (m.holds.length >= 5) return FAIL('hold limit');
    b.queue.push(memberId);
    m.holds.push(bookId);
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    const day = begin(args);
    if (day === null) return FAIL('invalid');
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
    const day = begin(args);
    if (day === null) return FAIL('invalid');
    const { memberId } = args;
    if (!validId(memberId)) return FAIL('invalid');
    const m = members.get(memberId);
    if (!m) return FAIL('unknown');
    return {
      ok: true,
      loans: m.loans.map((l) => ({ bookId: l.bookId, dueDate: fmt(l.due) })),
      owed: m.owed,
      holds: m.holds.map((bookId) => {
        const b = books.get(bookId);
        return {
          bookId,
          position: b.queue.indexOf(memberId) + 1,
          readyUntil: b.state === 'aside' && b.queue[0] === memberId ? fmt(b.readyUntil) : null,
        };
      }),
    };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
