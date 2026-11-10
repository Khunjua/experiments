// Scenarios for the library project, one or more per decision in truth.md.
// Each step is [method, args, expected]. `expected` names the fields we observe
// and holds the values the owner wants; null means the step is not observed.

export const factory = 'createLibrary';

// How list items are compared: only the interface fields, in this order.
export const shapes = {
  loans: ['bookId', 'dueDate'],
  holds: ['bookId', 'position', 'readyUntil'],
};

export function setup(sys, sc) {
  for (const bookId of sc.books ?? []) sys.addBook({ bookId });
  for (const memberId of sc.members ?? []) sys.addMember({ memberId });
}

const BASE = Date.UTC(2026, 2, 2); // 2026-03-02
const d = (n) => new Date(BASE + n * 86400000).toISOString().slice(0, 10);

const OK = { ok: true };
const NO = { ok: false };
const borrow = (m, b, n, e = null) => ['borrow', { memberId: m, bookId: b, date: d(n) }, e];
const ret = (m, b, n, e = null) => ['returnBook', { memberId: m, bookId: b, date: d(n) }, e];
const renew = (m, b, n, e = null) => ['renew', { memberId: m, bookId: b, date: d(n) }, e];
const hold = (m, b, n, e = null) => ['placeHold', { memberId: m, bookId: b, date: d(n) }, e];
const pay = (m, amount, n, e = null) => ['payFine', { memberId: m, amount, date: d(n) }, e];
const member = (m, n, e = null) => ['getMember', { memberId: m, date: d(n) }, e];

const one = { members: ['m1'], books: ['b1'] };
const six = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'];

export default [
  { id: 'D1-a', decision: 'D1', ...one, steps: [borrow('m1', 'b1', 0, { ok: true, dueDate: d(21) })] },

  { id: 'D2-a', decision: 'D2', members: ['m1'], books: six, steps: [
    ...six.slice(0, 5).map((b) => borrow('m1', b, 0, OK)),
    borrow('m1', 'b6', 0, NO),
  ] },
  { id: 'D2-b', decision: 'D2', members: ['m1'], books: six, steps: [
    ...six.slice(0, 5).map((b) => borrow('m1', b, 0, OK)),
    ret('m1', 'b1', 1, OK),
    borrow('m1', 'b6', 1, OK),
  ] },

  { id: 'D3-a', decision: 'D3', members: ['m1'], books: ['b1', 'b2', 'b3'], steps: [
    borrow('m1', 'b1', 0, OK), borrow('m1', 'b2', 0, OK),
    ret('m1', 'b1', 61, OK), ret('m1', 'b2', 61, OK),
    borrow('m1', 'b3', 61, NO),
  ] },
  { id: 'D3-b', decision: 'D3', members: ['m1'], books: ['b1', 'b2', 'b3'], steps: [
    borrow('m1', 'b1', 0, OK), borrow('m1', 'b2', 0, OK),
    ret('m1', 'b2', 40, OK), ret('m1', 'b1', 41, OK),
    borrow('m1', 'b3', 41, OK),
  ] },

  { id: 'D4-a', decision: 'D4', members: ['m1', 'm2'], books: ['b1'], steps: [
    borrow('m1', 'b1', 0), borrow('m2', 'b1', 1, NO),
  ] },

  { id: 'D5-a', decision: 'D5', ...one, steps: [borrow('m1', 'b1', 0), ret('m1', 'b1', 21, { ok: true, fine: 0 })] },
  { id: 'D5-b', decision: 'D5', ...one, steps: [borrow('m1', 'b1', 0), ret('m1', 'b1', 31, { ok: true, fine: 250 })] },

  { id: 'D6-a', decision: 'D6', ...one, steps: [borrow('m1', 'b1', 0), ret('m1', 'b1', 23, { ok: true, fine: 0 })] },
  { id: 'D6-b', decision: 'D6', ...one, steps: [borrow('m1', 'b1', 0), ret('m1', 'b1', 24, { ok: true, fine: 75 })] },

  { id: 'D7-a', decision: 'D7', ...one, steps: [borrow('m1', 'b1', 0), ret('m1', 'b1', 51, { ok: true, fine: 500 })] },

  { id: 'D8-a', decision: 'D8', ...one, steps: [ret('m1', 'b1', 0, NO)] },
  { id: 'D8-b', decision: 'D8', members: ['m1', 'm2'], books: ['b1'], steps: [
    borrow('m1', 'b1', 0), ret('m2', 'b1', 1, NO),
  ] },

  { id: 'D9-a', decision: 'D9', ...one, steps: [borrow('m1', 'b1', 0), renew('m1', 'b1', 10, { ok: true, dueDate: d(42) })] },

  { id: 'D10-a', decision: 'D10', ...one, steps: [
    borrow('m1', 'b1', 0), renew('m1', 'b1', 1, OK), renew('m1', 'b1', 2, OK), renew('m1', 'b1', 3, NO),
  ] },

  { id: 'D11-a', decision: 'D11', members: ['m1', 'm2'], books: ['b1'], steps: [
    borrow('m1', 'b1', 0), hold('m2', 'b1', 1), renew('m1', 'b1', 2, NO),
  ] },

  { id: 'D12-a', decision: 'D12', ...one, steps: [borrow('m1', 'b1', 0), renew('m1', 'b1', 22, NO)] },
  { id: 'D12-b', decision: 'D12', ...one, steps: [borrow('m1', 'b1', 0), renew('m1', 'b1', 21, OK)] },

  { id: 'D13-a', decision: 'D13', ...one, steps: [hold('m1', 'b1', 0, NO)] },
  { id: 'D13-b', decision: 'D13', members: ['m1', 'm2', 'm3'], books: ['b1'], steps: [
    borrow('m1', 'b1', 0), hold('m2', 'b1', 1), ret('m1', 'b1', 5), hold('m3', 'b1', 6, { ok: true, position: 2 }),
  ] },

  { id: 'D14-a', decision: 'D14', ...one, steps: [borrow('m1', 'b1', 0), hold('m1', 'b1', 1, NO)] },
  { id: 'D14-b', decision: 'D14', members: ['m1', 'm2'], books: ['b1'], steps: [
    borrow('m1', 'b1', 0), hold('m2', 'b1', 1), hold('m2', 'b1', 2, NO),
  ] },

  { id: 'D15-a', decision: 'D15', members: ['m1', 'm2', 'm3'], books: ['b1'], steps: [
    borrow('m1', 'b1', 0), hold('m2', 'b1', 1, { ok: true, position: 1 }), hold('m3', 'b1', 2, { ok: true, position: 2 }),
  ] },

  { id: 'D16-a', decision: 'D16', members: ['m1', 'm2', 'm3'], books: ['b1'], steps: [
    borrow('m1', 'b1', 0), hold('m2', 'b1', 1), ret('m1', 'b1', 5),
    borrow('m3', 'b1', 6, NO),
    member('m2', 6, { holds: [{ bookId: 'b1', position: 1, readyUntil: d(8) }] }),
    borrow('m2', 'b1', 8, OK),
  ] },

  { id: 'D17-a', decision: 'D17', members: ['m1', 'm2', 'm3'], books: ['b1'], steps: [
    borrow('m1', 'b1', 0), hold('m2', 'b1', 1), hold('m3', 'b1', 2), ret('m1', 'b1', 5),
    member('m2', 9, { holds: [] }),
    member('m3', 9, { holds: [{ bookId: 'b1', position: 1, readyUntil: d(11) }] }),
    borrow('m3', 'b1', 11, OK),
  ] },
  { id: 'D17-b', decision: 'D17', members: ['m1', 'm2', 'm4'], books: ['b1'], steps: [
    borrow('m1', 'b1', 0), hold('m2', 'b1', 1), ret('m1', 'b1', 5), borrow('m4', 'b1', 9, OK),
  ] },

  { id: 'D18-a', decision: 'D18', members: ['m1', 'm2', 'm3'], books: ['b1'], steps: [
    borrow('m1', 'b1', 0), hold('m2', 'b1', 1), hold('m3', 'b1', 2), ret('m1', 'b1', 5),
    borrow('m2', 'b1', 6, OK),
    member('m3', 6, { holds: [{ bookId: 'b1', position: 1, readyUntil: null }] }),
  ] },

  { id: 'D19-a', decision: 'D19', ...one, steps: [borrow('m1', 'b1', 0), ret('m1', 'b1', 31), pay('m1', 25, 31, OK)] },
  { id: 'D19-b', decision: 'D19', ...one, steps: [borrow('m1', 'b1', 0), ret('m1', 'b1', 31), pay('m1', 1250, 31, NO)] },
  { id: 'D19-c', decision: 'D19', ...one, steps: [borrow('m1', 'b1', 0), ret('m1', 'b1', 31), pay('m1', 0, 31, NO)] },

  { id: 'D20-a', decision: 'D20', indifferent: true, members: ['m1'], books: ['b1', 'b2', 'b3'], steps: [
    borrow('m1', 'b2', 0), borrow('m1', 'b1', 0), borrow('m1', 'b3', 0),
    member('m1', 0, { loans: [
      { bookId: 'b1', dueDate: d(21) }, { bookId: 'b2', dueDate: d(21) }, { bookId: 'b3', dueDate: d(21) },
    ] }),
  ] },
];
