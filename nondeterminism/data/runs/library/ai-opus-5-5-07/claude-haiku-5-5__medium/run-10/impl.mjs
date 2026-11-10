const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const BLOCK_THRESHOLD = 500;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Returns the day number (UTC epoch days) for a valid 'YYYY-MM-DD' string, or null.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt.getTime() / MS_PER_DAY;
}

function formatDate(n) {
  const dt = new Date(n * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function args(input) {
  return input !== null && typeof input === 'object' ? input : {};
}

function removeFrom(arr, value) {
  const idx = arr.indexOf(value);
  if (idx >= 0) arr.splice(idx, 1);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  // Expiry processing (section 5.4) for day number D.
  function expire(D) {
    for (const book of books.values()) {
      while (book.state === 'aside' && D > book.readyUntil) {
        const gone = book.holds.shift();
        const goneMember = members.get(gone);
        if (goneMember) removeFrom(goneMember.holdOrder, book.id);
        if (book.holds.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.readyUntil = null;
        }
      }
    }
  }

  // Wraps a method so that no exception can escape.
  const guard = (fn) => (input) => {
    try {
      return fn(input);
    } catch (e) {
      return { ok: false };
    }
  };

  function addBook(input) {
    const a = args(input);
    const id = a.bookId;
    if (!isId(id) || books.has(id)) return { ok: false };
    books.set(id, {
      id,
      state: 'available', // 'available' | 'loan' | 'aside'
      holder: null,       // member id while on loan
      dueDay: null,       // due day number while on loan
      renewals: 0,
      holds: [],          // hold line of member ids; holds[0] is reserved when aside
      readyUntil: null,   // day number while aside
    });
    return { ok: true };
  }

  function addMember(input) {
    const a = args(input);
    const id = a.memberId;
    if (!isId(id) || members.has(id)) return { ok: false };
    members.set(id, { id, owed: 0, loans: [], holdOrder: [] });
    return { ok: true };
  }

  function borrow(input) {
    const a = args(input);
    const D = parseDate(a.date);
    if (D === null) return { ok: false };
    expire(D);
    if (!isId(a.memberId) || !isId(a.bookId)) return { ok: false };
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return { ok: false };
    if (b.state === 'loan') return { ok: false };
    if (b.state === 'aside' && b.holds[0] !== m.id) return { ok: false };
    for (const id of m.loans) {
      if (books.get(id).dueDay < D) return { ok: false };
    }
    if (m.owed >= BLOCK_THRESHOLD) return { ok: false };

    if (b.state === 'aside') {
      b.holds.shift();
      removeFrom(m.holdOrder, b.id);
      b.readyUntil = null;
    }
    b.state = 'loan';
    b.holder = m.id;
    b.dueDay = D + LOAN_DAYS;
    b.renewals = 0;
    m.loans.push(b.id);
    return { ok: true, dueDate: formatDate(b.dueDay) };
  }

  function returnBook(input) {
    const a = args(input);
    const D = parseDate(a.date);
    if (D === null) return { ok: false };
    expire(D);
    if (!isId(a.memberId) || !isId(a.bookId)) return { ok: false };
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return { ok: false };
    if (b.state !== 'loan' || b.holder !== m.id) return { ok: false };

    const late = D - b.dueDay;
    const chargeable = Math.max(0, late - GRACE_DAYS);
    const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
    m.owed += fine;

    removeFrom(m.loans, b.id);
    b.holder = null;
    b.dueDay = null;
    b.renewals = 0;
    if (b.holds.length > 0) {
      b.state = 'aside';
      b.readyUntil = D + PICKUP_DAYS;
    } else {
      b.state = 'available';
      b.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(input) {
    const a = args(input);
    const D = parseDate(a.date);
    if (D === null) return { ok: false };
    expire(D);
    if (!isId(a.memberId) || !isId(a.bookId)) return { ok: false };
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return { ok: false };
    if (b.state !== 'loan' || b.holder !== m.id) return { ok: false };
    if (D > b.dueDay) return { ok: false };
    if (b.renewals >= MAX_RENEWALS) return { ok: false };
    if (b.holds.length > 0) return { ok: false };
    if (m.owed >= BLOCK_THRESHOLD) return { ok: false };

    b.dueDay = D + LOAN_DAYS;
    b.renewals += 1;
    return { ok: true, dueDate: formatDate(b.dueDay) };
  }

  function placeHold(input) {
    const a = args(input);
    const D = parseDate(a.date);
    if (D === null) return { ok: false };
    expire(D);
    if (!isId(a.memberId) || !isId(a.bookId)) return { ok: false };
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return { ok: false };
    if (b.state === 'available') return { ok: false };
    if (b.state === 'loan' && b.holder === m.id) return { ok: false };
    if (b.holds.includes(m.id)) return { ok: false };

    b.holds.push(m.id);
    m.holdOrder.push(b.id);
    return { ok: true, position: b.holds.length };
  }

  function payFine(input) {
    const a = args(input);
    const D = parseDate(a.date);
    if (D === null) return { ok: false };
    expire(D);
    const amount = a.amount;
    if (!isId(a.memberId) || !Number.isInteger(amount) || amount <= 0) return { ok: false };
    const m = members.get(a.memberId);
    if (!m) return { ok: false };
    if (amount > m.owed) return { ok: false };

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(input) {
    const a = args(input);
    const D = parseDate(a.date);
    if (D === null) return { ok: false };
    expire(D);
    if (!isId(a.memberId)) return { ok: false };
    const m = members.get(a.memberId);
    if (!m) return { ok: false };

    const loans = m.loans.map((id) => {
      const bk = books.get(id);
      return { bookId: id, dueDate: formatDate(bk.dueDay) };
    });
    const holds = m.holdOrder.map((id) => {
      const bk = books.get(id);
      const position = bk.holds.indexOf(m.id) + 1;
      const readyUntil =
        bk.state === 'aside' && bk.holds[0] === m.id ? formatDate(bk.readyUntil) : null;
      return { bookId: id, position, readyUntil };
    });
    return { loans, owed: m.owed, holds };
  }

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
