export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  const validId = (x) => typeof x === 'string' && x.length > 0;
  const isObj = (a) => typeof a === 'object' && a !== null;

  function toDays(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
    const dt = new Date(0);
    dt.setUTCFullYear(y, m - 1, d);
    dt.setUTCHours(0, 0, 0, 0);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return Math.round(dt.getTime() / 86400000);
  }
  function fromDays(n) {
    const dt = new Date(n * 86400000);
    const y = String(dt.getUTCFullYear()).padStart(4, '0');
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const addDays = (s, n) => fromDays(toDays(s) + n);

  function expire(date) {
    for (const [bookId, b] of books) {
      while (!b.loan && b.queue.length > 0 && date > b.readyUntil) {
        const gone = b.queue.shift();
        const m = members.get(gone);
        const i = m.holds.indexOf(bookId);
        if (i >= 0) m.holds.splice(i, 1);
        if (b.queue.length > 0) b.readyUntil = addDays(b.readyUntil, 8);
        else b.readyUntil = null;
      }
    }
  }

  // returns date string if call proceeds, else null
  function start(a) {
    if (!isObj(a)) return null;
    const d = toDays(a.date);
    if (d === null) return null;
    if (current !== null && a.date < current) return null;
    current = a.date;
    expire(a.date);
    return a.date;
  }

  const fail = (reason) => ({ ok: false, reason });

  return {
    addBook(a) {
      if (!isObj(a) || !validId(a.bookId) || books.has(a.bookId)) return fail('invalid');
      books.set(a.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(a) {
      if (!isObj(a) || !validId(a.memberId) || members.has(a.memberId)) return fail('invalid');
      members.set(a.memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },
    borrow(a) {
      const date = start(a);
      if (!date) return fail('date');
      if (!validId(a.memberId) || !validId(a.bookId)) return fail('id');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (b.queue.length > 0 && b.queue[0] !== a.memberId) return fail('set aside');
      if (m.loans.length >= 5) return fail('limit');
      if (m.owed >= 1000) return fail('owed');
      for (const id of m.loans) if (books.get(id).loan.dueDate < date) return fail('overdue');
      if (b.queue.length > 0) {
        b.queue.shift();
        const i = m.holds.indexOf(a.bookId);
        if (i >= 0) m.holds.splice(i, 1);
        b.readyUntil = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId: a.memberId, dueDate, renewals: 0 };
      m.loans.push(a.bookId);
      return { ok: true, dueDate };
    },
    returnBook(a) {
      const date = start(a);
      if (!date) return fail('date');
      if (!validId(a.memberId) || !validId(a.bookId)) return fail('id');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== a.memberId) return fail('not loaned');
      const late = Math.max(0, toDays(date) - toDays(b.loan.dueDate));
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      b.loan = null;
      m.loans.splice(m.loans.indexOf(a.bookId), 1);
      b.readyUntil = b.queue.length > 0 ? addDays(date, 7) : null;
      return { ok: true, fine };
    },
    renew(a) {
      const date = start(a);
      if (!date) return fail('date');
      if (!validId(a.memberId) || !validId(a.bookId)) return fail('id');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== a.memberId) return fail('not loaned');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (date > b.loan.dueDate) return fail('overdue');
      if (b.queue.length > 0) return fail('holds');
      b.loan.dueDate = addDays(date, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold(a) {
      const date = start(a);
      if (!date) return fail('date');
      if (!validId(a.memberId) || !validId(a.bookId)) return fail('id');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && b.queue.length === 0) return fail('available');
      if (b.loan && b.loan.memberId === a.memberId) return fail('own loan');
      if (b.queue.includes(a.memberId)) return fail('duplicate');
      if (m.holds.length >= 5) return fail('limit');
      b.queue.push(a.memberId);
      m.holds.push(a.bookId);
      return { ok: true, position: b.queue.length };
    },
    payFine(a) {
      const date = start(a);
      if (!date) return fail('date');
      if (!validId(a.memberId)) return fail('id');
      const m = members.get(a.memberId);
      if (!m) return fail('unknown');
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return fail('amount');
      if (a.amount > m.owed) return fail('overpay');
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },
    getMember(a) {
      const date = start(a);
      if (!date) return fail('date');
      if (!validId(a.memberId)) return fail('id');
      const m = members.get(a.memberId);
      if (!m) return fail('unknown');
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
