export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  const isId = (v) => typeof v === 'string' && v.length > 0;

  function parse(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
    const dt = new Date(0);
    dt.setUTCFullYear(y, m - 1, d);
    dt.setUTCHours(0, 0, 0, 0);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return Math.round(dt.getTime() / 86400000);
  }

  function fmt(n) {
    const dt = new Date(n * 86400000);
    const y = dt.getUTCFullYear();
    const ys = y >= 0 && y <= 9999 ? String(y).padStart(4, '0') : String(y);
    return ys + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
  }

  const fail = (reason) => ({ ok: false, reason });

  function removeFrom(arr, v) {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1);
  }

  function expire(day) {
    for (const [bookId, b] of books) {
      while (b.loanedTo === null && b.queue.length > 0 && b.readyUntil !== null && day > b.readyUntil) {
        const mid = b.queue.shift();
        removeFrom(members.get(mid).holds, bookId);
        if (b.queue.length > 0) b.readyUntil = b.readyUntil + 8;
        else b.readyUntil = null;
      }
    }
  }

  // Validates the argument object and date, advances the clock, expires holds.
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    const day = parse(args.date);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    expire(day);
    return day;
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object') return fail('args');
      const id = args.bookId;
      if (!isId(id) || books.has(id)) return fail('invalid');
      books.set(id, { loanedTo: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(args) {
      if (args === null || typeof args !== 'object') return fail('args');
      const id = args.memberId;
      if (!isId(id) || members.has(id)) return fail('invalid');
      members.set(id, { loans: [], holds: [], owed: 0 });
      return { ok: true };
    },
    borrow(args) {
      const day = begin(args);
      if (day === null) return fail('args');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loanedTo !== null) return fail('on loan');
      if (b.queue.length > 0 && b.queue[0] !== memberId) return fail('set aside');
      if (m.loans.length >= 5) return fail('limit');
      if (m.loans.some((l) => l.due < day)) return fail('overdue');
      if (m.owed >= 1000) return fail('owed');
      if (b.queue.length > 0) {
        b.queue.shift();
        removeFrom(m.holds, bookId);
        b.readyUntil = null;
      }
      const due = day + 21;
      m.loans.push({ bookId, due, renewals: 0 });
      b.loanedTo = memberId;
      return { ok: true, dueDate: fmt(due) };
    },
    returnBook(args) {
      const day = begin(args);
      if (day === null) return fail('args');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loanedTo !== memberId) return fail('not loaned');
      const idx = m.loans.findIndex((l) => l.bookId === bookId);
      const loan = m.loans[idx];
      const late = Math.max(0, day - loan.due);
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      m.loans.splice(idx, 1);
      b.loanedTo = null;
      b.readyUntil = b.queue.length > 0 ? day + 7 : null;
      return { ok: true, fine };
    },
    renew(args) {
      const day = begin(args);
      if (day === null) return fail('args');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loanedTo !== memberId) return fail('not loaned');
      const loan = m.loans.find((l) => l.bookId === bookId);
      if (loan.renewals >= 2) return fail('max renewals');
      if (day > loan.due) return fail('overdue');
      if (b.queue.length > 0) return fail('holds');
      loan.due = day + 21;
      loan.renewals++;
      return { ok: true, dueDate: fmt(loan.due) };
    },
    placeHold(args) {
      const day = begin(args);
      if (day === null) return fail('args');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loanedTo === null && b.queue.length === 0) return fail('available');
      if (b.loanedTo === memberId) return fail('own loan');
      if (b.queue.includes(memberId)) return fail('duplicate');
      if (m.holds.length >= 5) return fail('limit');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },
    payFine(args) {
      const day = begin(args);
      if (day === null) return fail('args');
      const { memberId, amount } = args;
      if (!isId(memberId)) return fail('id');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail('amount');
      if (amount > m.owed) return fail('overpay');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember(args) {
      const day = begin(args);
      if (day === null) return fail('args');
      const { memberId } = args;
      if (!isId(memberId)) return fail('id');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      return {
        ok: true,
        loans: m.loans.map((l) => ({ bookId: l.bookId, dueDate: fmt(l.due) })),
        owed: m.owed,
        holds: m.holds.map((bookId) => {
          const b = books.get(bookId);
          const pos = b.queue.indexOf(memberId);
          const ready = pos === 0 && b.loanedTo === null && b.readyUntil !== null;
          return { bookId, position: pos + 1, readyUntil: ready ? fmt(b.readyUntil) : null };
        }),
      };
    },
  };
}
