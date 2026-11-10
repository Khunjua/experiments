const DAY = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY);
}

function fmt(n) {
  const t = new Date(n * DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const validId = (x) => typeof x === 'string' && x.length > 0;
const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // id -> { loan: {memberId, due, renewals, seq}|null, queue: [memberId], readyUntil: number|null }
  const members = new Map(); // id -> { owed, loans: [bookId], holds: [bookId] }
  let current = null;

  function expire(day) {
    for (const b of books.values()) {
      while (b.readyUntil !== null && day > b.readyUntil) {
        const mid = b.queue.shift();
        const m = members.get(mid);
        const idx = m.holds.indexOf(b.id);
        if (idx >= 0) m.holds.splice(idx, 1);
        if (b.queue.length > 0) b.readyUntil = b.readyUntil + 1 + 7;
        else b.readyUntil = null;
      }
    }
  }

  // common dated-call prologue
  function begin(args, needBook, needMember) {
    if (args === null || typeof args !== 'object') return FAIL('args');
    const day = parseDate(args.date);
    if (day === null) return FAIL('date');
    if (needMember && !validId(args.memberId)) return FAIL('member');
    if (needBook && !validId(args.bookId)) return FAIL('book');
    if (current !== null && day < current) return FAIL('past');
    current = day;
    expire(day);
    return { day };
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object') return FAIL('args');
      const id = args.bookId;
      if (!validId(id) || books.has(id)) return FAIL('invalid');
      books.set(id, { id, loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember(args) {
      if (args === null || typeof args !== 'object') return FAIL('args');
      const id = args.memberId;
      if (!validId(id) || members.has(id)) return FAIL('invalid');
      members.set(id, { owed: 0, loans: [], holds: [] });
      return { ok: true };
    },
    borrow(args) {
      const r = begin(args, true, true);
      if (r.ok === false) return r;
      const { day } = r;
      const m = members.get(args.memberId), b = books.get(args.bookId);
      if (!m || !b) return FAIL('unknown');
      if (b.loan) return FAIL('onloan');
      if (b.readyUntil !== null && b.queue[0] !== args.memberId) return FAIL('setaside');
      if (m.loans.length >= 5) return FAIL('max');
      if (m.owed >= 1000) return FAIL('owed');
      for (const bid of m.loans) if (books.get(bid).loan.due < day) return FAIL('overdue');
      if (b.readyUntil !== null) {
        b.queue.shift();
        b.readyUntil = null;
        const i = m.holds.indexOf(b.id);
        if (i >= 0) m.holds.splice(i, 1);
      }
      const due = day + 21;
      b.loan = { memberId: args.memberId, due, renewals: 0 };
      m.loans.push(b.id);
      return { ok: true, dueDate: fmt(due) };
    },
    returnBook(args) {
      const r = begin(args, true, true);
      if (r.ok === false) return r;
      const { day } = r;
      const m = members.get(args.memberId), b = books.get(args.bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan || b.loan.memberId !== args.memberId) return FAIL('notloan');
      const late = Math.max(0, day - b.loan.due);
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      b.loan = null;
      m.loans.splice(m.loans.indexOf(b.id), 1);
      if (b.queue.length > 0) b.readyUntil = day + 7;
      else b.readyUntil = null;
      return { ok: true, fine };
    },
    renew(args) {
      const r = begin(args, true, true);
      if (r.ok === false) return r;
      const { day } = r;
      const m = members.get(args.memberId), b = books.get(args.bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan || b.loan.memberId !== args.memberId) return FAIL('notloan');
      if (b.loan.renewals >= 2) return FAIL('maxrenew');
      if (day > b.loan.due) return FAIL('overdue');
      if (b.queue.length > 0) return FAIL('holds');
      b.loan.due = day + 21;
      b.loan.renewals++;
      return { ok: true, dueDate: fmt(b.loan.due) };
    },
    placeHold(args) {
      const r = begin(args, true, true);
      if (r.ok === false) return r;
      const m = members.get(args.memberId), b = books.get(args.bookId);
      if (!m || !b) return FAIL('unknown');
      if (!b.loan && b.readyUntil === null) return FAIL('available');
      if (b.loan && b.loan.memberId === args.memberId) return FAIL('own');
      if (b.queue.includes(args.memberId)) return FAIL('dup');
      if (m.holds.length >= 5) return FAIL('maxholds');
      b.queue.push(args.memberId);
      m.holds.push(b.id);
      return { ok: true, position: b.queue.length };
    },
    payFine(args) {
      if (args === null || typeof args !== 'object') return FAIL('args');
      const amt = args.amount;
      const day = parseDate(args.date);
      if (day === null || !validId(args.memberId)) return FAIL('invalid');
      if (!Number.isSafeInteger(amt) || amt <= 0) return FAIL('amount');
      if (current !== null && day < current) return FAIL('past');
      current = day;
      expire(day);
      const m = members.get(args.memberId);
      if (!m) return FAIL('unknown');
      if (amt > m.owed) return FAIL('over');
      m.owed -= amt;
      return { ok: true, owed: m.owed };
    },
    getMember(args) {
      if (args === null || typeof args !== 'object') return FAIL('args');
      const day = parseDate(args.date);
      if (day === null || !validId(args.memberId)) return FAIL('invalid');
      if (current !== null && day < current) return FAIL('past');
      current = day;
      expire(day);
      const m = members.get(args.memberId);
      if (!m) return FAIL('unknown');
      return {
        ok: true,
        loans: m.loans.map((bid) => ({ bookId: bid, dueDate: fmt(books.get(bid).loan.due) })),
        owed: m.owed,
        holds: m.holds.map((bid) => {
          const b = books.get(bid);
          const pos = b.queue.indexOf(args.memberId);
          return {
            bookId: bid,
            position: pos + 1,
            readyUntil: pos === 0 && b.readyUntil !== null ? fmt(b.readyUntil) : null,
          };
        }),
      };
    },
  };
}
