const DAY = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.getTime();
}

function fmt(ms) {
  const t = new Date(ms);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return fmt(parseDate(s) + n * DAY);
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

export function createLibrary() {
  const books = new Map(); // id -> {loan: {memberId, dueDate, renewals}|null, queue: [memberId], readyUntil: string|null}
  const members = new Map(); // id -> {loans: [bookId], owed, holds: [bookId]}
  let current = null;

  const fail = (reason) => ({ ok: false, reason });

  function expire(date) {
    for (const [, b] of books) {
      if (b.loan || b.queue.length === 0 || b.readyUntil === null) continue;
      while (b.readyUntil !== null && date > b.readyUntil) {
        const prev = b.readyUntil;
        const mid = b.queue.shift();
        const mem = members.get(mid);
        void mem;
        if (b.queue.length > 0) {
          b.readyUntil = addDays(prev, 8);
        } else {
          b.readyUntil = null;
        }
      }
    }
  }

  // Common prelude for dated calls. Returns null on success or a failure.
  function begin(args, needBook, needMember) {
    if (args === null || typeof args !== 'object') return fail('args');
    const { memberId, bookId, date } = args;
    if (parseDate(date) === null) return fail('date');
    if (current !== null && date < current) return fail('past');
    current = date;
    expire(date);
    if (needMember && !validId(memberId)) return fail('member');
    if (needBook && !validId(bookId)) return fail('book');
    return null;
  }

  function holdsOf(memberId) {
    const res = [];
    for (const bid of members.get(memberId).holds) res.push(bid);
    return res;
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object') return fail('args');
      const { bookId } = args;
      if (!validId(bookId) || books.has(bookId)) return fail('book');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(args) {
      if (args === null || typeof args !== 'object') return fail('args');
      const { memberId } = args;
      if (!validId(memberId) || members.has(memberId)) return fail('member');
      members.set(memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },
    borrow(args) {
      const f = begin(args, true, true);
      if (f) return f;
      const { memberId, bookId, date } = args;
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (b.loan) return fail('onloan');
      const setAside = b.queue.length > 0 && b.readyUntil !== null;
      if (setAside && b.queue[0] !== memberId) return fail('setaside');
      if (m.loans.length >= 5) return fail('limit');
      for (const bid of m.loans) if (books.get(bid).loan.dueDate < date) return fail('overdue');
      if (m.owed >= 1000) return fail('owed');
      if (setAside) {
        b.queue.shift();
        b.readyUntil = null;
        m.holds.splice(m.holds.indexOf(bookId), 1);
      }
      const dueDate = addDays(date, 21);
      b.loan = { memberId, dueDate, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate };
    },
    returnBook(args) {
      const f = begin(args, true, true);
      if (f) return f;
      const { memberId, bookId, date } = args;
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('notloan');
      const late = Math.max(0, Math.round((parseDate(date) - parseDate(b.loan.dueDate)) / DAY));
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      m.loans.splice(m.loans.indexOf(bookId), 1);
      b.loan = null;
      b.readyUntil = b.queue.length > 0 ? addDays(date, 7) : null;
      return { ok: true, fine };
    },
    renew(args) {
      const f = begin(args, true, true);
      if (f) return f;
      const { memberId, bookId, date } = args;
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('notloan');
      if (b.loan.renewals >= 2) return fail('max');
      if (date > b.loan.dueDate) return fail('overdue');
      if (b.queue.length > 0) return fail('holds');
      b.loan.dueDate = addDays(date, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold(args) {
      const f = begin(args, true, true);
      if (f) return f;
      const { memberId, bookId } = args;
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && b.queue.length === 0) return fail('available');
      if (b.loan && b.loan.memberId === memberId) return fail('own');
      if (b.queue.includes(memberId)) return fail('dup');
      if (m.holds.length >= 5) return fail('limit');
      b.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: b.queue.length };
    },
    payFine(args) {
      if (args === null || typeof args !== 'object') return fail('args');
      const { memberId, amount, date } = args;
      if (parseDate(date) === null) return fail('date');
      if (current !== null && date < current) return fail('past');
      current = date;
      expire(date);
      if (!validId(memberId)) return fail('member');
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail('amount');
      if (amount > m.owed) return fail('over');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember(args) {
      const f = begin(args, false, true);
      if (f) return f;
      const { memberId } = args;
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
            readyUntil: idx === 0 && !b.loan && b.readyUntil !== null ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}
