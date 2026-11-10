const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE_PER_LOAN = 1000;
const MAX_LOANS = 5;
const MAX_OWED_TO_BORROW = 500;
const PICKUP_DAYS = 7;

const DAY_MS = 86400000;

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function fmt(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function isId(x) {
  return (typeof x === 'string' && x.length > 0) || (typeof x === 'number' && Number.isFinite(x));
}

export function createLibrary() {
  const books = new Map(); // bookId -> { loan: {memberId, due, renewals, seq} | null, holds: [{memberId, readyUntil|null, seq}] }
  const members = new Map(); // memberId -> { owed }
  let seq = 0;

  const fail = (reason) => ({ ok: false, reason });

  function processDate(today) {
    for (const book of books.values()) {
      while (book.holds.length > 0 && book.holds[0].readyUntil !== null && today > book.holds[0].readyUntil) {
        const expired = book.holds.shift();
        if (book.holds.length > 0) {
          book.holds[0].readyUntil = expired.readyUntil + PICKUP_DAYS;
        }
      }
    }
  }

  function prepare(date) {
    const today = parseDate(date);
    if (today === null) return null;
    processDate(today);
    return today;
  }

  function loanCount(memberId) {
    let n = 0;
    for (const book of books.values()) if (book.loan && book.loan.memberId === memberId) n++;
    return n;
  }

  return {
    addBook({ bookId } = {}) {
      if (!isId(bookId) || books.has(bookId)) return fail('invalid or duplicate book');
      books.set(bookId, { loan: null, holds: [] });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!isId(memberId) || members.has(memberId)) return fail('invalid or duplicate member');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const today = prepare(date);
      if (today === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (book.loan) return fail('book is on loan');
      if (book.holds.length > 0) {
        const first = book.holds[0];
        if (first.memberId !== memberId) return fail('book is set aside for another member');
      }
      if (member.owed > MAX_OWED_TO_BORROW) return fail('too much owed');
      if (loanCount(memberId) >= MAX_LOANS) return fail('too many loans');
      if (book.holds.length > 0) {
        book.holds.shift();
      }
      const due = today + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0, seq: seq++ };
      return { ok: true, dueDate: fmt(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const today = prepare(date);
      if (today === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to this member');
      const daysLate = today - book.loan.due;
      let fine = 0;
      if (daysLate > GRACE_DAYS) {
        fine = Math.min((daysLate - GRACE_DAYS) * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      }
      member.owed += fine;
      book.loan = null;
      if (book.holds.length > 0) {
        book.holds[0].readyUntil = today + PICKUP_DAYS;
      }
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const today = prepare(date);
      if (today === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not on loan to this member');
      if (book.holds.length > 0) return fail('others are waiting');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (today > loan.due) return fail('loan is overdue');
      if (member.owed > MAX_OWED_TO_BORROW) return fail('too much owed');
      loan.due = loan.due + LOAN_DAYS;
      loan.renewals++;
      return { ok: true, dueDate: fmt(loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const today = prepare(date);
      if (today === null) return fail('invalid date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan && book.holds.length === 0) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('member has this book');
      if (book.holds.some((h) => h.memberId === memberId)) return fail('already holding');
      book.holds.push({ memberId, readyUntil: null, seq: seq++ });
      return { ok: true, position: book.holds.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const today = prepare(date);
      if (today === null) return fail('invalid date');
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('amount exceeds owed');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const today = prepare(date);
      const member = members.get(memberId);
      if (today === null || !member) return { ok: false, loans: [], owed: 0, holds: [] };
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ bookId, dueDate: fmt(book.loan.due), seq: book.loan.seq });
        }
        book.holds.forEach((h, i) => {
          if (h.memberId === memberId) {
            holds.push({
              bookId,
              position: i + 1,
              readyUntil: h.readyUntil === null ? null : fmt(h.readyUntil),
              seq: h.seq,
            });
          }
        });
      }
      loans.sort((a, b) => a.seq - b.seq);
      holds.sort((a, b) => a.seq - b.seq);
      return {
        loans: loans.map(({ bookId, dueDate }) => ({ bookId, dueDate })),
        owed: member.owed,
        holds: holds.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil })),
      };
    },
  };
}
