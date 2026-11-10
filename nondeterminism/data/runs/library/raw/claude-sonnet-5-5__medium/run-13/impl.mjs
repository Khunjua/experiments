export function createLibrary() {
  const LOAN_DAYS = 21;
  const MAX_RENEWALS = 2;
  const FINE_PER_DAY = 25;
  const FINE_CAP = 1000;
  const BLOCK_OWED = 500;
  const PICKUP_DAYS = 7;

  const books = new Map();
  const members = new Map();

  const parse = (s) => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d);
    const dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return t / 86400000;
  };
  const fmt = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const add = (s, n) => fmt(parse(s) + n);
  const fail = (reason) => ({ ok: false, reason });

  function advance(date) {
    for (const b of books.values()) {
      while (b.ready && parse(date) > parse(b.ready.until)) {
        const prevUntil = b.ready.until;
        b.queue.shift();
        b.ready = b.queue.length ? { member: b.queue[0], until: add(prevUntil, PICKUP_DAYS) } : null;
      }
    }
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return fail('invalid');
      books.set(bookId, { loan: null, queue: [], ready: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return fail('invalid');
      members.set(memberId, { loans: [], owed: 0 });
      return { ok: true };
    },
    borrow({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (m.owed >= BLOCK_OWED) return fail('owes');
      if (b.loan) return fail('out');
      if (b.ready && b.ready.member !== memberId) return fail('reserved');
      if (b.ready) {
        b.queue.shift();
        b.ready = null;
      }
      const due = add(date, LOAN_DAYS);
      b.loan = { memberId, dueDate: due, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate: due };
    },
    returnBook({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      const late = parse(date) - parse(b.loan.dueDate);
      const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;
      m.owed += fine;
      m.loans = m.loans.filter((x) => x !== bookId);
      b.loan = null;
      if (b.queue.length) b.ready = { member: b.queue[0], until: add(date, PICKUP_DAYS) };
      return { ok: true, fine };
    },
    renew({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan || b.loan.memberId !== memberId) return fail('not borrowed');
      if (b.loan.renewals >= MAX_RENEWALS) return fail('limit');
      if (b.queue.length) return fail('held');
      if (parse(date) > parse(b.loan.dueDate)) return fail('overdue');
      if (m.owed >= BLOCK_OWED) return fail('owes');
      b.loan.renewals++;
      b.loan.dueDate = add(date, LOAN_DAYS);
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold({ memberId, bookId, date } = {}) {
      if (parse(date) === null) return fail('date');
      advance(date);
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return fail('unknown');
      if (!b.loan && !b.ready) return fail('available');
      if (b.loan && b.loan.memberId === memberId) return fail('own loan');
      if (b.queue.includes(memberId)) return fail('duplicate');
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },
    payFine({ memberId, amount, date } = {}) {
      if (parse(date) === null) return fail('date');
      advance(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return fail('amount');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember({ memberId, date } = {}) {
      if (parse(date) === null) return fail('date');
      advance(date);
      const m = members.get(memberId);
      if (!m) return fail('unknown');
      const loans = m.loans.map((id) => ({ bookId: id, dueDate: books.get(id).loan.dueDate }));
      const holds = [];
      for (const [id, b] of books) {
        const i = b.queue.indexOf(memberId);
        if (i >= 0) {
          holds.push({
            bookId: id,
            position: i + 1,
            readyUntil: b.ready && b.ready.member === memberId ? b.ready.until : null,
          });
        }
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
