const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const GRACE_DAYS = 0;
const BORROW_BLOCK_OWED = 1000;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

// Returns the day number (days since 1970-01-01, UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDate(day) {
  const t = new Date(day * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let latest = null;

  function newBook() {
    return { status: 'shelf', loanTo: null, asideFor: null, asideUntil: null, queue: [] };
  }

  function newMember() {
    return { owed: 0, loans: new Map(), holds: [] };
  }

  function setAside(book, memberId, until) {
    book.status = 'aside';
    book.loanTo = null;
    book.asideFor = memberId;
    book.asideUntil = until;
  }

  function shelve(book) {
    book.status = 'shelf';
    book.loanTo = null;
    book.asideFor = null;
    book.asideUntil = null;
  }

  function expireHolds(day) {
    for (const [bookId, book] of books) {
      while (book.status === 'aside' && book.asideUntil < day) {
        const member = members.get(book.asideFor);
        member.holds = member.holds.filter((id) => id !== bookId);
        const start = book.asideUntil + 1;
        if (book.queue.length > 0) {
          const next = book.queue.shift();
          setAside(book, next, start + PICKUP_DAYS);
        } else {
          shelve(book);
        }
      }
    }
  }

  // Validates a dated call's date and applies time processing.
  // Returns the day number, or null if the call must be rejected.
  function advance(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (latest !== null && day < latest) return null;
    latest = day;
    expireHolds(day);
    return day;
  }

  function addBook(args) {
    const { bookId } = args ?? {};
    if (!isId(bookId) || books.has(bookId)) return { ok: false };
    books.set(bookId, newBook());
    return { ok: true };
  }

  function addMember(args) {
    const { memberId } = args ?? {};
    if (!isId(memberId) || members.has(memberId)) return { ok: false };
    members.set(memberId, newMember());
    return { ok: true };
  }

  function borrow(args) {
    const { memberId, bookId, date } = args ?? {};
    const day = advance(date);
    if (day === null) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    if (book.status === 'loan') return { ok: false };
    if (book.status === 'aside' && book.asideFor !== memberId) return { ok: false };
    if (book.status === 'shelf' && book.queue.length > 0) return { ok: false };
    if (member.loans.size >= MAX_LOANS) return { ok: false };
    if (member.owed >= BORROW_BLOCK_OWED) return { ok: false };

    if (book.status === 'aside') {
      member.holds = member.holds.filter((id) => id !== bookId);
    }
    const dueDay = day + LOAN_DAYS;
    book.status = 'loan';
    book.loanTo = memberId;
    book.asideFor = null;
    book.asideUntil = null;
    member.loans.set(bookId, { bookId, dueDay, renewals: 0 });
    return { ok: true, dueDate: formatDate(dueDay) };
  }

  function returnBook(args) {
    const { memberId, bookId, date } = args ?? {};
    const day = advance(date);
    if (day === null) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    const loan = member.loans.get(bookId);
    if (!loan || book.status !== 'loan' || book.loanTo !== memberId) return { ok: false };

    const daysLate = Math.max(0, day - loan.dueDay - GRACE_DAYS);
    const fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
    member.owed += fine;
    member.loans.delete(bookId);

    if (book.queue.length > 0) {
      const next = book.queue.shift();
      setAside(book, next, day + PICKUP_DAYS);
    } else {
      shelve(book);
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const { memberId, bookId, date } = args ?? {};
    const day = advance(date);
    if (day === null) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    const loan = member.loans.get(bookId);
    if (!loan || book.status !== 'loan' || book.loanTo !== memberId) return { ok: false };
    if (loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (day > loan.dueDay) return { ok: false };
    if (book.queue.length > 0) return { ok: false };

    loan.dueDay = day + LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDay) };
  }

  function placeHold(args) {
    const { memberId, bookId, date } = args ?? {};
    const day = advance(date);
    if (day === null) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    if (book.status === 'shelf') return { ok: false };
    if (book.status === 'loan' && book.loanTo === memberId) return { ok: false };
    if (book.status === 'aside' && book.asideFor === memberId) return { ok: false };
    if (book.queue.includes(memberId)) return { ok: false };
    if (member.holds.length >= MAX_HOLDS) return { ok: false };

    book.queue.push(memberId);
    member.holds.push(bookId);
    const position = book.queue.length + (book.status === 'aside' ? 1 : 0);
    return { ok: true, position };
  }

  function payFine(args) {
    const { memberId, amount, date } = args ?? {};
    const day = advance(date);
    if (day === null) return { ok: false };
    const member = members.get(memberId);
    if (!member) return { ok: false };
    if (!Number.isInteger(amount) || amount <= 0 || amount > member.owed) return { ok: false };

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const { memberId, date } = args ?? {};
    const day = advance(date);
    if (day === null) return { ok: false };
    const member = members.get(memberId);
    if (!member) return { ok: false };

    const loans = [...member.loans.values()].map((l) => ({
      bookId: l.bookId,
      dueDate: formatDate(l.dueDay),
    }));

    const holds = [];
    for (const bookId of member.holds) {
      const book = books.get(bookId);
      if (book.status === 'aside' && book.asideFor === memberId) {
        holds.push({
          bookId,
          position: 1,
          readyUntil: formatDate(book.asideUntil),
        });
      } else {
        const index = book.queue.indexOf(memberId);
        const position = index + 1 + (book.status === 'aside' ? 1 : 0);
        holds.push({ bookId, position, readyUntil: null });
      }
    }

    return { loans, owed: member.owed, holds };
  }

  return {
    addBook,
    addMember,
    borrow,
    returnBook,
    renew,
    placeHold,
    payFine,
    getMember,
  };
}
