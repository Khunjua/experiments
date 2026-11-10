export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  const DAY = 86400000;
  function toDays(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (y < 1 || y > 9999) return null;
    const dt = new Date(0);
    dt.setUTCFullYear(y, m - 1, d);
    dt.setUTCHours(0, 0, 0, 0);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return Math.round(dt.getTime() / DAY);
  }
  function fromDays(n) {
    const dt = new Date(n * DAY);
    const p = (x, l) => String(x).padStart(l, '0');
    return p(dt.getUTCFullYear(), 4) + '-' + p(dt.getUTCMonth() + 1, 2) + '-' + p(dt.getUTCDate(), 2);
  }
  function add(s, n) { return fromDays(toDays(s) + n); }
  const validId = (x) => typeof x === 'string' && x.length > 0;
  const FAIL = (reason) => ({ ok: false, reason });

  function expire(date) {
    for (const b of books.values()) {
      if (b.state !== 'aside') continue;
      while (b.state === 'aside' && date > b.readyUntil) {
        const mid = b.queue.shift();
        const m = members.get(mid);
        if (m) m.holds = m.holds.filter((x) => x !== b.id);
        if (b.queue.length > 0) {
          b.readyUntil = add(b.readyUntil, 8);
        } else {
          b.state = 'available';
          b.readyUntil = null;
        }
      }
    }
  }

  // returns date string if call is acceptable clock-wise, else null
  function begin(args) {
    if (args === null || typeof args !== 'object') return null;
    const d = args.date;
    if (toDays(d) === null) return null;
    if (current !== null && d < current) return null;
    current = d;
    expire(d);
    return d;
  }

  return {
    addBook(a) {
      if (!a || typeof a !== 'object' || !validId(a.bookId)) return FAIL('invalid');
      if (books.has(a.bookId)) return FAIL('exists');
      books.set(a.bookId, { id: a.bookId, state: 'available', loanMember: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(a) {
      if (!a || typeof a !== 'object' || !validId(a.memberId)) return FAIL('invalid');
      if (members.has(a.memberId)) return FAIL('exists');
      members.set(a.memberId, { id: a.memberId, loans: [], owed: 0, holds: [] });
      return { ok: true };
    },
    borrow(a) {
      const date = begin(a);
      if (date === null) return FAIL('date');
      if (!validId(a.memberId) || !validId(a.bookId)) return FAIL('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.state === 'loan') return FAIL('on loan');
      if (b.state === 'aside' && b.queue[0] !== m.id) return FAIL('set aside');
      if (m.loans.length >= 5) return FAIL('limit');
      if (m.loans.some((l) => l.dueDate < date)) return FAIL('overdue');
      if (m.owed >= 1000) return FAIL('owed');
      if (b.state === 'aside') {
        b.queue.shift();
        m.holds = m.holds.filter((x) => x !== b.id);
        b.readyUntil = null;
      }
      const dueDate = add(date, 21);
      m.loans.push({ bookId: b.id, dueDate, renewals: 0 });
      b.state = 'loan';
      b.loanMember = m.id;
      return { ok: true, dueDate };
    },
    returnBook(a) {
      const date = begin(a);
      if (date === null) return FAIL('date');
      if (!validId(a.memberId) || !validId(a.bookId)) return FAIL('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.state !== 'loan' || b.loanMember !== m.id) return FAIL('not loaned');
      const idx = m.loans.findIndex((l) => l.bookId === b.id);
      if (idx < 0) return FAIL('not loaned');
      const loan = m.loans[idx];
      const late = Math.max(0, toDays(date) - toDays(loan.dueDate));
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      m.loans.splice(idx, 1);
      b.loanMember = null;
      if (b.queue.length === 0) {
        b.state = 'available';
        b.readyUntil = null;
      } else {
        b.state = 'aside';
        b.readyUntil = add(date, 7);
      }
      return { ok: true, fine };
    },
    renew(a) {
      const date = begin(a);
      if (date === null) return FAIL('date');
      if (!validId(a.memberId) || !validId(a.bookId)) return FAIL('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.state !== 'loan' || b.loanMember !== m.id) return FAIL('not loaned');
      const loan = m.loans.find((l) => l.bookId === b.id);
      if (!loan) return FAIL('not loaned');
      if (loan.renewals >= 2) return FAIL('max renewals');
      if (date > loan.dueDate) return FAIL('overdue');
      if (b.queue.length > 0) return FAIL('holds');
      loan.dueDate = add(date, 21);
      loan.renewals++;
      return { ok: true, dueDate: loan.dueDate };
    },
    placeHold(a) {
      const date = begin(a);
      if (date === null) return FAIL('date');
      if (!validId(a.memberId) || !validId(a.bookId)) return FAIL('invalid');
      const m = members.get(a.memberId), b = books.get(a.bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.state === 'available') return FAIL('available');
      if (b.state === 'loan' && b.loanMember === m.id) return FAIL('own loan');
      if (b.queue.includes(m.id)) return FAIL('duplicate');
      if (m.holds.length >= 5) return FAIL('limit');
      b.queue.push(m.id);
      m.holds.push(b.id);
      return { ok: true, position: b.queue.length };
    },
    payFine(a) {
      const date = begin(a);
      if (date === null) return FAIL('date');
      if (!validId(a.memberId)) return FAIL('invalid');
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return FAIL('amount');
      const m = members.get(a.memberId);
      if (!m) return FAIL('unknown');
      if (a.amount > m.owed) return FAIL('overpay');
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },
    getMember(a) {
      const date = begin(a);
      if (date === null) return FAIL('date');
      if (!validId(a.memberId)) return FAIL('invalid');
      const m = members.get(a.memberId);
      if (!m) return FAIL('unknown');
      return {
        ok: true,
        loans: m.loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate })),
        owed: m.owed,
        holds: m.holds.map((bid) => {
          const b = books.get(bid);
          const i = b.queue.indexOf(m.id);
          return {
            bookId: bid,
            position: i + 1,
            readyUntil: b.state === 'aside' && i === 0 ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}
