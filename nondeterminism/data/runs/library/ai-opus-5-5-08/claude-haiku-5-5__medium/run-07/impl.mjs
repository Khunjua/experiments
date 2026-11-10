const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_EXTENSION = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const MAX_LOANS = 5;
const DEBT_BLOCK = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function isObject(x) {
  return x !== null && typeof x === 'object';
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

// Returns integer day number (days since epoch, UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / DAY_MS);
}

function formatDate(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function createLibrary() {
  // bookId -> { loanedTo: memberId|null, queue: [memberId], readyUntil: dayNum|null }
  const books = new Map();
  // memberId -> { loans: Map(bookId -> { due: dayNum, renewals: number }), owed: number, holds: [bookId] }
  const members = new Map();

  // Lazy hold expiration (section 3.5).
  function expire(now) {
    for (const [bookId, book] of books) {
      while (
        book.loanedTo === null &&
        book.queue.length > 0 &&
        book.readyUntil !== null &&
        now > book.readyUntil
      ) {
        const prev = book.readyUntil;
        const gone = book.queue.shift();
        const goneMember = members.get(gone);
        if (goneMember) {
          goneMember.holds = goneMember.holds.filter((h) => h !== bookId);
        }
        if (book.queue.length > 0) {
          book.readyUntil = prev + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates the argument object and date, then runs time processing.
  // Returns the day number of the date, or null if the call must fail
  // before any processing.
  function start(args) {
    if (!isObject(args)) return null;
    const now = parseDate(args.date);
    if (now === null) return null;
    expire(now);
    return now;
  }

  function addBook(args) {
    if (!isObject(args)) return { ok: false };
    const bookId = args.bookId;
    if (!isId(bookId) || books.has(bookId)) return { ok: false };
    books.set(bookId, { loanedTo: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObject(args)) return { ok: false };
    const memberId = args.memberId;
    if (!isId(memberId) || members.has(memberId)) return { ok: false };
    members.set(memberId, { loans: new Map(), owed: 0, holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const now = start(args);
    if (now === null) return { ok: false };
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };

    // On loan (including to this member).
    if (book.loanedTo !== null) return { ok: false };
    // Set aside for someone else (or defensive shelf-with-queue check).
    if (book.queue.length > 0 && book.queue[0] !== memberId) return { ok: false };
    if (member.loans.size >= MAX_LOANS) return { ok: false };
    if (member.owed >= DEBT_BLOCK) return { ok: false };
    for (const loan of member.loans.values()) {
      if (loan.due < now) return { ok: false };
    }

    const due = now + LOAN_DAYS;
    member.loans.set(bookId, { due, renewals: 0 });
    book.loanedTo = memberId;
    if (book.queue.length > 0) {
      // Book was set aside for this member: consume the hold.
      book.queue.shift();
      member.holds = member.holds.filter((h) => h !== bookId);
    }
    book.readyUntil = null;
    return { ok: true, dueDate: formatDate(due) };
  }

  function returnBook(args) {
    const now = start(args);
    if (now === null) return { ok: false };
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    const loan = member.loans.get(bookId);
    if (!loan || book.loanedTo !== memberId) return { ok: false };

    const daysLate = Math.max(0, now - loan.due);
    const chargeable = Math.max(0, daysLate - GRACE_DAYS);
    const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);

    member.owed += fine;
    member.loans.delete(bookId);
    book.loanedTo = null;
    if (book.queue.length > 0) {
      book.readyUntil = now + PICKUP_DAYS;
    } else {
      book.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const now = start(args);
    if (now === null) return { ok: false };
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    const loan = member.loans.get(bookId);
    if (!loan || book.loanedTo !== memberId) return { ok: false };
    if (loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (now > loan.due) return { ok: false };
    if (book.queue.length > 0) return { ok: false };

    loan.due += RENEW_EXTENSION;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.due) };
  }

  function placeHold(args) {
    const now = start(args);
    if (now === null) return { ok: false };
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };

    // On shelf: borrow instead.
    if (book.loanedTo === null && book.queue.length === 0) return { ok: false };
    if (member.loans.has(bookId)) return { ok: false };
    if (book.queue.includes(memberId)) return { ok: false };
    if (member.holds.length >= MAX_HOLDS) return { ok: false };

    book.queue.push(memberId);
    member.holds.push(bookId);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    const now = start(args);
    if (now === null) return { ok: false };
    const memberId = args.memberId;
    const amount = args.amount;
    if (!isId(memberId)) return { ok: false };
    const member = members.get(memberId);
    if (!member) return { ok: false };
    if (!Number.isSafeInteger(amount) || amount < 1) return { ok: false };
    if (amount > member.owed) return { ok: false };

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const now = start(args);
    if (now === null) return { ok: false };
    const memberId = args.memberId;
    if (!isId(memberId)) return { ok: false };
    const member = members.get(memberId);
    if (!member) return { ok: false };

    const loanEntries = [...member.loans.entries()].map(([bookId, loan]) => ({
      bookId,
      due: loan.due,
    }));
    loanEntries.sort((a, b) => {
      if (a.due !== b.due) return a.due - b.due;
      return compareStrings(a.bookId, b.bookId);
    });
    const loans = loanEntries.map((e) => ({
      bookId: e.bookId,
      dueDate: formatDate(e.due),
    }));

    const holds = member.holds.map((bookId) => {
      const book = books.get(bookId);
      const position = book.queue.indexOf(memberId) + 1;
      const setAside =
        position === 1 && book.loanedTo === null && book.readyUntil !== null;
      return {
        bookId,
        position,
        readyUntil: setAside ? formatDate(book.readyUntil) : null,
      };
    });

    return { ok: true, loans, owed: member.owed, holds };
  }

  // Ensure no method ever throws, whatever the input.
  function safe(fn) {
    return (args) => {
      try {
        return fn(args);
      } catch {
        return { ok: false };
      }
    };
  }

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
