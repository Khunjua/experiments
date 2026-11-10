export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  const validId = (x) => typeof x === 'string' && x.length > 0;

  function parseDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (y < 1 || y > 9999) return null;
    const dt = new Date(0);
    dt.setUTCFullYear(y, m - 1, d);
    dt.setUTCHours(0, 0, 0, 0);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return dt.getTime();
  }
  const DAY = 86400000;
  function fmt(ms) {
    const dt = new Date(ms);
    const y = String(dt.getUTCFullYear()).padStart(4, '0');
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function addDays(s, n) {
    return fmt(parseDate(s) + n * DAY);
  }

  const fail = (reason) => ({ ok: false, reason });

  function expire(date) {
    for (const b of books.values()) {
      if (b.state !== 'aside') continue;
      while (b.state === 'aside' && date > b.readyUntil) {
        const mid = b.queue.shift();
        const mem = members.get(mid);
        if (mem) {
          const i = mem.holds.indexOf(b.id);
          if (i >= 0) mem.holds.splice(i, 1);
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

  // Returns date string if call may proceed (clock updated, expiry run), else null.
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
      if (args === null || typeof args !== 'object') return fail('invalid');
      const { bookId } = args;
      if (!validId(bookId) || books.has(bookId)) return fail('invalid');
      books.set(bookId, { id: bookId, state: 'available', borrower: null, dueDate: null, renewals: 0, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(args) {
      if (args === null || typeof args !== 'object') return fail('invalid');
      const { memberId } = args;
      if (!validId(memberId) || members.has(memberId)) return fail('invalid');
      members.set(memberId, { id: memberId, loans: [], owed: 0, holds: [] });
      return { ok: true };
    },
    borrow(args) {
      const date = begin(args);
      if (date === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('invalid');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.state === 'loan') return fail('on loan');
      if (b.state === 'aside' && b.queue[0] !== memberId) return fail('set aside');
      if (m.loans.length >= 5) return fail('limit');
      for (const id of m.loans) if (books.get(id).dueDate < date) return fail('overdue');
      if (m.owed >= 1000) return fail('owed');
      if (b.state === 'aside') {
        b.queue.shift();
        const i = m.holds.indexOf(bookId);
        if (i >= 0) m.holds.splice(i, 1);
        b.readyUntil = null;
      }
      b.state = 'loan';
      b.borrower = memberId;
      b.dueDate = addDays(date, 21);
      b.renewals = 0;
      m.loans.push(bookId);
      return { ok: true, dueDate: b.dueDate };
    },
    returnBook(args) {
      const date = begin(args);
      if (date === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('invalid');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.state !== 'loan' || b.borrower !== memberId) return fail('not loaned');
      const daysLate = Math.max(0, Math.round((parseDate(date) - parseDate(b.dueDate)) / DAY));
      const fine = Math.min(500, 25 * Math.max(0, daysLate - 2));
      m.owed += fine;
      m.loans.splice(m.loans.indexOf(bookId), 1);
      b.borrower = null;
      b.dueDate = null;
      b.renewals = 0;
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
      const date = begin(args);
      if (date === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('invalid');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.state !== 'loan' || b.borrower !== memberId) return fail('not loaned');
      if (b.renewals >= 2) return fail('max renewals');
      if (date > b.dueDate) return fail('overdue');
      if (b.queue.length > 0) return fail('holds');
      b.dueDate = addDays(date, 21);
      b.renewals++;
      return { ok: true, dueDate: b.dueDate };
    },
    placeHold(args) {
      const date = begin(args);
      if (date === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('invalid');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.state === 'available') return fail('available');
      if (b.state === 'loan' && b.borrower === memberId) return fail('own loan');
      if (b.queue.includes(memberId)) return fail('duplicate');
      if (m.holds.length >= 5) return fail('limit');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },
    payFine(args) {
      const date = begin(args);
      if (date === null) return fail('date');
      const { memberId, amount } = args;
      if (!validId(memberId)) return fail('invalid');
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail('amount');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (amount > m.owed) return fail('overpay');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember(args) {
      const date = begin(args);
      if (date === null) return fail('date');
      const { memberId } = args;
      if (!validId(memberId)) return fail('invalid');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
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
            readyUntil: b.state === 'aside' && idx === 0 ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}
