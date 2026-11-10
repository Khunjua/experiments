const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_RETURN = 500;
const PICKUP_DAYS = 7;
const BORROW_BLOCK_OWED = 1000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

function fmt(dayNum) {
  return new Date(dayNum * 86400000).toISOString().slice(0, 10);
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals} | null, queue: [memberId], readyUntil: dayNum | null }
  const members = new Map(); // memberId -> { owed }

  const fail = (reason) => ({ ok: false, reason });

  function setAsideNext(book, startDay) {
    if (book.queue.length > 0) {
      book.readyUntil = startDay + PICKUP_DAYS - 1;
    } else {
      book.readyUntil = null;
    }
  }

  function processBook(book, today) {
    while (!book.loan && book.readyUntil !== null && today > book.readyUntil) {
      const start = book.readyUntil + 1;
      book.queue.shift();
      setAsideNext(book, start);
    }
  }

  function processAll(today) {
    for (const book of books.values()) processBook(book, today);
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      processAll(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book is on loan');
      if (member.owed > BORROW_BLOCK_OWED) return fail('too much owed');
      if (book.readyUntil !== null) {
        if (book.queue[0] !== memberId) return fail('book is set aside for another member');
        book.queue.shift();
        book.readyUntil = null;
      } else if (book.queue.length > 0) {
        return fail('book has holds');
      }
      const due = today + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      return { ok: true, dueDate: fmt(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      processAll(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed by this member');
      const late = Math.max(0, today - book.loan.due);
      const fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_RETURN);
      member.owed += fine;
      book.loan = null;
      setAsideNext(book, today);
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      processAll(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not borrowed by this member');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (book.queue.length > 0) return fail('others are waiting');
      if (today > loan.due) return fail('loan is overdue');
      if (member.owed > BORROW_BLOCK_OWED) return fail('too much owed');
      loan.due = loan.due + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: fmt(loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      processAll(today);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (!book.loan && book.readyUntil === null) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member has this book');
      if (book.queue.includes(memberId)) return fail('already holding');
      book.queue.push(memberId);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      processAll(today);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('amount exceeds owed');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const today = parseDate(date);
      if (today === null) return fail('invalid date');
      processAll(today);
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: fmt(book.loan.due) });
        }
        const idx = book.queue.indexOf(memberId);
        if (idx !== -1) {
          const readyUntil = idx === 0 && !book.loan && book.readyUntil !== null ? fmt(book.readyUntil) : null;
          holds.push({ bookId, position: idx + 1, readyUntil });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
