const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_RATE = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY_MS);
}

function formatDate(day) {
  const t = new Date(day * DAY_MS);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1;
  const d = t.getUTCDate();
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loanedTo, readyUntil, queue: [{memberId, seq}] }
  const members = new Map(); // memberId -> { loans: [{bookId, due, renewals}], owed }
  let currentDay = null;
  let holdSeq = 0;

  function processExpiry(day) {
    for (const book of books.values()) {
      while (book.loanedTo === null && book.readyUntil !== null && day > book.readyUntil) {
        const prev = book.readyUntil;
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = prev + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates the argument shape and date; advances the clock and processes expiry.
  // Returns { day } on success or { error } on failure.
  function begin(args, needBook) {
    if (args === null || typeof args !== 'object') return { error: 'invalid arguments' };
    if (!isId(args.memberId)) return { error: 'invalid memberId' };
    if (needBook && !isId(args.bookId)) return { error: 'invalid bookId' };
    const day = parseDate(args.date);
    if (day === null) return { error: 'invalid date' };
    if (currentDay !== null && day < currentDay) return { error: 'date earlier than current date' };
    currentDay = day;
    processExpiry(day);
    return { day };
  }

  function countActiveHolds(memberId) {
    let n = 0;
    for (const book of books.values()) {
      for (const h of book.queue) if (h.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== 'object' || !isId(args.bookId)) return fail('invalid bookId');
      if (books.has(args.bookId)) return fail('book exists');
      books.set(args.bookId, { loanedTo: null, readyUntil: null, queue: [] });
      return { ok: true };
    },

    addMember(args) {
      if (args === null || typeof args !== 'object' || !isId(args.memberId)) return fail('invalid memberId');
      if (members.has(args.memberId)) return fail('member exists');
      members.set(args.memberId, { loans: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      const b = begin(args, true);
      if (b.error) return fail(b.error);
      const day = b.day;
      const member = members.get(args.memberId);
      const book = books.get(args.bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loanedTo !== null) return fail('book on loan');
      const setAside = book.readyUntil !== null;
      if (setAside && book.queue[0].memberId !== args.memberId) return fail('set aside for another member');
      if (member.loans.length >= MAX_LOANS) return fail('too many loans');
      if (member.loans.some(l => l.due < day)) return fail('overdue loan');
      if (member.owed >= BLOCK_OWED) return fail('owes too much');
      if (setAside) {
        book.queue.shift();
        book.readyUntil = null;
      }
      const due = day + LOAN_DAYS;
      book.loanedTo = args.memberId;
      member.loans.push({ bookId: args.bookId, due, renewals: 0 });
      return { ok: true, dueDate: formatDate(due) };
    },

    returnBook(args) {
      const b = begin(args, true);
      if (b.error) return fail(b.error);
      const day = b.day;
      const member = members.get(args.memberId);
      const book = books.get(args.bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loanedTo !== args.memberId) return fail('not on loan to this member');
      const idx = member.loans.findIndex(l => l.bookId === args.bookId);
      if (idx < 0) return fail('loan not found');
      const loan = member.loans[idx];
      const daysLate = Math.max(0, day - loan.due);
      const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
      member.owed += fine;
      member.loans.splice(idx, 1);
      book.loanedTo = null;
      if (book.queue.length > 0) {
        book.readyUntil = day + PICKUP_DAYS;
      } else {
        book.readyUntil = null;
      }
      return { ok: true, fine };
    },

    renew(args) {
      const b = begin(args, true);
      if (b.error) return fail(b.error);
      const day = b.day;
      const member = members.get(args.memberId);
      const book = books.get(args.bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loanedTo !== args.memberId) return fail('not on loan to this member');
      const loan = member.loans.find(l => l.bookId === args.bookId);
      if (!loan) return fail('loan not found');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (day > loan.due) return fail('loan overdue');
      if (book.queue.length > 0) return fail('holds exist');
      const newDue = Math.max(loan.due, day + RENEW_DAYS);
      loan.due = newDue;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(newDue) };
    },

    placeHold(args) {
      const b = begin(args, true);
      if (b.error) return fail(b.error);
      const member = members.get(args.memberId);
      const book = books.get(args.bookId);
      if (!member) return fail('unknown member');
      if (!book) return fail('unknown book');
      if (book.loanedTo === null && book.readyUntil === null) return fail('book available');
      if (book.loanedTo === args.memberId) return fail('member has this book');
      if (book.queue.some(h => h.memberId === args.memberId)) return fail('already holding');
      if (countActiveHolds(args.memberId) >= MAX_HOLDS) return fail('too many holds');
      book.queue.push({ memberId: args.memberId, seq: ++holdSeq });
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      const b = begin(args, false);
      if (b.error) return fail(b.error);
      const member = members.get(args.memberId);
      if (!member) return fail('unknown member');
      const amount = args.amount;
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return fail('invalid amount');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember(args) {
      const b = begin(args, false);
      if (b.error) return fail(b.error);
      const member = members.get(args.memberId);
      if (!member) return fail('unknown member');
      const loans = member.loans.map(l => ({ bookId: l.bookId, dueDate: formatDate(l.due) }));
      const found = [];
      for (const [bookId, book] of books) {
        book.queue.forEach((h, i) => {
          if (h.memberId === args.memberId) {
            const ready = i === 0 && book.loanedTo === null && book.readyUntil !== null;
            found.push({
              seq: h.seq,
              bookId,
              position: i + 1,
              readyUntil: ready ? formatDate(book.readyUntil) : null,
            });
          }
        });
      }
      found.sort((a, c) => a.seq - c.seq);
      const holds = found.map(h => ({ bookId: h.bookId, position: h.position, readyUntil: h.readyUntil }));
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
