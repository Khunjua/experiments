const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE_PER_LOAN = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 500;
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

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals, seq} | null, queue: [{memberId, readyUntil}] }
  const members = new Map(); // memberId -> { owed }
  let seq = 0;

  const fail = (reason) => ({ ok: false, reason });

  function processHolds(book, today) {
    if (book.loan) return;
    while (book.queue.length > 0) {
      const front = book.queue[0];
      if (front.readyUntil === null) return; // should not happen when available
      if (today > front.readyUntil) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = front.readyUntil + 1 + PICKUP_DAYS;
        }
      } else {
        return;
      }
    }
  }

  function loansOf(memberId) {
    const res = [];
    for (const [bookId, b] of books) {
      if (b.loan && b.loan.memberId === memberId) res.push({ bookId, loan: b.loan });
    }
    return res;
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId) || books.has(bookId)) return fail('invalid or duplicate book');
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId) || members.has(memberId)) return fail('invalid or duplicate member');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (today === null || !member || !book) return fail('invalid input');
      processHolds(book, today);
      if (book.loan) return fail('book on loan');
      if (member.owed >= BLOCK_OWED) return fail('fines owed');
      if (loansOf(memberId).length >= MAX_LOANS) return fail('loan limit');
      if (book.queue.length > 0) {
        if (book.queue[0].memberId !== memberId) return fail('set aside for another member');
        book.queue.shift();
      }
      const due = today + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0, seq: seq++ };
      return { ok: true, dueDate: fmt(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (today === null || !member || !book) return fail('invalid input');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed by member');
      const late = today - book.loan.due;
      let fine = 0;
      if (late > GRACE_DAYS) fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      member.owed += fine;
      book.loan = null;
      if (book.queue.length > 0) book.queue[0].readyUntil = today + PICKUP_DAYS;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (today === null || !member || !book) return fail('invalid input');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not borrowed by member');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.queue.length > 0) return fail('others waiting');
      if (today > loan.due) return fail('overdue');
      if (member.owed >= BLOCK_OWED) return fail('fines owed');
      loan.due = loan.due + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: fmt(loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const today = parseDate(date);
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (today === null || !member || !book) return fail('invalid input');
      processHolds(book, today);
      if (!book.loan && book.queue.length === 0) return fail('book available, borrow it');
      if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
      if (book.queue.some((h) => h.memberId === memberId)) return fail('already holding');
      book.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const today = parseDate(date);
      const member = members.get(memberId);
      if (today === null || !member) return fail('invalid input');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const today = parseDate(date);
      const member = members.get(memberId);
      if (today === null || !member) return { ok: false, loans: [], owed: 0, holds: [] };
      for (const b of books.values()) processHolds(b, today);
      const loans = loansOf(memberId)
        .sort((a, b) => a.loan.seq - b.loan.seq)
        .map(({ bookId, loan }) => ({ bookId, dueDate: fmt(loan.due) }));
      const holds = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.findIndex((h) => h.memberId === memberId);
        if (idx >= 0) {
          const h = b.queue[idx];
          const setAside = idx === 0 && !b.loan && h.readyUntil !== null;
          holds.push({ bookId, position: idx + 1, readyUntil: setAside ? fmt(h.readyUntil) : null });
        }
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
