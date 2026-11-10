const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isObject(v) {
  return typeof v === 'object' && v !== null;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function rej(reason) {
  return { ok: false, reason };
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return (m === 4 || m === 6 || m === 9 || m === 11) ? 30 : 31;
}

// Days since 1970-01-01 in the proleptic Gregorian calendar (pure integer arithmetic).
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// Inverse of daysFromCivil, returns 'YYYY-MM-DD'.
function fromDay(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  let y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y += 1;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Returns a day number for a valid 'YYYY-MM-DD' string, otherwise null.
function toDay(str) {
  if (typeof str !== 'string') return null;
  const match = DATE_RE.exec(str);
  if (match === null) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function guard(fn) {
  return (args) => {
    try {
      return fn(args);
    } catch {
      return rej('INVALID_INPUT');
    }
  };
}

export function createLibrary() {
  // bookId -> { state: 'available'|'loan'|'aside', loan: {memberId, dueDay, renewals, seq} | null, line: [hold] }
  // hold -> { memberId, seq, readyUntil: dayNumber | null }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();
  let clock = null;
  let seq = 0;

  // The book becomes free on `day`. Set it aside for the head of the line, or make it available.
  function freeBook(book, day) {
    book.loan = null;
    if (book.line.length === 0) {
      book.state = 'available';
      return;
    }
    book.state = 'aside';
    book.line[0].readyUntil = day + PICKUP_DAYS;
  }

  // Apply every set-aside expiration due on or before `day`.
  // A hold valid through day R is removed on R + 1, and the book is freed on R + 1.
  function catchUp(day) {
    for (const book of books.values()) {
      while (book.state === 'aside' && book.line[0].readyUntil < day) {
        const freedOn = book.line[0].readyUntil + 1;
        book.line.shift();
        freeBook(book, freedOn);
      }
    }
  }

  // Defensive ordering check, then advance the clock and apply time-based events.
  function admit(day) {
    if (clock !== null && day < clock) return false;
    clock = day;
    catchUp(day);
    return true;
  }

  const api = {
    addBook: guard((args) => {
      if (!isObject(args)) return rej('INVALID_INPUT');
      const bookId = args.bookId;
      if (!isId(bookId)) return rej('INVALID_INPUT');
      if (books.has(bookId)) return rej('DUPLICATE');
      books.set(bookId, { state: 'available', loan: null, line: [] });
      return { ok: true };
    }),

    addMember: guard((args) => {
      if (!isObject(args)) return rej('INVALID_INPUT');
      const memberId = args.memberId;
      if (!isId(memberId)) return rej('INVALID_INPUT');
      if (members.has(memberId)) return rej('DUPLICATE');
      members.set(memberId, { owed: 0 });
      return { ok: true };
    }),

    borrow: guard((args) => {
      if (!isObject(args)) return rej('INVALID_INPUT');
      const memberId = args.memberId;
      const bookId = args.bookId;
      const day = toDay(args.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return rej('INVALID_INPUT');
      if (!admit(day)) return rej('DATE_OUT_OF_ORDER');
      if (!members.has(memberId)) return rej('NO_MEMBER');
      const book = books.get(bookId);
      if (!book) return rej('NO_BOOK');
      if (book.state === 'loan') return rej('NOT_AVAILABLE');
      if (book.state === 'aside' && book.line[0].memberId !== memberId) return rej('NOT_AVAILABLE');

      if (book.state === 'aside') {
        // Fulfils the hold. Later holds stay in line.
        book.line.shift();
      }
      book.state = 'loan';
      book.loan = { memberId, dueDay: day + LOAN_DAYS, renewals: 0, seq: ++seq };
      return { ok: true, dueDate: fromDay(book.loan.dueDay) };
    }),

    placeHold: guard((args) => {
      if (!isObject(args)) return rej('INVALID_INPUT');
      const memberId = args.memberId;
      const bookId = args.bookId;
      const day = toDay(args.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return rej('INVALID_INPUT');
      if (!admit(day)) return rej('DATE_OUT_OF_ORDER');
      if (!members.has(memberId)) return rej('NO_MEMBER');
      const book = books.get(bookId);
      if (!book) return rej('NO_BOOK');
      if (book.state === 'available') return rej('BOOK_AVAILABLE');
      if (book.loan !== null && book.loan.memberId === memberId) return rej('ALREADY_BORROWED');
      if (book.line.some((h) => h.memberId === memberId)) return rej('ALREADY_HOLDING');

      book.line.push({ memberId, seq: ++seq, readyUntil: null });
      return { ok: true, position: book.line.length };
    }),

    renew: guard((args) => {
      if (!isObject(args)) return rej('INVALID_INPUT');
      const memberId = args.memberId;
      const bookId = args.bookId;
      const day = toDay(args.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return rej('INVALID_INPUT');
      if (!admit(day)) return rej('DATE_OUT_OF_ORDER');
      if (!members.has(memberId)) return rej('NO_MEMBER');
      const book = books.get(bookId);
      if (!book) return rej('NO_BOOK');
      if (book.state !== 'loan' || book.loan.memberId !== memberId) return rej('NOT_ON_LOAN');
      const loan = book.loan;
      if (day > loan.dueDay) return rej('OVERDUE');
      if (loan.renewals >= MAX_RENEWALS) return rej('RENEWAL_LIMIT');
      if (book.line.length > 0) return rej('HAS_HOLDS');

      loan.dueDay = day + RENEWAL_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: fromDay(loan.dueDay) };
    }),

    returnBook: guard((args) => {
      if (!isObject(args)) return rej('INVALID_INPUT');
      const memberId = args.memberId;
      const bookId = args.bookId;
      const day = toDay(args.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return rej('INVALID_INPUT');
      if (!admit(day)) return rej('DATE_OUT_OF_ORDER');
      const member = members.get(memberId);
      if (!member) return rej('NO_MEMBER');
      const book = books.get(bookId);
      if (!book) return rej('NO_BOOK');
      if (book.state !== 'loan' || book.loan.memberId !== memberId) return rej('NOT_ON_LOAN');

      const lateDays = Math.max(0, day - book.loan.dueDay);
      const fine = Math.min(FINE_PER_DAY * lateDays, FINE_CAP);
      member.owed += fine;
      freeBook(book, day);
      return { ok: true, fine };
    }),

    payFine: guard((args) => {
      if (!isObject(args)) return rej('INVALID_INPUT');
      const memberId = args.memberId;
      const amount = args.amount;
      const day = toDay(args.date);
      if (!isId(memberId) || day === null) return rej('INVALID_INPUT');
      if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) {
        return rej('BAD_AMOUNT');
      }
      if (!admit(day)) return rej('DATE_OUT_OF_ORDER');
      const member = members.get(memberId);
      if (!member) return rej('NO_MEMBER');
      if (amount > member.owed) return rej('BAD_AMOUNT');

      member.owed -= amount;
      return { ok: true, owed: member.owed };
    }),

    getMember: guard((args) => {
      if (!isObject(args)) return rej('INVALID_INPUT');
      const memberId = args.memberId;
      const day = toDay(args.date);
      if (!isId(memberId) || day === null) return rej('INVALID_INPUT');
      if (!admit(day)) return rej('DATE_OUT_OF_ORDER');
      const member = members.get(memberId);
      if (!member) return rej('NO_MEMBER');

      const loanRows = [];
      const holdRows = [];
      for (const [bookId, book] of books) {
        if (book.state === 'loan' && book.loan.memberId === memberId) {
          loanRows.push({ seq: book.loan.seq, bookId, dueDate: fromDay(book.loan.dueDay) });
        }
        book.line.forEach((h, i) => {
          if (h.memberId === memberId) {
            const setAsideForMember = i === 0 && book.state === 'aside';
            holdRows.push({
              seq: h.seq,
              bookId,
              position: i + 1,
              readyUntil: setAsideForMember ? fromDay(h.readyUntil) : null,
            });
          }
        });
      }
      loanRows.sort((a, b) => a.seq - b.seq);
      holdRows.sort((a, b) => a.seq - b.seq);

      return {
        loans: loanRows.map((r) => ({ bookId: r.bookId, dueDate: r.dueDate })),
        owed: member.owed,
        holds: holdRows.map((r) => ({ bookId: r.bookId, position: r.position, readyUntil: r.readyUntil })),
      };
    }),
  };

  return api;
}
