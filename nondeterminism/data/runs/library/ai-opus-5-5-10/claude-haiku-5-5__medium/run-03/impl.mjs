const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE = 1000;
const DEBT_LIMIT = 1000;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

const fail = (reason) => ({ ok: false, reason });

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

// Returns integer day number (days since 1970-01-01, proleptic Gregorian) or null.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d > dim) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  return Math.round(t.getTime() / MS_PER_DAY);
}

function fmt(day) {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let lastDay = null;
  let seq = 0;

  // §4.2 expiry processing
  function advance(day) {
    for (const book of books.values()) {
      while (book.state === 'set' && day > book.readyUntil) {
        book.queue.shift(); // expired hold, member not charged
        const s = book.readyUntil + 1;
        if (book.queue.length > 0) {
          book.readyUntil = s + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.readyUntil = null;
          book.borrower = null;
        }
      }
    }
  }

  // §3.5 clock. Returns the day number, or null if the call must fail.
  function admit(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (lastDay !== null && day < lastDay) return null;
    lastDay = day;
    advance(day);
    return day;
  }

  function addBook(args) {
    const bookId = args?.bookId;
    if (!isId(bookId) || books.has(bookId)) return fail('invalid or existing book');
    books.set(bookId, { state: 'available', borrower: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    const memberId = args?.memberId;
    if (!isId(memberId) || members.has(memberId)) return fail('invalid or existing member');
    members.set(memberId, { owed: 0, loans: [] });
    return { ok: true };
  }

  function borrow(args) {
    const memberId = args?.memberId;
    const bookId = args?.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid arguments');
    const day = admit(args?.date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown member or book');
    if (book.state === 'loan') return fail('book on loan');
    if (book.state === 'set' && book.queue[0].memberId !== memberId) {
      return fail('book set aside for another member');
    }
    if (book.state === 'available' && book.queue.length > 0) return fail('hold queue inconsistent');
    if (member.owed >= DEBT_LIMIT) return fail('debt limit');
    if (member.loans.some((l) => l.dueDay < day)) return fail('overdue loan');
    if (member.loans.length >= MAX_LOANS) return fail('loan limit');

    const dueDay = day + LOAN_DAYS;
    member.loans.push({ bookId, dueDay, renewals: 0 });
    if (book.state === 'set') book.queue.shift();
    book.state = 'loan';
    book.borrower = memberId;
    book.readyUntil = null;
    return { ok: true, dueDate: fmt(dueDay) };
  }

  function returnBook(args) {
    const memberId = args?.memberId;
    const bookId = args?.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid arguments');
    const day = admit(args?.date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown member or book');
    const idx = member.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0) return fail('not on loan to this member');

    const loan = member.loans[idx];
    const late = Math.max(0, day - loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
    member.owed += fine;
    member.loans.splice(idx, 1);

    book.borrower = null;
    if (book.queue.length > 0) {
      book.state = 'set';
      book.readyUntil = day + PICKUP_DAYS;
    } else {
      book.state = 'available';
      book.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const memberId = args?.memberId;
    const bookId = args?.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid arguments');
    const day = admit(args?.date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown member or book');
    const loan = member.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('not on loan to this member');
    if (day > loan.dueDay) return fail('overdue loan');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (book.queue.length > 0) return fail('someone is waiting');
    if (member.owed >= DEBT_LIMIT) return fail('debt limit');

    loan.dueDay += LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: fmt(loan.dueDay) };
  }

  function placeHold(args) {
    const memberId = args?.memberId;
    const bookId = args?.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid arguments');
    const day = admit(args?.date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('unknown member or book');
    if (book.state === 'available') return fail('book is available');
    if (member.loans.some((l) => l.bookId === bookId)) return fail('already on loan to this member');
    if (book.queue.some((e) => e.memberId === memberId)) return fail('hold already exists');

    seq += 1;
    book.queue.push({ memberId, seq });
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    const memberId = args?.memberId;
    const amount = args?.amount;
    if (!isId(memberId) || !Number.isInteger(amount)) return fail('invalid arguments');
    const day = admit(args?.date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    if (amount < 1) return fail('amount too small');
    if (amount > member.owed) return fail('overpayment');

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const memberId = args?.memberId;
    if (!isId(memberId)) return fail('invalid arguments');
    const day = admit(args?.date);
    if (day === null) return fail('invalid date');
    const member = members.get(memberId);
    if (!member) return fail('unknown member');

    const loans = member.loans.map((l) => ({ bookId: l.bookId, dueDate: fmt(l.dueDay) }));

    const found = [];
    for (const [bookId, book] of books) {
      const idx = book.queue.findIndex((e) => e.memberId === memberId);
      if (idx >= 0) {
        found.push({
          seq: book.queue[idx].seq,
          bookId,
          position: idx + 1,
          readyUntil: idx === 0 && book.state === 'set' ? fmt(book.readyUntil) : null,
        });
      }
    }
    found.sort((a, b) => a.seq - b.seq);
    const holds = found.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));

    return { loans, owed: member.owed, holds };
  }

  const safe = (fn) => (args) => {
    try {
      return fn(args);
    } catch {
      return fail('invalid input');
    }
  };

  return {
    addBook: safe(addBook),
    addMember: safe(addMember),
    borrow: safe(borrow),
    returnBook: safe(returnBook),
    renew: safe(renew),
    placeHold: safe(placeHold),
    payFine: safe(payFine),
    getMember: safe(getMember),
  };
}
