const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const BLOCK_THRESHOLD = 1000;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

// Returns an integer day number, or null if the string is not a real YYYY-MM-DD date.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY_MS);
}

function formatDate(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fail(reason = 'rejected') {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { status, loan, queue }
  const members = new Map(); // memberId -> { owed }
  let clock = null;          // day number of the most recent accepted dated call
  let nextLoanSeq = 0;
  let nextHoldOrder = 0;

  // §5.2: a book stops being held by someone on day `day`.
  function passToQueue(book, day) {
    if (book.queue.length === 0) {
      book.status = 'available';
      return;
    }
    book.status = 'readyForPickup';
    book.queue[0].readyUntil = day + PICKUP_DAYS;
  }

  // §5.3: process hold expirations up to and including day `today`.
  function processExpirations(today) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const book of books.values()) {
        if (book.status !== 'readyForPickup') continue;
        const head = book.queue[0];
        if (head && head.readyUntil < today) {
          book.queue.shift();
          passToQueue(book, head.readyUntil + 1);
          changed = true;
        }
      }
    }
  }

  // §3.5 steps 2 and 3. Returns false if the date is earlier than the clock.
  function startDated(day) {
    if (clock !== null && day < clock) return false;
    clock = day;
    processExpirations(day);
    return true;
  }

  function addBook(args) {
    if (!isObject(args)) return fail();
    const bookId = args.bookId;
    if (!isId(bookId)) return fail();
    if (books.has(bookId)) return fail();
    books.set(bookId, { status: 'available', loan: null, queue: [] });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObject(args)) return fail();
    const memberId = args.memberId;
    if (!isId(memberId)) return fail();
    if (members.has(memberId)) return fail();
    members.set(memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObject(args)) return fail();
    const memberId = args.memberId;
    const bookId = args.bookId;
    const day = parseDate(args.date);
    if (!isId(memberId) || !isId(bookId) || day === null) return fail();
    if (!startDated(day)) return fail('out of order');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail();
    if (member.owed >= BLOCK_THRESHOLD) return fail();
    if (book.status === 'onLoan') return fail();

    if (book.status === 'readyForPickup') {
      const head = book.queue[0];
      if (!head || head.memberId !== memberId) return fail();
      book.queue.shift();
    } else if (book.queue.length > 0) {
      return fail();
    }

    const dueDay = day + LOAN_DAYS;
    book.status = 'onLoan';
    book.loan = {
      memberId,
      borrowDay: day,
      dueDay,
      renewals: 0,
      seq: nextLoanSeq++,
    };
    return { ok: true, dueDate: formatDate(dueDay) };
  }

  function returnBook(args) {
    if (!isObject(args)) return fail();
    const memberId = args.memberId;
    const bookId = args.bookId;
    const day = parseDate(args.date);
    if (!isId(memberId) || !isId(bookId) || day === null) return fail();
    if (!startDated(day)) return fail('out of order');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail();
    if (book.status !== 'onLoan' || book.loan.memberId !== memberId) return fail();

    const daysLate = day - book.loan.dueDay;
    const fine = daysLate > 0 ? Math.min(daysLate * FINE_PER_DAY, FINE_CAP) : 0;
    member.owed += fine;
    book.loan = null;
    passToQueue(book, day);
    return { ok: true, fine };
  }

  function renew(args) {
    if (!isObject(args)) return fail();
    const memberId = args.memberId;
    const bookId = args.bookId;
    const day = parseDate(args.date);
    if (!isId(memberId) || !isId(bookId) || day === null) return fail();
    if (!startDated(day)) return fail('out of order');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail();
    if (book.status !== 'onLoan' || book.loan.memberId !== memberId) return fail();
    if (book.queue.length > 0) return fail();
    if (book.loan.renewals >= MAX_RENEWALS) return fail();
    if (day > book.loan.dueDay) return fail();
    if (member.owed >= BLOCK_THRESHOLD) return fail();

    book.loan.dueDay += LOAN_DAYS;
    book.loan.renewals += 1;
    return { ok: true, dueDate: formatDate(book.loan.dueDay) };
  }

  function placeHold(args) {
    if (!isObject(args)) return fail();
    const memberId = args.memberId;
    const bookId = args.bookId;
    const day = parseDate(args.date);
    if (!isId(memberId) || !isId(bookId) || day === null) return fail();
    if (!startDated(day)) return fail('out of order');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail();
    if (book.status === 'available') return fail();
    if (book.status === 'onLoan' && book.loan.memberId === memberId) return fail();
    if (book.queue.some((h) => h.memberId === memberId)) return fail();

    book.queue.push({ memberId, placedOrder: nextHoldOrder++, readyUntil: null });
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    if (!isObject(args)) return fail();
    const memberId = args.memberId;
    const amount = args.amount;
    const day = parseDate(args.date);
    if (!Number.isInteger(amount) || amount <= 0) return fail();
    if (!isId(memberId) || day === null) return fail();
    if (!startDated(day)) return fail('out of order');

    const member = members.get(memberId);
    if (!member) return fail();
    if (amount > member.owed) return fail();

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    if (!isObject(args)) return fail();
    const memberId = args.memberId;
    const day = parseDate(args.date);
    if (!isId(memberId) || day === null) return fail();
    if (!startDated(day)) return fail('out of order');

    const member = members.get(memberId);
    if (!member) return fail();

    const loanRows = [];
    const holdRows = [];
    for (const [bookId, book] of books) {
      if (book.status === 'onLoan' && book.loan.memberId === memberId) {
        loanRows.push({
          bookId,
          borrowDay: book.loan.borrowDay,
          seq: book.loan.seq,
          dueDay: book.loan.dueDay,
        });
      }
      book.queue.forEach((h, i) => {
        if (h.memberId === memberId) {
          holdRows.push({
            bookId,
            position: i + 1,
            readyUntil: h.readyUntil,
            order: h.placedOrder,
          });
        }
      });
    }

    loanRows.sort((a, b) => (a.borrowDay - b.borrowDay) || (a.seq - b.seq));
    holdRows.sort((a, b) => a.order - b.order);

    return {
      loans: loanRows.map((r) => ({ bookId: r.bookId, dueDate: formatDate(r.dueDay) })),
      owed: member.owed,
      holds: holdRows.map((r) => ({
        bookId: r.bookId,
        position: r.position,
        readyUntil: r.readyUntil === null ? null : formatDate(r.readyUntil),
      })),
    };
  }

  // Any unexpected exception is converted to a failure result.
  // All argument reads happen before any mutation, so state is unchanged on such failure.
  const guard = (fn) => (args) => {
    try {
      return fn(args);
    } catch {
      return fail('invalid');
    }
  };

  return {
    addBook: guard(addBook),
    addMember: guard(addMember),
    borrow: guard(borrow),
    returnBook: guard(returnBook),
    renew: guard(renew),
    placeHold: guard(placeHold),
    payFine: guard(payFine),
    getMember: guard(getMember),
  };
}
