const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 1000;
const PICKUP_DAYS = 7;

const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toDay(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals, seq} | null, queue: [memberId], readyUntil: day|null }
  const members = new Map(); // memberId -> { owed }
  let loanSeq = 0;
  let holdSeq = 0;
  const holdOrder = new Map(); // `${bookId}` key not used; store seq per (book, member) in book.holdSeqs

  function advance(day) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && day > book.readyUntil) {
        const expiredEnd = book.readyUntil;
        const m = book.queue.shift();
        book.holdSeqs.delete(m);
        if (book.queue.length > 0) {
          book.readyUntil = expiredEnd + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  function prep(date) {
    const day = toDay(date);
    if (day === null) return null;
    advance(day);
    return day;
  }

  function hasOverdue(memberId, day) {
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId && day > book.loan.due) return true;
    }
    return false;
  }

  return {
    addBook({ bookId } = {}) {
      if (bookId === undefined || bookId === null) return fail('invalid');
      if (books.has(bookId)) return fail('exists');
      books.set(bookId, { loan: null, queue: [], readyUntil: null, holdSeqs: new Map() });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (memberId === undefined || memberId === null) return fail('invalid');
      if (members.has(memberId)) return fail('exists');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('bad date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown');
      if (book.loan) return fail('on loan');
      if (book.queue.length > 0) {
        if (book.queue[0] !== memberId || book.readyUntil === null) return fail('reserved');
      }
      if (member.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
      if (hasOverdue(memberId, day)) return fail('overdue loans');
      if (book.queue.length > 0) {
        book.queue.shift();
        book.holdSeqs.delete(memberId);
        book.readyUntil = null;
      }
      book.loan = { memberId, due: day + LOAN_DAYS, renewals: 0, seq: ++loanSeq };
      return { ok: true, dueDate: fromDay(book.loan.due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('bad date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed');
      const late = Math.max(0, day - book.loan.due);
      const fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      member.owed += fine;
      book.loan = null;
      if (book.queue.length > 0) book.readyUntil = day + PICKUP_DAYS;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('bad date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not borrowed');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (book.queue.length > 0) return fail('others waiting');
      if (day > loan.due) return fail('overdue');
      if (member.owed >= BORROW_BLOCK_OWED) return fail('owes too much');
      loan.renewals += 1;
      loan.due += LOAN_DAYS;
      return { ok: true, dueDate: fromDay(loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('bad date');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown');
      if (!book.loan && book.queue.length === 0) return fail('available');
      if (book.loan && book.loan.memberId === memberId) return fail('already has it');
      if (book.queue.includes(memberId)) return fail('already holding');
      book.queue.push(memberId);
      book.holdSeqs.set(memberId, ++holdSeq);
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('bad date');
      const member = members.get(memberId);
      if (!member) return fail('unknown');
      if (!Number.isInteger(amount) || amount <= 0) return fail('bad amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const day = prep(date);
      if (day === null) return fail('bad date');
      const member = members.get(memberId);
      if (!member) return fail('unknown');
      const loans = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loans.push({ seq: book.loan.seq, bookId, dueDate: fromDay(book.loan.due) });
        }
        const idx = book.queue.indexOf(memberId);
        if (idx >= 0) {
          const ready = idx === 0 && book.readyUntil !== null;
          holds.push({
            seq: book.holdSeqs.get(memberId),
            bookId,
            position: idx + 1,
            readyUntil: ready ? fromDay(book.readyUntil) : null,
          });
        }
      }
      loans.sort((a, b) => a.seq - b.seq);
      holds.sort((a, b) => a.seq - b.seq);
      return {
        ok: true,
        loans: loans.map(({ bookId, dueDate }) => ({ bookId, dueDate })),
        owed: member.owed,
        holds: holds.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil })),
      };
    },
  };
}
