const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const GRACE_DAYS = 1;
const MAX_LOANS = 5;
const BLOCKING_DEBT = 1000;
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

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals, order} | null, queue: [memberId], readyUntil: day|null }
  const members = new Map(); // memberId -> { owed }
  let loanCounter = 0;

  // Expire set-aside books whose pickup window has passed, passing them to the next in line.
  function advance(today) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && book.readyUntil < today) {
        const expiredAt = book.readyUntil;
        book.queue.shift();
        book.readyUntil = book.queue.length > 0 ? expiredAt + 1 + PICKUP_DAYS : null;
      }
    }
  }

  function loansOf(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) out.push({ bookId, ...book.loan });
    }
    out.sort((a, b) => a.order - b.order);
    return out;
  }

  function prepare(memberId, bookId, date, needBook = true) {
    const day = toDay(date);
    if (day === null) return { err: fail('invalid date') };
    if (!validId(memberId) || !members.has(memberId)) return { err: fail('unknown member') };
    if (needBook && (!validId(bookId) || !books.has(bookId))) return { err: fail('unknown book') };
    advance(day);
    return { day, member: members.get(memberId), book: needBook ? books.get(bookId) : null };
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId) || books.has(bookId)) return fail('invalid or duplicate book');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId) || members.has(memberId)) return fail('invalid or duplicate member');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const p = prepare(memberId, bookId, date);
      if (p.err) return p.err;
      const { day, member, book } = p;
      if (book.loan) return fail('book is on loan');
      if (book.readyUntil !== null && book.queue[0] !== memberId) return fail('book is set aside for another member');
      if (member.owed >= BLOCKING_DEBT) return fail('too much owed');
      if (loansOf(memberId).length >= MAX_LOANS) return fail('too many loans');
      if (book.readyUntil !== null) {
        book.queue.shift();
        book.readyUntil = null;
      } else {
        // Book on shelf with no set-aside: drop any stale hold this member may have (shouldn't exist)
        const i = book.queue.indexOf(memberId);
        if (i >= 0) book.queue.splice(i, 1);
      }
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0, order: loanCounter++ };
      return { ok: true, dueDate: fromDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const p = prepare(memberId, bookId, date);
      if (p.err) return p.err;
      const { day, member, book } = p;
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to this member');
      const late = day - book.loan.due - GRACE_DAYS;
      const fine = late > 0 ? Math.min((late + GRACE_DAYS) * FINE_PER_DAY, MAX_FINE_PER_LOAN) : 0;
      member.owed += fine;
      book.loan = null;
      if (book.queue.length > 0) book.readyUntil = day + PICKUP_DAYS;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const p = prepare(memberId, bookId, date);
      if (p.err) return p.err;
      const { day, member, book } = p;
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not on loan to this member');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.queue.length > 0) return fail('others are waiting');
      if (day > loan.due) return fail('overdue');
      if (member.owed >= BLOCKING_DEBT) return fail('too much owed');
      loan.due += LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: fromDay(loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const p = prepare(memberId, bookId, date);
      if (p.err) return p.err;
      const { book } = p;
      if (!book.loan && book.readyUntil === null) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member already has this book');
      if (book.queue.includes(memberId)) return fail('already holding');
      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const p = prepare(memberId, null, date, false);
      if (p.err) return p.err;
      const { member } = p;
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('amount exceeds amount owed');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const p = prepare(memberId, null, date, false);
      if (p.err) return p.err;
      const { member } = p;
      const loans = loansOf(memberId).map((l) => ({ bookId: l.bookId, dueDate: fromDay(l.due) }));
      const holds = [];
      for (const [bookId, book] of books) {
        const i = book.queue.indexOf(memberId);
        if (i < 0) continue;
        const setAside = i === 0 && book.readyUntil !== null;
        holds.push({ bookId, position: i + 1, readyUntil: setAside ? fromDay(book.readyUntil) : null });
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
