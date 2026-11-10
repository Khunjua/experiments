const DAY = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime();
}

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

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  const fail = (reason) => ({ ok: false, reason });

  function expire(date) {
    for (const book of books.values()) {
      while (!book.loan && book.queue.length > 0 && book.readyUntil !== null && date > book.readyUntil) {
        const mid = book.queue.shift();
        const m = members.get(mid);
        if (m) m.holds = m.holds.filter((b) => b !== book.id);
        if (book.queue.length > 0) {
          book.readyUntil = addDays(book.readyUntil, 8);
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns null on failure (clock-related), else the date string.
  function tick(args) {
    if (args === null || typeof args !== 'object') return null;
    const ms = parseDate(args.date);
    if (ms === null) return null;
    if (current !== null && args.date < current) return null;
    current = args.date;
    expire(args.date);
    return args.date;
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object') return fail('args');
      const { bookId } = args;
      if (!validId(bookId) || books.has(bookId)) return fail('invalid');
      books.set(bookId, { id: bookId, loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      if (args === null || typeof args !== 'object') return fail('args');
      const { memberId } = args;
      if (!validId(memberId) || members.has(memberId)) return fail('invalid');
      members.set(memberId, { id: memberId, loans: [], owed: 0, holds: [] });
      return { ok: true };
    },

    borrow(args) {
      const date = tick(args);
      if (date === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (b.queue.length > 0 && b.queue[0] !== memberId) return fail('set aside');
      if (m.loans.length >= 5) return fail('limit');
      for (const lb of m.loans) {
        if (books.get(lb).loan.dueDate < date) return fail('overdue');
      }
      if (m.owed >= 1000) return fail('owed');
      if (b.queue.length > 0) {
        b.queue.shift();
        m.holds = m.holds.filter((x) => x !== bookId);
        b.readyUntil = null;
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate };
    },

    returnBook(args) {
      const date = tick(args);
      if (date === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      const daysLate = Math.max(0, Math.round((parseDate(date) - parseDate(b.loan.dueDate)) / DAY));
      const fine = Math.min(500, 25 * Math.max(0, daysLate - 2));
      m.owed += fine;
      b.loan = null;
      m.loans = m.loans.filter((x) => x !== bookId);
      if (b.queue.length > 0) b.readyUntil = addDays(date, 7);
      else b.readyUntil = null;
      return { ok: true, fine };
    },

    renew(args) {
      const date = tick(args);
      if (date === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      if (b.loan.renewals >= 2) return fail('max renewals');
      if (date > b.loan.dueDate) return fail('overdue');
      if (b.queue.length > 0) return fail('holds');
      b.loan.dueDate = addDays(date, 21);
      b.loan.renewals += 1;
      return { ok: true, dueDate: b.loan.dueDate };
    },

    placeHold(args) {
      const date = tick(args);
      if (date === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && b.queue.length === 0) return fail('available');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.queue.includes(memberId)) return fail('already held');
      if (m.holds.length >= 5) return fail('hold limit');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      const date = tick(args);
      if (date === null) return fail('date');
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
      const date = tick(args);
      if (date === null) return fail('date');
      const { memberId } = args;
      if (!validId(memberId)) return fail('id');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      return {
        ok: true,
        loans: m.loans.map((bid) => ({ bookId: bid, dueDate: books.get(bid).loan.dueDate })),
        owed: m.owed,
        holds: m.holds.map((bid) => {
          const b = books.get(bid);
          const idx = b.queue.indexOf(memberId);
          return {
            bookId: bid,
            position: idx + 1,
            readyUntil: idx === 0 && !b.loan ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}
