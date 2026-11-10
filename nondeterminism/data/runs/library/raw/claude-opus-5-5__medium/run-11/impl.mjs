const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 1000;
const PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

function fmtDate(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function validId(id) {
  return typeof id === 'string' && id.length > 0;
}

const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals, seq} | null, queue: [{memberId, readyUntil|null}] }
  const members = new Map(); // memberId -> { owed }
  let lastDay = -Infinity;
  let loanSeq = 0;

  function advance(day) {
    if (day > lastDay) lastDay = day;
    for (const book of books.values()) {
      while (book.queue.length > 0 && book.queue[0].readyUntil !== null && book.queue[0].readyUntil < day) {
        const expired = book.queue.shift();
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = expired.readyUntil + PICKUP_DAYS;
        }
      }
    }
  }

  function checkDate(date) {
    const day = parseDate(date);
    if (day === null) return null;
    if (day < lastDay) return null;
    advance(day);
    return day;
  }

  return {
    addBook({ bookId } = {}) {
      if (!validId(bookId)) return fail('invalid id');
      if (books.has(bookId)) return fail('duplicate');
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember({ memberId } = {}) {
      if (!validId(memberId)) return fail('invalid id');
      if (members.has(memberId)) return fail('duplicate');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    },

    borrow({ memberId, bookId, date } = {}) {
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      const day = checkDate(date);
      if (day === null) return fail('invalid date');
      if (book.loan) return fail('book on loan');
      if (member.owed >= BORROW_BLOCK_OWED) return fail('fines owed');
      if (book.queue.length > 0) {
        const front = book.queue[0];
        if (front.readyUntil === null || front.memberId !== memberId) return fail('reserved for another member');
        book.queue.shift();
      }
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0, seq: loanSeq++ };
      return { ok: true, dueDate: fmtDate(due) };
    },

    returnBook({ memberId, bookId, date } = {}) {
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const day = checkDate(date);
      if (day === null) return fail('invalid date');
      const late = Math.max(0, day - book.loan.due);
      const fine = Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      member.owed += fine;
      book.loan = null;
      if (book.queue.length > 0) book.queue[0].readyUntil = day + PICKUP_DAYS;
      return { ok: true, fine };
    },

    renew({ memberId, bookId, date } = {}) {
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const day = checkDate(date);
      if (day === null) return fail('invalid date');
      if (book.queue.length > 0) return fail('others waiting');
      if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (day > book.loan.due) return fail('overdue');
      if (member.owed >= BORROW_BLOCK_OWED) return fail('fines owed');
      book.loan.renewals += 1;
      book.loan.due += LOAN_DAYS;
      return { ok: true, dueDate: fmtDate(book.loan.due) };
    },

    placeHold({ memberId, bookId, date } = {}) {
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown member or book');
      const day = checkDate(date);
      if (day === null) return fail('invalid date');
      if (!book.loan && book.queue.length === 0) return fail('book is available');
      if (book.loan && book.loan.memberId === memberId) return fail('already borrowed by member');
      if (book.queue.some((h) => h.memberId === memberId)) return fail('already holding');
      book.queue.push({ memberId, readyUntil: null });
      return { ok: true, position: book.queue.length };
    },

    payFine({ memberId, amount, date } = {}) {
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');
      const day = checkDate(date);
      if (day === null) return fail('invalid date');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember({ memberId, date } = {}) {
      const member = members.get(memberId);
      if (!member) return fail('unknown member');
      const day = checkDate(date);
      if (day === null) return fail('invalid date');
      const loanList = [];
      const holds = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loanList.push({ seq: book.loan.seq, bookId, dueDate: fmtDate(book.loan.due) });
        }
        book.queue.forEach((h, i) => {
          if (h.memberId === memberId) {
            holds.push({
              bookId,
              position: i + 1,
              readyUntil: h.readyUntil === null ? null : fmtDate(h.readyUntil),
            });
          }
        });
      }
      loanList.sort((a, b) => a.seq - b.seq);
      return {
        ok: true,
        loans: loanList.map(({ bookId, dueDate }) => ({ bookId, dueDate })),
        owed: member.owed,
        holds,
      };
    },
  };
}
