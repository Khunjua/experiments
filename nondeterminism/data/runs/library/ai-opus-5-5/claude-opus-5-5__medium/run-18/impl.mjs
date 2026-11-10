const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_RATE = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const OWED_BLOCK = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(2000, m - 1, d));
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return Math.round(dt.getTime() / MS_PER_DAY);
}

function formatDate(n) {
  const dt = new Date(n * MS_PER_DAY);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals} | null, queue: [{memberId, seq, readyUntil}] }
  const members = new Map(); // memberId -> { loans: [{bookId, seq}], owed }
  let currentDate = null;
  let seqCounter = 0;

  function processExpiry(day) {
    for (const book of books.values()) {
      while (!book.loan && book.queue.length > 0 && day > book.queue[0].readyUntil) {
        const prev = book.queue.shift();
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = prev.readyUntil + 1 + PICKUP_DAYS;
        }
      }
    }
  }

  // Returns day number, or null if the date is invalid or earlier than the clock.
  function clock(args) {
    if (!args || typeof args !== 'object') return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (currentDate !== null && day < currentDate) return null;
    currentDate = day;
    processExpiry(day);
    return day;
  }

  function isAvailable(book) {
    return !book.loan && book.queue.length === 0;
  }

  function activeHoldCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      for (const h of book.queue) if (h.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook(args) {
      if (!args || typeof args !== 'object' || !isId(args.bookId)) return fail('invalid');
      if (books.has(args.bookId)) return fail('exists');
      books.set(args.bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember(args) {
      if (!args || typeof args !== 'object' || !isId(args.memberId)) return fail('invalid');
      if (members.has(args.memberId)) return fail('exists');
      members.set(args.memberId, { loans: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      const day = clock(args);
      if (day === null) return fail('invalid date');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown');
      if (book.loan) return fail('on loan');
      const setAsideForMe = book.queue.length > 0 && book.queue[0].memberId === memberId;
      if (book.queue.length > 0 && !setAsideForMe) return fail('set aside');
      if (member.loans.length >= MAX_LOANS) return fail('loan limit');
      for (const l of member.loans) {
        if (books.get(l.bookId).loan.due < day) return fail('overdue');
      }
      if (member.owed >= OWED_BLOCK) return fail('owes');
      if (setAsideForMe) book.queue.shift();
      for (const h of book.queue) h.readyUntil = null;
      const due = day + LOAN_DAYS;
      book.loan = { memberId, due, renewals: 0 };
      member.loans.push({ bookId, seq: ++seqCounter });
      return { ok: true, dueDate: formatDate(due) };
    },

    returnBook(args) {
      const day = clock(args);
      if (day === null) return fail('invalid date');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown');
      if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan to member');
      const daysLate = Math.max(0, day - book.loan.due);
      const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
      member.owed += fine;
      member.loans = member.loans.filter((l) => l.bookId !== bookId);
      book.loan = null;
      if (book.queue.length > 0) {
        book.queue[0].readyUntil = day + PICKUP_DAYS;
      }
      return { ok: true, fine };
    },

    renew(args) {
      const day = clock(args);
      if (day === null) return fail('invalid date');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown');
      const loan = book.loan;
      if (!loan || loan.memberId !== memberId) return fail('not on loan to member');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (day > loan.due) return fail('overdue');
      if (book.queue.length > 0) return fail('holds exist');
      loan.due = day + RENEW_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(loan.due) };
    },

    placeHold(args) {
      const day = clock(args);
      if (day === null) return fail('invalid date');
      const { memberId, bookId } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid');
      const member = members.get(memberId);
      const book = books.get(bookId);
      if (!member || !book) return fail('unknown');
      if (isAvailable(book)) return fail('available');
      if (book.loan && book.loan.memberId === memberId) return fail('has on loan');
      if (book.queue.some((h) => h.memberId === memberId)) return fail('already held');
      if (activeHoldCount(memberId) >= MAX_HOLDS) return fail('hold limit');
      book.queue.push({ memberId, seq: ++seqCounter, readyUntil: null });
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      const day = clock(args);
      if (day === null) return fail('invalid date');
      const { memberId, amount } = args;
      if (!isId(memberId)) return fail('invalid');
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail('invalid amount');
      const member = members.get(memberId);
      if (!member) return fail('unknown');
      if (amount > member.owed) return fail('overpayment');
      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember(args) {
      const day = clock(args);
      if (day === null) return fail('invalid date');
      const { memberId } = args;
      if (!isId(memberId)) return fail('invalid');
      const member = members.get(memberId);
      if (!member) return fail('unknown');
      const loans = member.loans
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((l) => ({ bookId: l.bookId, dueDate: formatDate(books.get(l.bookId).loan.due) }));
      const holdList = [];
      for (const [bookId, book] of books) {
        book.queue.forEach((h, i) => {
          if (h.memberId !== memberId) return;
          const ready = !book.loan && i === 0;
          holdList.push({
            seq: h.seq,
            bookId,
            position: i + 1,
            readyUntil: ready ? formatDate(h.readyUntil) : null,
          });
        });
      }
      holdList.sort((a, b) => a.seq - b.seq);
      const holds = holdList.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
