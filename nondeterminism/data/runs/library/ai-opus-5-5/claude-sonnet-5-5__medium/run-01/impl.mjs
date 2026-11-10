export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  const DAY = 86400000;
  const pad = (n, w) => String(n).padStart(w, '0');

  function parseDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
    const dt = new Date(0);
    dt.setUTCFullYear(y, m - 1, d);
    dt.setUTCHours(0, 0, 0, 0);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return dt.getTime();
  }
  function fmt(ms) {
    const dt = new Date(ms);
    return pad(dt.getUTCFullYear(), 4) + '-' + pad(dt.getUTCMonth() + 1, 2) + '-' + pad(dt.getUTCDate(), 2);
  }
  function addDays(s, n) {
    return fmt(parseDate(s) + n * DAY);
  }
  function diffDays(a, b) {
    return Math.round((parseDate(a) - parseDate(b)) / DAY);
  }
  const validId = (x) => typeof x === 'string' && x.length > 0;
  const fail = (reason) => ({ ok: false, reason });

  function expire(date) {
    for (const b of books.values()) {
      while (b.state === 'aside' && date > b.readyUntil) {
        const mid = b.queue.shift();
        const m = members.get(mid);
        if (m) {
          const i = m.holds.indexOf(b.id);
          if (i >= 0) m.holds.splice(i, 1);
        }
        if (b.queue.length > 0) {
          b.readyUntil = addDays(b.readyUntil, 8);
        } else {
          b.state = 'available';
          b.readyUntil = null;
        }
      }
    }
  }

  // Returns true if the call may proceed (clock advanced and expiry processed)
  function begin(args) {
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
      if (args === null || typeof args !== 'object') return fail('args');
      const { bookId } = args;
      if (!validId(bookId) || books.has(bookId)) return fail('invalid');
      books.set(bookId, { id: bookId, state: 'available', loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(args) {
      if (args === null || typeof args !== 'object') return fail('args');
      const { memberId } = args;
      if (!validId(memberId) || members.has(memberId)) return fail('invalid');
      members.set(memberId, { id: memberId, owed: 0, loans: [], holds: [] });
      return { ok: true };
    },
    borrow(args) {
      if (!begin(args)) return fail('args');
      const { memberId, bookId, date } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.state === 'loan') return fail('on loan');
      if (b.state === 'aside' && b.queue[0] !== memberId) return fail('set aside');
      if (m.loans.length >= 5) return fail('limit');
      for (const id of m.loans) {
        if (books.get(id).loan.dueDate < date) return fail('overdue');
      }
      if (m.owed >= 1000) return fail('owed');
      if (b.state === 'aside') {
        b.queue.shift();
        const i = m.holds.indexOf(bookId);
        if (i >= 0) m.holds.splice(i, 1);
        b.readyUntil = null;
      }
      const dueDate = addDays(date, 21);
      b.state = 'loan';
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate };
    },
    returnBook(args) {
      if (!begin(args)) return fail('args');
      const { memberId, bookId, date } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.state !== 'loan' || b.loan.memberId !== memberId) return fail('not loaned');
      const late = Math.max(0, diffDays(date, b.loan.dueDate));
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      m.loans.splice(m.loans.indexOf(bookId), 1);
      b.loan = null;
      if (b.queue.length === 0) {
        b.state = 'available';
        b.readyUntil = null;
      } else {
        b.state = 'aside';
        b.readyUntil = addDays(date, 7);
      }
      return { ok: true, fine };
    },
    renew(args) {
      if (!begin(args)) return fail('args');
      const { memberId, bookId, date } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.state !== 'loan' || b.loan.memberId !== memberId) return fail('not loaned');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (date > b.loan.dueDate) return fail('overdue');
      if (b.queue.length > 0) return fail('holds');
      b.loan.dueDate = addDays(date, 21);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold(args) {
      if (!begin(args)) return fail('args');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.state === 'available') return fail('available');
      if (b.state === 'loan' && b.loan.memberId === memberId) return fail('own loan');
      if (b.queue.includes(memberId)) return fail('duplicate');
      if (m.holds.length >= 5) return fail('limit');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },
    payFine(args) {
      if (!begin(args)) return fail('args');
      const { memberId, amount } = args;
      if (!validId(memberId)) return fail('id');
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail('amount');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (amount > m.owed) return fail('overpay');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember(args) {
      if (!begin(args)) return fail('args');
      const { memberId } = args;
      if (!validId(memberId)) return fail('id');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
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
            readyUntil: b.state === 'aside' && idx === 0 ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}
