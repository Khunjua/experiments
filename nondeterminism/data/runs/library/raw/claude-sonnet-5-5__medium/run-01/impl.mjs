const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const PICKUP_DAYS = 3;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 500;

function toDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  return Number.isNaN(t) ? null : Math.round(t / 86400000);
}
function toStr(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map(); // bookId -> { loan: {memberId, due, renewals}|null, queue: [memberId], readyUntil: day|null }
  const members = new Map(); // memberId -> { owed, loans: Set<bookId> }

  function process(day) {
    for (const b of books.values()) {
      while (b.readyUntil !== null && b.readyUntil < day) {
        b.queue.shift();
        if (b.queue.length > 0 && !b.loan) {
          b.readyUntil = b.readyUntil + 1 + PICKUP_DAYS;
        } else {
          b.readyUntil = null;
        }
      }
    }
  }

  function prep(args) {
    if (!args) return null;
    const day = toDay(args.date);
    if (day === null) return null;
    process(day);
    return day;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null || books.has(bookId)) return { ok: false };
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },
    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null || members.has(memberId)) return { ok: false };
      members.set(memberId, { owed: 0, loans: new Set() });
      return { ok: true };
    },
    borrow(args) {
      const day = prep(args);
      if (day === null) return { ok: false };
      const { memberId, bookId } = args;
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || b.loan) return { ok: false };
      if (m.loans.size >= MAX_LOANS || m.owed >= BORROW_BLOCK_OWED) return { ok: false };
      for (const id of m.loans) {
        if (books.get(id).loan.due < day) return { ok: false };
      }
      if (b.queue.length > 0) {
        if (b.readyUntil === null || b.queue[0] !== memberId) return { ok: false };
        b.queue.shift();
        b.readyUntil = null;
      }
      const due = day + LOAN_DAYS;
      b.loan = { memberId, due, renewals: 0 };
      m.loans.add(bookId);
      return { ok: true, dueDate: toStr(due) };
    },
    returnBook(args) {
      const day = prep(args);
      if (day === null) return { ok: false };
      const { memberId, bookId } = args;
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      const late = Math.max(0, day - b.loan.due);
      const fine = Math.min(FINE_CAP, late * FINE_PER_DAY);
      m.owed += fine;
      m.loans.delete(bookId);
      b.loan = null;
      if (b.queue.length > 0) b.readyUntil = day + PICKUP_DAYS;
      return { ok: true, fine };
    },
    renew(args) {
      const day = prep(args);
      if (day === null) return { ok: false };
      const { memberId, bookId } = args;
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== memberId) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (day > b.loan.due) return { ok: false };
      if (b.queue.length > 0) return { ok: false };
      b.loan.renewals++;
      b.loan.due = day + LOAN_DAYS;
      return { ok: true, dueDate: toStr(b.loan.due) };
    },
    placeHold(args) {
      const day = prep(args);
      if (day === null) return { ok: false };
      const { memberId, bookId } = args;
      const m = members.get(memberId), b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.loan && b.loan.memberId === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      if (!b.loan && b.queue.length === 0) return { ok: false };
      b.queue.push(memberId);
      return { ok: true, position: b.queue.length };
    },
    payFine(args) {
      const day = prep(args);
      if (day === null) return { ok: false };
      const { memberId, amount } = args;
      const m = members.get(memberId);
      if (!m || !Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },
    getMember(args) {
      const day = prep(args);
      const m = args ? members.get(args.memberId) : undefined;
      if (!m) return { loans: [], owed: 0, holds: [] };
      const loans = [];
      for (const id of m.loans) loans.push({ bookId: id, dueDate: toStr(books.get(id).loan.due) });
      const holds = [];
      for (const [id, b] of books) {
        const i = b.queue.indexOf(args.memberId);
        if (i < 0) continue;
        holds.push({
          bookId: id,
          position: i + 1,
          readyUntil: i === 0 && b.readyUntil !== null ? toStr(b.readyUntil) : null,
        });
      }
      return { loans, owed: m.owed, holds };
    },
  };
}
