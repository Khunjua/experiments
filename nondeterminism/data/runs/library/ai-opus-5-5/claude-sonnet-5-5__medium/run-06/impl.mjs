export function createLibrary() {
  const books = new Map(); // bookId -> { loan: {memberId,...}|null, queue: [], readyUntil: number|null }
  const members = new Map(); // memberId -> { loans: [], owed, holds: [bookId] }
  let current = null;

  const DAY = 86400000;

  function validId(x) {
    return typeof x === 'string' && x.length > 0;
  }
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
    if (y < 1 || y > 9999) return null;
    const p = (v, w) => String(v).padStart(w, '0');
    return `${p(y, 4)}-${p(dt.getUTCMonth() + 1, 2)}-${p(dt.getUTCDate(), 2)}`;
  }

  function expire(now) {
    for (const b of books.values()) {
      while (!b.loan && b.readyUntil !== null && now > b.readyUntil) {
        const mid = b.queue.shift();
        removeMemberHold(mid, b.id);
        if (b.queue.length > 0) {
          b.readyUntil = b.readyUntil + 8;
        } else {
          b.readyUntil = null;
        }
      }
    }
  }
  function removeMemberHold(mid, bookId) {
    const m = members.get(mid);
    if (!m) return;
    const i = m.holds.indexOf(bookId);
    if (i >= 0) m.holds.splice(i, 1);
  }

  // Common prologue: returns date number or null (fail). Advances clock and expires.
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    const d = parseDate(args.date);
    if (d === null) return null;
    if (current !== null && d < current) return null;
    current = d;
    expire(d);
    return d;
  }

  const fail = (reason) => ({ ok: false, reason });

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object') return fail('args');
      const id = args.bookId;
      if (!validId(id) || books.has(id)) return fail('invalid');
      books.set(id, { id, loan: null, queue: [], readyUntil: null });
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
      const d = begin(args);
      if (d === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('on loan');
      if (b.queue.length > 0 && b.queue[0] !== memberId) return fail('set aside');
      if (m.loans.length >= 5) return fail('limit');
      if (m.loans.some((l) => l.dueDate < d)) return fail('overdue');
      if (m.owed >= 1000) return fail('owed');
      const due = fmt(d + 21);
      if (due === null) return fail('range');
      if (b.queue.length > 0 && b.queue[0] === memberId) {
        b.queue.shift();
        b.readyUntil = null;
        removeMemberHold(memberId, bookId);
      }
      const loan = { bookId, dueDate: d + 21, renewals: 0 };
      m.loans.push(loan);
      b.loan = { memberId, loan };
      return { ok: true, dueDate: due };
    },
    returnBook(args) {
      const d = begin(args);
      if (d === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      const loan = b.loan.loan;
      const late = Math.max(0, d - loan.dueDate);
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      m.loans.splice(m.loans.indexOf(loan), 1);
      b.loan = null;
      b.readyUntil = b.queue.length > 0 ? d + 7 : null;
      return { ok: true, fine };
    },
    renew(args) {
      const d = begin(args);
      if (d === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      const loan = b.loan.loan;
      if (loan.renewals >= 2) return fail('max renewals');
      if (d > loan.dueDate) return fail('overdue');
      if (b.queue.length > 0) return fail('holds');
      const due = fmt(d + 21);
      if (due === null) return fail('range');
      loan.dueDate = d + 21;
      loan.renewals++;
      return { ok: true, dueDate: due };
    },
    placeHold(args) {
      const d = begin(args);
      if (d === null) return fail('date');
      const { memberId, bookId } = args;
      if (!validId(memberId) || !validId(bookId)) return fail('id');
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && b.queue.length === 0) return fail('available');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.queue.includes(memberId)) return fail('duplicate');
      if (m.holds.length >= 5) return fail('limit');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },
    payFine(args) {
      const d = begin(args);
      if (d === null) return fail('date');
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
      const d = begin(args);
      if (d === null) return fail('date');
      const { memberId } = args;
      if (!validId(memberId)) return fail('id');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      return {
        ok: true,
        loans: m.loans.map((l) => ({ bookId: l.bookId, dueDate: fmt(l.dueDate) })),
        owed: m.owed,
        holds: m.holds.map((bid) => {
          const b = books.get(bid);
          const pos = b.queue.indexOf(memberId) + 1;
          const ready = !b.loan && pos === 1 && b.readyUntil !== null;
          return { bookId: bid, position: pos, readyUntil: ready ? fmt(b.readyUntil) : null };
        }),
      };
    },
  };
}
