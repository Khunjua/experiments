// Community library: loans, renewals, holds and fines.
// Dates are kept internally as whole UTC day numbers (days since 1970-01-01).

const DAY_MS = 86_400_000;

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const MAX_RENEWALS = 2;
const BORROW_BLOCKED_AT_OWED = 1000;

const FINE_PER_DAY = 25;
const FINE_FREE_LATE_DAYS = 2; // 1-2 days late is free; from 3 days every late day is charged
const FINE_CAP = 500;

const PICKUP_DAYS = 3;

function parseDay(text) {
  if (typeof text !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const dayOfMonth = Number(match[3]);
  const dt = new Date(0);
  dt.setUTCFullYear(year, month - 1, dayOfMonth);
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== dayOfMonth
  ) {
    return null; // not a real calendar date
  }
  return Math.round(dt.getTime() / DAY_MS);
}

function formatDay(day) {
  const dt = new Date(day * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  // book:   { id, loan: { memberId, dueDay, renewals } | null,
  //           queue: [memberId, ...]            (hold line, front first),
  //           setAside: { memberId, readyUntil } | null }
  // member: { id, owed, loans: Map(bookId -> book), holds: Map(bookId -> book) }
  // Invariants: a non-empty queue means the book is on loan or set aside;
  //             setAside implies no loan and queue[0] === setAside.memberId.
  const books = new Map();
  const members = new Map();
  const reservedBooks = new Set(); // books that currently have a setAside slot

  const refuse = (reason) => ({ ok: false, reason });
  const validId = (id) => id !== undefined && id !== null;

  // Let time pass up to `day`: expire pick-up windows that ended before it.
  function advance(day) {
    for (const book of reservedBooks) {
      let slot = book.setAside;
      while (slot && slot.readyUntil < day) {
        const droppedId = book.queue.shift();
        const dropped = members.get(droppedId);
        if (dropped) dropped.holds.delete(book.id);
        slot = book.queue.length > 0
          ? { memberId: book.queue[0], readyUntil: slot.readyUntil + PICKUP_DAYS }
          : null;
      }
      book.setAside = slot;
      if (slot === null) reservedBooks.delete(book);
    }
  }

  function context(args, needBook) {
    const { memberId, bookId, date } = args ?? {};
    const day = parseDay(date);
    if (day === null) return { error: refuse('invalid date') };
    advance(day);
    const member = members.get(memberId);
    if (!member) return { error: refuse('unknown member') };
    let book = null;
    if (needBook) {
      book = books.get(bookId);
      if (!book) return { error: refuse('unknown book') };
    }
    return { day, memberId, bookId, member, book };
  }

  function addBook(args) {
    const { bookId } = args ?? {};
    if (!validId(bookId)) return refuse('invalid book id');
    if (books.has(bookId)) return refuse('book already exists');
    books.set(bookId, { id: bookId, loan: null, queue: [], setAside: null });
    return { ok: true };
  }

  function addMember(args) {
    const { memberId } = args ?? {};
    if (!validId(memberId)) return refuse('invalid member id');
    if (members.has(memberId)) return refuse('member already exists');
    members.set(memberId, { id: memberId, owed: 0, loans: new Map(), holds: new Map() });
    return { ok: true };
  }

  function borrow(args) {
    const c = context(args, true);
    if (c.error) return c.error;
    const { day, memberId, bookId, member, book } = c;
    if (book.loan) return refuse('book is on loan');
    if (book.setAside && book.setAside.memberId !== memberId) {
      return refuse('book is set aside for another member');
    }
    if (member.loans.size >= MAX_LOANS) return refuse('loan limit reached');
    if (member.owed >= BORROW_BLOCKED_AT_OWED) return refuse('fines owed');
    if (book.setAside) {
      // The member picks up their set-aside copy: the hold ends, the line moves up.
      book.queue.shift();
      member.holds.delete(bookId);
      book.setAside = null;
      reservedBooks.delete(book);
    }
    const dueDay = day + LOAN_DAYS;
    book.loan = { memberId, dueDay, renewals: 0 };
    member.loans.set(bookId, book);
    return { ok: true, dueDate: formatDay(dueDay) };
  }

  function returnBook(args) {
    const c = context(args, true);
    if (c.error) return c.error;
    const { day, memberId, bookId, member, book } = c;
    if (!book.loan || book.loan.memberId !== memberId) {
      return refuse('book is not on loan to this member');
    }
    const daysLate = day - book.loan.dueDay;
    const fine = daysLate > FINE_FREE_LATE_DAYS
      ? Math.min(FINE_CAP, daysLate * FINE_PER_DAY)
      : 0;
    member.owed += fine;
    member.loans.delete(bookId);
    book.loan = null;
    if (book.queue.length > 0) {
      book.setAside = { memberId: book.queue[0], readyUntil: day + PICKUP_DAYS };
      reservedBooks.add(book);
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const c = context(args, true);
    if (c.error) return c.error;
    const { day, memberId, book } = c;
    const loan = book.loan;
    if (!loan || loan.memberId !== memberId) return refuse('book is not on loan to this member');
    if (loan.renewals >= MAX_RENEWALS) return refuse('renewal limit reached');
    if (book.queue.length > 0) return refuse('book has holds');
    if (day > loan.dueDay) return refuse('loan is overdue');
    loan.dueDay += LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDay(loan.dueDay) };
  }

  function placeHold(args) {
    const c = context(args, true);
    if (c.error) return c.error;
    const { memberId, bookId, member, book } = c;
    if (!book.loan && !book.setAside) return refuse('book is free on the shelf');
    if (book.loan && book.loan.memberId === memberId) {
      return refuse('member has the book on loan');
    }
    if (member.holds.has(bookId)) return refuse('member already holds this book');
    book.queue.push(memberId);
    member.holds.set(bookId, book);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    const c = context(args, false);
    if (c.error) return c.error;
    const { member } = c;
    const { amount } = args;
    if (!Number.isInteger(amount) || amount <= 0) return refuse('invalid amount');
    if (amount > member.owed) return refuse('amount exceeds what is owed');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const { memberId, date } = args ?? {};
    const day = parseDay(date);
    if (day === null) {
      return { ok: false, reason: 'invalid date', loans: [], owed: 0, holds: [] };
    }
    advance(day);
    const member = members.get(memberId);
    if (!member) {
      return { ok: false, reason: 'unknown member', loans: [], owed: 0, holds: [] };
    }
    const loans = [];
    for (const [bookId, book] of member.loans) {
      loans.push({ bookId, dueDate: formatDay(book.loan.dueDay) });
    }
    const holds = [];
    for (const [bookId, book] of member.holds) {
      const reservedForMember = book.setAside && book.setAside.memberId === memberId;
      holds.push({
        bookId,
        position: book.queue.indexOf(memberId) + 1,
        readyUntil: reservedForMember ? formatDay(book.setAside.readyUntil) : null,
      });
    }
    return { loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
