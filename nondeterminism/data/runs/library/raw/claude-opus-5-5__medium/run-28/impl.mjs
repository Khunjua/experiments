const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const HOLD_PICKUP_DAYS = 7;
const MAX_LOANS = 5;
const OWED_BLOCK_LIMIT = 1000;
const DAY_MS = 86400000;

function toDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(t / DAY_MS);
}

function fromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function validId(id) {
  return (typeof id === 'string' && id.length > 0) || (typeof id === 'number' && Number.isFinite(id));
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let seq = 0;

  function advanceBook(book, today) {
    while (book.ready && book.ready.until < today) {
      const start = book.ready.until + 1;
      book.ready = null;
      if (book.queue.length > 0) {
        const next = book.queue.shift();
        book.ready = { memberId: next.memberId, seq: next.seq, until: start + HOLD_PICKUP_DAYS - 1 };
      }
    }
  }

  function advanceAll(today) {
    for (const book of books.values()) advanceBook(book, today);
  }

  function setAsideNext(book, today) {
    if (book.queue.length > 0) {
      const next = book.queue.shift();
      book.ready = { memberId: next.memberId, seq: next.seq, until: today + HOLD_PICKUP_DAYS - 1 };
    }
  }

  function hasHold(book, memberId) {
    return (book.ready && book.ready.memberId === memberId) ||
      book.queue.some((h) => h.memberId === memberId);
  }

  function addBook(args) {
    const bookId = args && args.bookId;
    if (!validId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { loan: null, queue: [], ready: null });
    return { ok: true };
  }

  function addMember(args) {
    const memberId = args && args.memberId;
    if (!validId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    const { memberId, bookId, date } = args || {};
    const today = toDay(date);
    if (today === null) return fail('invalid date');
    advanceAll(today);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (book.loan) return fail('book on loan');
    if (book.ready && book.ready.memberId !== memberId) return fail('set aside for another member');
    if (member.owed >= OWED_BLOCK_LIMIT) return fail('too much owed');
    let loanCount = 0;
    for (const b of books.values()) {
      if (b.loan && b.loan.memberId === memberId) {
        loanCount++;
        if (b.loan.dueDay < today) return fail('has overdue loan');
      }
    }
    if (loanCount >= MAX_LOANS) return fail('loan limit reached');
    if (book.ready && book.ready.memberId === memberId) book.ready = null;
    book.queue = book.queue.filter((h) => h.memberId !== memberId);
    const dueDay = today + LOAN_DAYS;
    book.loan = { memberId, dueDay, renewals: 0, seq: ++seq };
    return { ok: true, dueDate: fromDay(dueDay) };
  }

  function returnBook(args) {
    const { memberId, bookId, date } = args || {};
    const today = toDay(date);
    if (today === null) return fail('invalid date');
    advanceAll(today);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed by member');
    const daysLate = Math.max(0, today - book.loan.dueDay);
    const fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
    member.owed += fine;
    book.loan = null;
    setAsideNext(book, today);
    return { ok: true, fine };
  }

  function renew(args) {
    const { memberId, bookId, date } = args || {};
    const today = toDay(date);
    if (today === null) return fail('invalid date');
    advanceAll(today);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not borrowed by member');
    if (book.loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
    if (book.queue.length > 0) return fail('others waiting');
    if (book.loan.dueDay < today) return fail('overdue');
    book.loan.dueDay += LOAN_DAYS;
    book.loan.renewals++;
    return { ok: true, dueDate: fromDay(book.loan.dueDay) };
  }

  function placeHold(args) {
    const { memberId, bookId, date } = args || {};
    const today = toDay(date);
    if (today === null) return fail('invalid date');
    advanceAll(today);
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member) return fail('unknown member');
    if (!book) return fail('unknown book');
    if (!book.loan && !book.ready) return fail('book is available');
    if (book.loan && book.loan.memberId === memberId) return fail('member has the book');
    if (hasHold(book, memberId)) return fail('already holding');
    book.queue.push({ memberId, seq: ++seq });
    const position = book.queue.length + (book.ready ? 1 : 0);
    return { ok: true, position };
  }

  function payFine(args) {
    const { memberId, amount, date } = args || {};
    const today = toDay(date);
    if (today === null) return fail('invalid date');
    advanceAll(today);
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
    if (amount > member.owed) return fail('amount exceeds owed');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const { memberId, date } = args || {};
    const today = toDay(date);
    if (today === null) return fail('invalid date');
    advanceAll(today);
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    const loans = [];
    const holds = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) {
        loans.push({ seq: book.loan.seq, bookId, dueDate: fromDay(book.loan.dueDay) });
      }
      if (book.ready && book.ready.memberId === memberId) {
        holds.push({ seq: book.ready.seq, bookId, position: 1, readyUntil: fromDay(book.ready.until) });
      }
      const idx = book.queue.findIndex((h) => h.memberId === memberId);
      if (idx >= 0) {
        holds.push({
          seq: book.queue[idx].seq,
          bookId,
          position: idx + 1 + (book.ready ? 1 : 0),
          readyUntil: null,
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
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
