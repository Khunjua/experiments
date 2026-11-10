export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  const DAY = 86400000;
  const validId = (x) => typeof x === 'string' && x.length > 0;

  function toDays(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
    const dt = new Date(0);
    dt.setUTCFullYear(y, m - 1, d);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return Math.round(dt.getTime() / DAY);
  }

  function fromDays(n) {
    const dt = new Date(n * DAY);
    const y = dt.getUTCFullYear();
    const p = (v, l) => String(v).padStart(l, '0');
    return p(y, 4) + '-' + p(dt.getUTCMonth() + 1, 2) + '-' + p(dt.getUTCDate(), 2);
  }

  const fail = (reason) => ({ ok: false, reason });

  function expire(day) {
    for (const b of books.values()) {
      while (b.readyUntil !== null && day > b.readyUntil) {
        b.queue.shift();
        if (b.queue.length) b.readyUntil = b.readyUntil + 1 + 7;
        else b.readyUntil = null;
      }
    }
  }

  // Common prologue for dated calls. Returns day number or null (failure).
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    const day = toDays(args.date);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    expire(day);
    return day;
  }

  function addBook(args) {
    if (args === null || typeof args !== 'object') return fail('invalid');
    const { bookId } = args;
    if (!validId(bookId) || books.has(bookId)) return fail('invalid');
    books.set(bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (args === null || typeof args !== 'object') return fail('invalid');
    const { memberId } = args;
    if (!validId(memberId) || members.has(memberId)) return fail('invalid');
    members.set(memberId, { loans: [], holds: [], owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    const day = begin(args);
    if (day === null) return fail('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return fail('invalid');
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return fail('unregistered');
    if (b.loan) return fail('on loan');
    if (b.queue.length && b.queue[0] !== memberId) return fail('set aside');
    if (m.loans.length >= 5) return fail('limit');
    for (const id of m.loans) if (books.get(id).loan.dueDate < day) return fail('overdue');
    if (m.owed >= 1000) return fail('owed');
    if (b.queue.length) {
      b.queue.shift();
      b.readyUntil = b.queue.length ? b.readyUntil : null;
      if (b.queue.length) {
        // remaining holds wait behind; the book is on loan now, so no ready date
        b.readyUntil = null;
      }
      const i = m.holds.indexOf(bookId);
      if (i >= 0) m.holds.splice(i, 1);
    }
    const dueDate = day + 21;
    b.loan = { memberId, dueDate, renewals: 0 };
    m.loans.push(bookId);
    return { ok: true, dueDate: fromDays(dueDate) };
  }

  function returnBook(args) {
    const day = begin(args);
    if (day === null) return fail('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return fail('invalid');
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return fail('unregistered');
    if (!b.loan || b.loan.memberId !== memberId) return fail('not on loan');
    const late = Math.max(0, day - b.loan.dueDate);
    const fine = Math.min(500, 25 * Math.max(0, late - 2));
    m.owed += fine;
    b.loan = null;
    const i = m.loans.indexOf(bookId);
    if (i >= 0) m.loans.splice(i, 1);
    b.readyUntil = b.queue.length ? day + 7 : null;
    return { ok: true, fine };
  }

  function renew(args) {
    const day = begin(args);
    if (day === null) return fail('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return fail('invalid');
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return fail('unregistered');
    if (!b.loan || b.loan.memberId !== memberId) return fail('not on loan');
    if (b.loan.renewals >= 2) return fail('max renewals');
    if (day > b.loan.dueDate) return fail('overdue');
    if (b.queue.length) return fail('holds');
    b.loan.dueDate = day + 21;
    b.loan.renewals++;
    return { ok: true, dueDate: fromDays(b.loan.dueDate) };
  }

  function placeHold(args) {
    const day = begin(args);
    if (day === null) return fail('invalid');
    const { memberId, bookId } = args;
    if (!validId(memberId) || !validId(bookId)) return fail('invalid');
    const m = members.get(memberId), b = books.get(bookId);
    if (!m || !b) return fail('unregistered');
    if (!b.loan && b.queue.length === 0) return fail('available');
    if (b.loan && b.loan.memberId === memberId) return fail('own loan');
    if (b.queue.includes(memberId)) return fail('duplicate');
    if (m.holds.length >= 5) return fail('limit');
    b.queue.push(memberId);
    m.holds.push(bookId);
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    const day = begin(args);
    if (day === null) return fail('invalid');
    const { memberId, amount } = args;
    if (!validId(memberId)) return fail('invalid');
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail('amount');
    const m = members.get(memberId);
    if (!m) return fail('unregistered');
    if (amount > m.owed) return fail('overpay');
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const day = begin(args);
    if (day === null) return fail('invalid');
    const { memberId } = args;
    if (!validId(memberId)) return fail('invalid');
    const m = members.get(memberId);
    if (!m) return fail('unregistered');
    return {
      ok: true,
      loans: m.loans.map((id) => ({ bookId: id, dueDate: fromDays(books.get(id).loan.dueDate) })),
      owed: m.owed,
      holds: m.holds.map((id) => {
        const b = books.get(id);
        const ready = !b.loan && b.readyUntil !== null && b.queue[0] === memberId;
        return {
          bookId: id,
          position: b.queue.indexOf(memberId) + 1,
          readyUntil: ready ? fromDays(b.readyUntil) : null,
        };
      }),
    };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
