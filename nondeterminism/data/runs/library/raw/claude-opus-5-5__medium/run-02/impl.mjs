const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_RETURN = 500;
const GRACE_DAYS = 0;
const PICKUP_DAYS = 7;
const MAX_LOANS = 5;
const MAX_OWED_TO_BORROW = 1000;

const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function formatDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals} | null, queue: [{memberId, readyUntil|null}] }
  const members = new Map(); // memberId -> { owed, loans: [bookId] }

  function advance(today) {
    for (const book of books.values()) {
      while (book.queue.length > 0) {
        const first = book.queue[0];
        if (first.readyUntil === null) break;
        if (today <= first.readyUntil) break;
        const expiredAt = first.readyUntil;
        book.queue.shift();
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = expiredAt + PICKUP_DAYS;
        }
      }
    }
  }

  function prepare(date) {
    const day = parseDate(date);
    if (day === null) return null;
    advance(day);
    return day;
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId)) return fail('invalid bookId');
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid memberId');
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loan) return fail('book on loan');
      if (member.owed >= MAX_OWED_TO_BORROW) return fail('too much owed');
      if (member.loans.length >= MAX_LOANS) return fail('too many loans');
      if (book.queue.length > 0) {
        const first = book.queue[0];
        if (first.memberId !== memberId || first.readyUntil === null) return fail('book reserved');
        book.queue.shift();
      }
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      member.loans.push(bookId);
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed by member');
      const late = day - book.loan.due;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_RETURN);
      member.owed += fine;
      member.loans = member.loans.filter((b) => b !== bookId);
      book.loan = null;
      if (book.queue.length > 0) {
        book.queue[0].readyUntil = day + PICKUP_DAYS - 1;
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not borrowed by member');
      if (day > loan.due) return fail('overdue');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.queue.length > 0) return fail('others waiting');
      if (member.owed >= MAX_OWED_TO_BORROW) return fail('too much owed');
      loan.due = loan.due + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan && book.queue.length === 0) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
      if (book.queue.some((h) => h.memberId === memberId)) return fail('already holding');
      book.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('amount exceeds owed');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const day = prepare(date);
      if (day === null) return fail('invalid date');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const loans = member.loans.map((bookId) => ({
        bookId,
        dueDate: formatDay(books.get(bookId).loan.due),
      }));
      const holds = [];
      for (const [bookId, book] of books) {
        const idx = book.queue.findIndex((h) => h.memberId === memberId);
        if (idx >= 0) {
          const h = book.queue[idx];
          holds.push({
            bookId,
            position: idx + 1,
            readyUntil: h.readyUntil === null ? null : formatDay(h.readyUntil),
          });
        }
      }
      return { loans, owed: member.owed, holds };
    },
  };
}
