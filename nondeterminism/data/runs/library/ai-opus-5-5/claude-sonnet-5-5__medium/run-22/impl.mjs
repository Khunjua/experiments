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
    return Math.round(dt.getTime() / 86400000);
  }
  function fmt(days) {
    const dt = new Date(days * 86400000);
    const y = String(dt.getUTCFullYear()).padStart(4, '0');
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const fail = (reason) => ({ ok: false, reason });

  function removeHold(memberId, bookId) {
    const m = members.get(memberId);
    if (m) {
      const i = m.holds.indexOf(bookId);
      if (i >= 0) m.holds.splice(i, 1);
    }
  }

  function expire(day) {
    for (const [bookId, b] of books) {
      while (b.readyUntil !== null && day > b.readyUntil) {
        const first = b.queue.shift();
        removeHold(first, bookId);
        if (b.queue.length > 0) b.readyUntil = b.readyUntil + 1 + 7;
        else b.readyUntil = null;
      }
    }
  }

  // returns day number or null on failure
  function tick(args) {
    if (args === null || typeof args !== 'object') return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    expire(day);
    return day;
  }

  function isAvailable(b) {
    return b.holder === null && b.readyUntil === null;
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object') return fail('args');
      const id = args.bookId;
      if (!validId(id) || books.has(id)) return fail('invalid');
      books.set(id, { holder: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(args) {
      if (args === null || typeof args !== 'object') return fail('args');
      const id = args.memberId;
      if (!validId(id) || members.has(id)) return fail('invalid');
      members.set(id, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },
    borrow(args) {
      const day = tick(args);
      if (day === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.holder !== null) return fail('on loan');
      if (b.readyUntil !== null && b.queue[0] !== memberId) return fail('set aside');
      if (m.loans.length >= 5) return fail('limit');
      if (m.loans.some((l) => l.due < day)) return fail('overdue');
      if (m.owed >= 1000) return fail('owed');
      if (b.readyUntil !== null) {
        b.queue.shift();
        removeHold(memberId, bookId);
        b.readyUntil = null;
      }
      b.holder = memberId;
      const due = day + 21;
      m.loans.push({ bookId, due, renewals: 0 });
      return { ok: true, dueDate: fmt(due) };
    },
    returnBook(args) {
      const day = tick(args);
      if (day === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.holder !== memberId) return fail('not borrowed');
      const i = m.loans.findIndex((l) => l.bookId === bookId);
      if (i < 0) return fail('no loan');
      const loan = m.loans[i];
      const late = Math.max(0, day - loan.due);
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      m.loans.splice(i, 1);
      b.holder = null;
      b.readyUntil = b.queue.length > 0 ? day + 7 : null;
      return { ok: true, fine };
    },
    renew(args) {
      const day = tick(args);
      if (day === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.holder !== memberId) return fail('not borrowed');
      const loan = m.loans.find((l) => l.bookId === bookId);
      if (!loan) return fail('no loan');
      if (loan.renewals >= 2) return fail('max renewals');
      if (day > loan.due) return fail('overdue');
      if (b.queue.length > 0) return fail('holds');
      loan.due = day + 21;
      loan.renewals++;
      return { ok: true, dueDate: fmt(loan.due) };
    },
    placeHold(args) {
      const day = tick(args);
      if (day === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (isAvailable(b)) return fail('available');
      if (b.holder === memberId) return fail('on loan to member');
      if (b.queue.includes(memberId)) return fail('already held');
      if (m.holds.length >= 5) return fail('hold limit');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },
    payFine(args) {
      const day = tick(args);
      if (day === null) return fail('date');
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
      const day = tick(args);
      if (day === null) return fail('date');
      const { memberId } = args;
      if (!validId(memberId)) return fail('id');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      return {
        ok: true,
        loans: m.loans.map((l) => ({ bookId: l.bookId, dueDate: fmt(l.due) })),
        owed: m.owed,
        holds: m.holds.map((bookId) => {
          const b = books.get(bookId);
          const idx = b.queue.indexOf(memberId);
          return {
            bookId,
            position: idx + 1,
            readyUntil: idx === 0 && b.readyUntil !== null ? fmt(b.readyUntil) : null,
          };
        }),
      };
    },
  };
}
