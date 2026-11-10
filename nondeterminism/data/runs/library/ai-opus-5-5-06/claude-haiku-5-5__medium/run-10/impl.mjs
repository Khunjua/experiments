const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;
const PICKUP_DAYS = 7;

function dayFromParts(y, m, d) {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / DAY_MS);
}

function parseDate(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  return dayFromParts(Number(m[1]), Number(m[2]), Number(m[3]));
}

function formatDay(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isObj(a) {
  return a !== null && typeof a === 'object';
}

function reject(reason) {
  return { ok: false, reason };
}

function guard(fn) {
  try {
    return fn();
  } catch {
    return reject('INVALID_INPUT');
  }
}

export function createLibrary() {
  const books = new Map();   // bookId -> { state: 'available'|'loan'|'set', loan, holds }
  const members = new Map(); // memberId -> { owed }
  let clock = null;          // day number of latest date seen
  let seq = 0;

  // Called when a book becomes free on `day`.
  function freeBook(book, day) {
    book.loan = null;
    if (book.holds.length === 0) {
      book.state = 'available';
      return;
    }
    book.state = 'set';
    book.holds[0].readyUntil = day + PICKUP_DAYS;
  }

  // Applies every hold pick-up expiration due up to and including `day`.
  function catchUp(day) {
    for (const book of books.values()) {
      while (book.state === 'set' && book.holds[0].readyUntil < day) {
        const r = book.holds[0].readyUntil;
        book.holds.shift();
        freeBook(book, r + 1);
      }
    }
  }

  // Validates the date, enforces ordering, moves the clock and runs catch-up.
  function startDated(date) {
    const d = parseDate(date);
    if (d === null) return { error: 'INVALID_INPUT' };
    if (clock !== null && d < clock) return { error: 'DATE_OUT_OF_ORDER' };
    clock = d;
    catchUp(d);
    return { day: d };
  }

  return {
    addBook(args) {
      return guard(() => {
        if (!isObj(args) || !validId(args.bookId)) return reject('INVALID_INPUT');
        const id = args.bookId;
        if (books.has(id)) return reject('DUPLICATE');
        books.set(id, { state: 'available', loan: null, holds: [] });
        return { ok: true };
      });
    },

    addMember(args) {
      return guard(() => {
        if (!isObj(args) || !validId(args.memberId)) return reject('INVALID_INPUT');
        const id = args.memberId;
        if (members.has(id)) return reject('DUPLICATE');
        members.set(id, { owed: 0 });
        return { ok: true };
      });
    },

    borrow(args) {
      return guard(() => {
        if (!isObj(args)) return reject('INVALID_INPUT');
        const t = startDated(args.date);
        if (t.error) return reject(t.error);
        const d = t.day;
        const memberId = args.memberId;
        const bookId = args.bookId;
        if (!validId(memberId) || !validId(bookId)) return reject('INVALID_INPUT');
        if (!members.has(memberId)) return reject('NO_MEMBER');
        const book = books.get(bookId);
        if (!book) return reject('NO_BOOK');
        if (book.state === 'loan') return reject('NOT_AVAILABLE');
        if (book.state === 'set' && book.holds[0].memberId !== memberId) {
          return reject('NOT_AVAILABLE');
        }
        if (book.state === 'set') {
          book.holds.shift();
        }
        const dueDay = d + LOAN_DAYS;
        book.loan = { memberId, dueDay, renewals: 0, seq: ++seq };
        book.state = 'loan';
        return { ok: true, dueDate: formatDay(dueDay) };
      });
    },

    placeHold(args) {
      return guard(() => {
        if (!isObj(args)) return reject('INVALID_INPUT');
        const t = startDated(args.date);
        if (t.error) return reject(t.error);
        const memberId = args.memberId;
        const bookId = args.bookId;
        if (!validId(memberId) || !validId(bookId)) return reject('INVALID_INPUT');
        if (!members.has(memberId)) return reject('NO_MEMBER');
        const book = books.get(bookId);
        if (!book) return reject('NO_BOOK');
        if (book.state === 'available') return reject('BOOK_AVAILABLE');
        if (book.loan && book.loan.memberId === memberId) return reject('ALREADY_BORROWED');
        if (book.holds.some((h) => h.memberId === memberId)) return reject('ALREADY_HOLDING');
        book.holds.push({ memberId, seq: ++seq, readyUntil: null });
        return { ok: true, position: book.holds.length };
      });
    },

    renew(args) {
      return guard(() => {
        if (!isObj(args)) return reject('INVALID_INPUT');
        const t = startDated(args.date);
        if (t.error) return reject(t.error);
        const d = t.day;
        const memberId = args.memberId;
        const bookId = args.bookId;
        if (!validId(memberId) || !validId(bookId)) return reject('INVALID_INPUT');
        if (!members.has(memberId)) return reject('NO_MEMBER');
        const book = books.get(bookId);
        if (!book) return reject('NO_BOOK');
        const loan = book.loan;
        if (!loan || loan.memberId !== memberId) return reject('NOT_ON_LOAN');
        if (d > loan.dueDay) return reject('OVERDUE');
        if (loan.renewals >= MAX_RENEWALS) return reject('RENEWAL_LIMIT');
        if (book.holds.length > 0) return reject('HAS_HOLDS');
        loan.dueDay = d + LOAN_DAYS;
        loan.renewals += 1;
        return { ok: true, dueDate: formatDay(loan.dueDay) };
      });
    },

    returnBook(args) {
      return guard(() => {
        if (!isObj(args)) return reject('INVALID_INPUT');
        const t = startDated(args.date);
        if (t.error) return reject(t.error);
        const d = t.day;
        const memberId = args.memberId;
        const bookId = args.bookId;
        if (!validId(memberId) || !validId(bookId)) return reject('INVALID_INPUT');
        const member = members.get(memberId);
        if (!member) return reject('NO_MEMBER');
        const book = books.get(bookId);
        if (!book) return reject('NO_BOOK');
        const loan = book.loan;
        if (!loan || loan.memberId !== memberId) return reject('NOT_ON_LOAN');
        const late = Math.max(0, d - loan.dueDay);
        const fine = Math.min(FINE_PER_DAY * late, MAX_FINE);
        member.owed += fine;
        freeBook(book, d);
        return { ok: true, fine };
      });
    },

    payFine(args) {
      return guard(() => {
        if (!isObj(args)) return reject('INVALID_INPUT');
        const t = startDated(args.date);
        if (t.error) return reject(t.error);
        const memberId = args.memberId;
        const amount = args.amount;
        if (!validId(memberId)) return reject('INVALID_INPUT');
        if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) {
          return reject('BAD_AMOUNT');
        }
        const member = members.get(memberId);
        if (!member) return reject('NO_MEMBER');
        if (amount > member.owed) return reject('BAD_AMOUNT');
        member.owed -= amount;
        return { ok: true, owed: member.owed };
      });
    },

    getMember(args) {
      return guard(() => {
        if (!isObj(args)) return reject('INVALID_INPUT');
        const t = startDated(args.date);
        if (t.error) return reject(t.error);
        const memberId = args.memberId;
        if (!validId(memberId)) return reject('INVALID_INPUT');
        const member = members.get(memberId);
        if (!member) return reject('NO_MEMBER');

        const loanList = [];
        const holdList = [];
        for (const [bookId, book] of books) {
          if (book.loan && book.loan.memberId === memberId) {
            loanList.push({
              seq: book.loan.seq,
              bookId,
              dueDate: formatDay(book.loan.dueDay),
            });
          }
          book.holds.forEach((h, i) => {
            if (h.memberId === memberId) {
              const isSetAside = i === 0 && book.state === 'set' && h.readyUntil !== null;
              holdList.push({
                seq: h.seq,
                bookId,
                position: i + 1,
                readyUntil: isSetAside ? formatDay(h.readyUntil) : null,
              });
            }
          });
        }
        loanList.sort((a, b) => a.seq - b.seq);
        holdList.sort((a, b) => a.seq - b.seq);

        return {
          loans: loanList.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate })),
          owed: member.owed,
          holds: holdList.map((h) => ({
            bookId: h.bookId,
            position: h.position,
            readyUntil: h.readyUntil,
          })),
        };
      });
    },
  };
}
