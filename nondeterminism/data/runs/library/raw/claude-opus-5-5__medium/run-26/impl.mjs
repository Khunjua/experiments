const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE_PER_LOAN = 500;
const MAX_LOANS = 5;
const BORROW_BLOCK_OWED = 1000;
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

const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  // book: { loan: {memberId, due, renewals} | null, queue: [memberId], readyFor: memberId|null, readyUntil: day|null }
  const books = new Map();
  // member: { owed, loans: [bookId] (borrow order), holds: [bookId] (placement order) }
  const members = new Map();

  function removeHoldFromMember(memberId, bookId) {
    const m = members.get(memberId);
    if (!m) return;
    const i = m.holds.indexOf(bookId);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function setAsideNext(book, startDay) {
    book.readyFor = null;
    book.readyUntil = null;
    if (book.queue.length > 0) {
      book.readyFor = book.queue[0];
      book.readyUntil = startDay + PICKUP_DAYS;
    }
  }

  function processBook(bookId, today) {
    const book = books.get(bookId);
    while (book.readyFor !== null && book.readyUntil < today) {
      const expired = book.queue.shift();
      removeHoldFromMember(expired, bookId);
      setAsideNext(book, book.readyUntil + 1);
    }
  }

  function processAll(today) {
    for (const id of books.keys()) processBook(id, today);
  }

  function lastDay() {
    return null;
  }
  void lastDay;

  return {
    addBook({ bookId } = {}) {
      if (!isId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, queue: [], readyFor: null, readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!isId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0, loans: [], holds: [] });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const today = toDay(date);
      if (today === null) return fail('invalid date');
      processAll(today);
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book on loan');
      if (book.readyFor !== null && book.readyFor !== memberId) return fail('book set aside for another member');
      if (m.loans.length >= MAX_LOANS) return fail('loan limit reached');
      if (m.owed >= BORROW_BLOCK_OWED) return fail('too much owed');
      for (const bid of m.loans) {
        if (books.get(bid).loan.due < today) return fail('member has overdue loans');
      }
      if (book.readyFor === memberId) {
        book.queue.shift();
        removeHoldFromMember(memberId, bookId);
        book.readyFor = null;
        book.readyUntil = null;
      }
      const due = today + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate: fromDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const today = toDay(date);
      if (today === null) return fail('invalid date');
      processAll(today);
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to this member');
      const late = today - book.loan.due;
      let fine = 0;
      if (late > GRACE_DAYS) {
        fine = Math.min((late - GRACE_DAYS) * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      }
      m.owed += fine;
      book.loan = null;
      m.loans.splice(m.loans.indexOf(bookId), 1);
      setAsideNext(book, today);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const today = toDay(date);
      if (today === null) return fail('invalid date');
      processAll(today);
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to this member');
      if (book.loan.due < today) return fail('loan is overdue');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.queue.length > 0) return fail('others are waiting');
      book.loan.due += LOAN_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: fromDay(book.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const today = toDay(date);
      if (today === null) return fail('invalid date');
      processAll(today);
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!m) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan && book.readyFor === null) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member has this book');
      if (book.queue.includes(memberId)) return fail('already holding');
      book.queue.push(memberId);
      m.holds.push(bookId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const today = toDay(date);
      if (today === null) return fail('invalid date');
      processAll(today);
      const m = members.get(memberId);
      if (!m) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > m.owed) return fail('amount exceeds owed');
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember({ memberId, date } = {}) {
      const today = toDay(date);
      if (today === null) return null;
      processAll(today);
      const m = members.get(memberId);
      if (!m) return null;
      const loans = m.loans.map((bid) => ({ bookId: bid, dueDate: fromDay(books.get(bid).loan.due) }));
      const holds = m.holds.map((bid) => {
        const b = books.get(bid);
        return {
          bookId: bid,
          position: b.queue.indexOf(memberId) + 1,
          readyUntil: b.readyFor === memberId ? fromDay(b.readyUntil) : null,
        };
      });
      return { loans, owed: m.owed, holds };
    },
  };
}
