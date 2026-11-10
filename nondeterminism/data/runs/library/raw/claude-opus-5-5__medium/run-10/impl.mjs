const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const GRACE_DAYS = 1;
const PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDay(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

function fromDay(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function isId(x) {
  return (typeof x === 'string' && x.length > 0) || (typeof x === 'number' && Number.isFinite(x));
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals} | null, queue: [{memberId, readyUntil}] }
  const members = new Map(); // memberId -> { owed }
  const fail = (reason) => ({ ok: false, reason });

  function setAsideNext(book, startDay) {
    if (book.queue.length > 0) book.queue[0].readyUntil = startDay + PICKUP_DAYS;
  }

  function advance(today) {
    for (const book of books.values()) {
      while (book.queue.length > 0 && book.queue[0].readyUntil !== null && book.queue[0].readyUntil < today) {
        const expired = book.queue.shift();
        setAsideNext(book, expired.readyUntil + 1);
      }
    }
  }

  function prep(memberId, bookId, date) {
    const day = toDay(date);
    if (day === null) return { err: fail('invalid date') };
    advance(day);
    const member = members.get(memberId);
    if (!member) return { err: fail('unknown member') };
    if (bookId === undefined) return { day, member };
    const book = books.get(bookId);
    if (!book) return { err: fail('unknown book') };
    return { day, member, book };
  }

  return {
    addBook({ bookId } = {}) {
      if (!isId(bookId) || books.has(bookId)) return fail('invalid or duplicate book');
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!isId(memberId) || members.has(memberId)) return fail('invalid or duplicate member');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId ?? null, date);
      if (p.err) return p.err;
      const { day, book } = p;
      if (book.loan) return fail('book is on loan');
      if (book.queue.length > 0) {
        const first = book.queue[0];
        if (first.memberId !== memberId || first.readyUntil === null) return fail('book is set aside for another member');
        book.queue.shift();
      }
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      return { ok: true, dueDate: fromDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId ?? null, date);
      if (p.err) return p.err;
      const { day, member, book } = p;
      if (!book.loan || book.loan.memberId !== memberId) return fail('member does not have this book');
      const late = day - book.loan.due;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      member.owed += fine;
      book.loan = null;
      setAsideNext(book, day);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId ?? null, date);
      if (p.err) return p.err;
      const { day, book } = p;
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('member does not have this book');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.queue.length > 0) return fail('others are waiting');
      if (day > loan.due) return fail('loan is overdue');
      loan.due = loan.due + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: fromDay(loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const p = prep(memberId, bookId ?? null, date);
      if (p.err) return p.err;
      const { book } = p;
      if (!book.loan && book.queue.length === 0) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member already has this book');
      if (book.queue.some((h) => h.memberId === memberId)) return fail('already holding');
      book.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const p = prep(memberId, undefined, date);
      if (p.err) return p.err;
      const { member } = p;
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('amount exceeds owed');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const p = prep(memberId, undefined, date);
      if (p.err) return p.err;
      const { member } = p;
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: fromDay(book.loan.due) });
        }
        const idx = book.queue.findIndex((h) => h.memberId === memberId);
        if (idx >= 0) {
          const h = book.queue[idx];
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: h.readyUntil === null ? null : fromDay(h.readyUntil),
          });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
