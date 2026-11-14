'use strict';
/* ------------------------------------------------------------------
   Library Management System: Node.js + SQLite backend
   - No framework needed. Uses Node's built-in http, crypto and SQLite.
   - Needs Node 22.13+ (built-in node:sqlite) OR run `npm install`
     to use the better-sqlite3 fallback on older Node versions.
   - Run:  npm start   then open http://localhost:3000
------------------------------------------------------------------- */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

/* ---------- database (node:sqlite, falling back to better-sqlite3) ---------- */
let DB;
try { const { DatabaseSync } = require('node:sqlite'); DB = new DatabaseSync(path.join(DATA, 'library.db')); }
catch (e) {
  try { DB = new (require('better-sqlite3'))(path.join(DATA, 'library.db')); }
  catch (e2) { console.error('SQLite is not available. Use Node 22.13+ or run: npm install'); process.exit(1); }
}
DB.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
const run = (s, ...p) => DB.prepare(s).run(...p.map(x => x === undefined ? null : x));
const get = (s, ...p) => DB.prepare(s).get(...p.map(x => x === undefined ? null : x));
const all = (s, ...p) => DB.prepare(s).all(...p.map(x => x === undefined ? null : x)).map(r => ({ ...r }));
const tx = f => { DB.exec('BEGIN'); try { const r = f(); DB.exec('COMMIT'); return r; } catch (e) { DB.exec('ROLLBACK'); throw e; } };
const ins = (t, o) => { const k = Object.keys(o); run(`INSERT INTO "${t}"(${k.map(x => `"${x}"`).join(',')}) VALUES(${k.map(() => '?').join(',')})`, ...k.map(x => o[x])); };

DB.exec(`
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS cats(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS authors(id TEXT PRIMARY KEY, name TEXT NOT NULL, bio TEXT);
CREATE TABLE IF NOT EXISTS pubs(id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT);
CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY, title TEXT NOT NULL,
  authorId TEXT REFERENCES authors(id), catId TEXT REFERENCES cats(id), pubId TEXT REFERENCES pubs(id),
  isbn TEXT, copies INTEGER NOT NULL DEFAULT 1, price REAL DEFAULT 0, year INTEGER, added TEXT, ebook TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT, dept TEXT, roll TEXT,
  pw TEXT NOT NULL, sq INTEGER DEFAULT 1, sa TEXT, status TEXT DEFAULT 'pending', joined TEXT);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, pw TEXT NOT NULL, role TEXT NOT NULL, sq INTEGER DEFAULT 1, sa TEXT);
CREATE TABLE IF NOT EXISTS depts(id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staff(id TEXT PRIMARY KEY, name TEXT NOT NULL, desig TEXT, phone TEXT);
CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY, bookId TEXT REFERENCES books(id) ON DELETE SET NULL, mid TEXT REFERENCES members(id) ON DELETE SET NULL,
  issued TEXT, due TEXT, ret TEXT, renew INTEGER DEFAULT 0, paid INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS reserve(id TEXT PRIMARY KEY, bookId TEXT REFERENCES books(id) ON DELETE SET NULL, mid TEXT REFERENCES members(id) ON DELETE SET NULL, date TEXT, status TEXT);
CREATE TABLE IF NOT EXISTS renewq(id TEXT PRIMARY KEY, issueId TEXT REFERENCES issues(id) ON DELETE CASCADE, status TEXT);
CREATE TABLE IF NOT EXISTS lost(id TEXT PRIMARY KEY, bookId TEXT REFERENCES books(id) ON DELETE SET NULL, mid TEXT REFERENCES members(id) ON DELETE SET NULL, type TEXT, date TEXT, charge REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS suppliers(id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT, addr TEXT);
CREATE TABLE IF NOT EXISTS purchases(id TEXT PRIMARY KEY, bookId TEXT REFERENCES books(id) ON DELETE SET NULL, supplierId TEXT REFERENCES suppliers(id) ON DELETE SET NULL, qty INTEGER, cost REAL, date TEXT);
CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, date TEXT);
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT, place TEXT, "desc" TEXT);
CREATE TABLE IF NOT EXISTS faqs(id TEXT PRIMARY KEY, q TEXT NOT NULL, a TEXT);
CREATE TABLE IF NOT EXISTS notifs(id TEXT PRIMARY KEY, mid TEXT REFERENCES members(id) ON DELETE CASCADE, text TEXT, date TEXT, "read" INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, type TEXT, uid TEXT, exp INTEGER);
CREATE INDEX IF NOT EXISTS ix_issues_book ON issues(bookId); CREATE INDEX IF NOT EXISTS ix_issues_mid ON issues(mid);
`);
const ORDER = ['renewq', 'notifs', 'issues', 'reserve', 'lost', 'purchases', 'books', 'suppliers', 'authors', 'cats', 'pubs', 'depts', 'staff', 'notices', 'events', 'faqs', 'members', 'users'];

/* ---------- helpers ---------- */
const DAY = 864e5, uid = () => crypto.randomBytes(4).toString('hex');
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
const MO = ['জানু', 'ফেব্রু', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টে', 'অক্টো', 'নভে', 'ডিসে'];
const bnd = s => String(s).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[d]);
const fdb = iso => { const d = new Date(iso); return bnd(d.getUTCDate()) + ' ' + MO[d.getUTCMonth()] + ' ' + bnd(d.getUTCFullYear()); };
const norm = s => String(s || '').trim().toLowerCase();
const hashPw = s => { const salt = crypto.randomBytes(16); return salt.toString('hex') + ':' + crypto.scryptSync(String(s), salt, 32).toString('hex'); };
const verify = (s, h) => { if (!h || !h.includes(':')) return false; const [sl, hx] = h.split(':'), a = crypto.scryptSync(String(s), Buffer.from(sl, 'hex'), 32), b = Buffer.from(hx, 'hex'); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const bad = (code, en, bn) => { const e = new Error(en); e.code = code; e.pair = [en, bn]; return e; };
const ALL = ['অ্যাডমিন', 'লাইব্রেরিয়ান', 'সহকারী'], MGR = ALL.slice(0, 2), ADM = [ALL[0]];
const notify = (mid, text) => ins('notifs', { id: 't' + uid(), mid, text, date: today(), read: 0 });
const strip = u => { const { pw, sa, ...r } = u; return r; };

function settings() {
  const o = {}; all('SELECT * FROM settings').forEach(r => o[r.k] = r.v);
  ['fine', 'loan', 'max', 'rmax'].forEach(k => o[k] = +o[k] || 0);
  return o;
}
/* Editable site texts and department list: defaults are filled in only where missing, so older databases upgrade safely */
const NEWSET = { hero: 'জ্ঞানের আলোয় আলোকিত হোক আগামী', herod: 'বই খুঁজুন, রিজার্ভ করুন, ই-বুক পড়ুন এবং আপনার লাইব্রেরি অ্যাকাউন্ট এক জায়গায় পরিচালনা করুন।', days: 'শনি–বৃহস্পতি', links: 'বই ক্যাটালগ|#catalogue\nসদস্য নিবন্ধন|#register\nনিয়মাবলি|#rules', hero_en: '', herod_en: '', days_en: '', logo: '' };
const ensureSettings = () => Object.entries(NEWSET).forEach(([k, v]) => run('INSERT OR IGNORE INTO settings VALUES(?,?)', k, v));
const DEPTS0 = ['কম্পিউটার', 'ইলেকট্রিক্যাল', 'সিভিল', 'মেকানিক্যাল', 'ইলেকট্রনিক্স', 'পাওয়ার'];
function ensureDepts() {
  if (get('SELECT COUNT(*) n FROM depts').n) return;
  const names = [...DEPTS0]; all("SELECT DISTINCT dept FROM members WHERE dept IS NOT NULL AND dept<>''").forEach(r => { if (!names.includes(r.dept)) names.push(r.dept); });
  names.forEach(name => ins('depts', { id: 'd' + uid(), name }));
}
const outN = id => get('SELECT COUNT(*) n FROM issues WHERE bookId=? AND ret IS NULL', id).n;
const lostN = id => get("SELECT COUNT(*) n FROM lost WHERE bookId=? AND type='হারানো'", id).n;
const availN = b => b.copies - outN(b.id) - lostN(b.id);
const lateDays = i => Math.max(0, Math.round((Date.parse(i.ret || today()) - Date.parse(i.due)) / DAY));

/* ---------- demo data ---------- */
function seed() {
  tx(() => {
    ORDER.forEach(t => run(`DELETE FROM "${t}"`)); run('DELETE FROM settings'); run('DELETE FROM sessions');
    const ah = hashPw('admin123'), mh = hashPw('member123'), sa = hashPw('dhaka'), d = n => addDays(today(), n);
    Object.entries({ name: 'কক্সবাজার পলিটেকনিক ইনস্টিটিউট লাইব্রেরি', en: "Cox's Bazar Polytechnic Institute Library", addr: 'কক্সবাজার সদর, কক্সবাজার', phone: '০১৭০০-০০০০০০', email: 'library@cpi.example.bd', fine: 5, loan: 14, max: 3, rmax: 2, open: '০৯:০০', close: '১৭:০০' }).forEach(([k, v]) => run('INSERT INTO settings VALUES(?,?)', k, String(v)));
    ['উপন্যাস', 'কবিতা', 'বিজ্ঞান', 'ইতিহাস', 'কম্পিউটার সায়েন্স', 'কারিগরি ও প্রকৌশল'].forEach((name, i) => ins('cats', { id: 'c' + i, name }));
    [['রবীন্দ্রনাথ ঠাকুর', 'বাংলা সাহিত্যের প্রথম নোবেল বিজয়ী'], ['কাজী নজরুল ইসলাম', 'জাতীয় কবি'], ['হুমায়ূন আহমেদ', 'জনপ্রিয় কথাসাহিত্যিক'], ['জীবনানন্দ দাশ', 'রূপসী বাংলার কবি'], ['বিভূতিভূষণ বন্দ্যোপাধ্যায়', 'কথাসাহিত্যিক'], ['মানিক বন্দ্যোপাধ্যায়', 'কথাসাহিত্যিক'], ['মুহম্মদ জাফর ইকবাল', 'বিজ্ঞান লেখক ও শিক্ষাবিদ'], ['সৈয়দ ওয়ালীউল্লাহ', 'কথাসাহিত্যিক'], ['শেখ মুজিবুর রহমান', 'বাংলাদেশের স্থপতি'], ['থমাস এইচ. কোরমেন', 'অ্যালগরিদম বিশেষজ্ঞ'], ['রবার্ট সি. মার্টিন', 'সফটওয়্যার ইঞ্জিনিয়ার'], ['স্টিফেন হকিং', 'তাত্ত্বিক পদার্থবিদ'], ['বি. এল. থেরাজা', 'প্রকৌশল লেখক']].forEach((x, i) => ins('authors', { id: 'a' + i, name: x[0], bio: x[1] }));
    [['প্রথমা প্রকাশন', 'ঢাকা'], ['অন্যপ্রকাশ', 'ঢাকা'], ['সময় প্রকাশন', 'ঢাকা'], ['এস. চাঁদ অ্যান্ড কোম্পানি', 'নয়াদিল্লি'], ['এমআইটি প্রেস', 'যুক্তরাষ্ট্র']].forEach((x, i) => ins('pubs', { id: 'p' + i, name: x[0], city: x[1] }));
    [['গীতাঞ্জলি', 'a0', 'c1', 'p2', 4, 1], ['অগ্নিবীণা', 'a1', 'c1', 'p2', 3, 0], ['দেয়াল', 'a2', 'c0', 'p1', 3, 1], ['রূপসী বাংলা', 'a3', 'c1', 'p2', 2, 0], ['পথের পাঁচালী', 'a4', 'c0', 'p2', 4, 1], ['পদ্মা নদীর মাঝি', 'a5', 'c0', 'p2', 3, 0], ['কপোট্রনিক সুখ দুঃখ', 'a6', 'c2', 'p1', 3, 0], ['লালসালু', 'a7', 'c0', 'p0', 3, 1], ['অসমাপ্ত আত্মজীবনী', 'a8', 'c3', 'p0', 5, 0], ['Introduction to Algorithms', 'a9', 'c4', 'p4', 3, 0], ['Clean Code', 'a10', 'c4', 'p3', 2, 0], ['সংক্ষিপ্ত কালের ইতিহাস', 'a11', 'c2', 'p0', 2, 0], ['Basic Electrical Engineering', 'a12', 'c5', 'p3', 6, 0]]
      .forEach((b, i) => ins('books', { id: 'b' + i, title: b[0], authorId: b[1], catId: b[2], pubId: b[3], copies: b[4], isbn: '978-984-' + (3100 + i * 29) + '-' + (10 + i), price: 150 + i * 35, year: 2005 + i, added: d(-i * 9), ebook: b[5] ? 'https://bn.wikisource.org' : '' }));
    [['রহিম উদ্দিন', 'rahim@student.com', '০১৭১১-১১১১১১', 'কম্পিউটার', '২০২৪০১'], ['নুসরাত জাহান', 'nusrat@student.com', '০১৮১৮-২২২২২২', 'ইলেকট্রিক্যাল', '২০২৪০২'], ['সাকিব হাসান', 'sakib@student.com', '০১৯১৯-৩৩৩৩৩৩', 'সিভিল', '২০২৪০৩']]
      .forEach((x, i) => ins('members', { id: 'm' + i, name: x[0], email: x[1], phone: x[2], dept: x[3], roll: x[4], pw: mh, sq: 1, sa, status: i < 2 ? 'active' : 'pending', joined: d(-(60 - i * 20)) }));
    [['প্রধান প্রশাসক', 'admin@cpi.edu.bd', ALL[0]], ['লাইব্রেরিয়ান', 'librarian@cpi.edu.bd', ALL[1]], ['সহকারী', 'assistant@cpi.edu.bd', ALL[2]]]
      .forEach((x, i) => ins('users', { id: 'u' + i, name: x[0], email: x[1], pw: ah, role: x[2], sq: 1, sa }));
    [['মো. আব্দুল করিম', 'প্রধান গ্রন্থাগারিক', '০১৭১২-৪৪৪৪৪৪'], ['ফারজানা আক্তার', 'সহকারী গ্রন্থাগারিক', '০১৮১২-৫৫৫৫৫৫'], ['মো. জসিম উদ্দিন', 'অফিস সহকারী', '০১৯১২-৬৬৬৬৬৬']].forEach((x, i) => ins('staff', { id: 's' + i, name: x[0], desig: x[1], phone: x[2] }));
    const is = (id, b, m, a, du, r) => ins('issues', { id, bookId: b, mid: m, issued: d(-a), due: d(du), ret: r ? d(-r) : null, renew: 0, paid: 0 });
    is('i0', 'b9', 'm0', 20, -6); is('i1', 'b3', 'm1', 5, 9); is('i2', 'b6', 'm0', 3, 11); is('i3', 'b0', 'm1', 30, -16, 18);
    ins('reserve', { id: 'r0', bookId: 'b9', mid: 'm1', date: d(-2), status: 'অপেক্ষমান' });
    ins('renewq', { id: 'q0', issueId: 'i2', status: 'অপেক্ষমান' });
    ins('lost', { id: 'l0', bookId: 'b11', mid: 'm1', type: 'ক্ষতিগ্রস্ত', date: d(-12), charge: 80 });
    [['নালন্দা বুক হাউস', '০১৭৫৫-০০০০০১', 'নীলক্ষেত, ঢাকা'], ['বইপত্র লিমিটেড', '০১৬৩৩-০০০০০২', 'বাংলাবাজার, ঢাকা']].forEach((x, i) => ins('suppliers', { id: 'v' + i, name: x[0], phone: x[1], addr: x[2] }));
    ins('purchases', { id: 'x0', bookId: 'b8', supplierId: 'v0', qty: 2, cost: 320, date: d(-15) }); ins('purchases', { id: 'x1', bookId: 'b10', supplierId: 'v1', qty: 1, cost: 540, date: d(-8) });
    [['একুশে বইমেলা উপলক্ষে বিশেষ প্রদর্শনী', 'ফেব্রুয়ারি মাসজুড়ে লাইব্রেরিতে ভাষা আন্দোলন ও মুক্তিযুদ্ধবিষয়ক বইয়ের বিশেষ প্রদর্শনী চলবে।', -2], ['নতুন ২০০ বই যুক্ত হয়েছে', 'সাহিত্য, প্রযুক্তি ও কারিগরি বিভাগে নতুন বই এসেছে। আজই সংগ্রহ করুন।', -6], ['মেয়াদোত্তীর্ণ বই ফেরতের অনুরোধ', 'যাদের বইয়ের মেয়াদ শেষ হয়েছে তারা দ্রুত ফেরত দিন, নতুবা জরিমানা প্রযোজ্য হবে।', -9]].forEach((x, i) => ins('notices', { id: 'n' + i, title: x[0], body: x[1], date: d(x[2]) }));
    ins('events', { id: 'e0', title: 'বই পড়া প্রতিযোগিতা', date: d(10), place: 'লাইব্রেরি হল', desc: 'সব বিভাগের শিক্ষার্থীরা অংশ নিতে পারবে। বিজয়ীদের জন্য পুরস্কার।' });
    ins('events', { id: 'e1', title: 'ডিজিটাল লাইব্রেরি কর্মশালা', date: d(24), place: 'কম্পিউটার ল্যাব', desc: 'ই-বুক ও অনলাইন রিসোর্স ব্যবহারের হাতে-কলমে প্রশিক্ষণ।' });
    [['কীভাবে লাইব্রেরির সদস্য হব?', 'অনলাইনে সদস্য নিবন্ধন ফর্ম পূরণ করুন। লাইব্রেরিয়ান অনুমোদন দিলে লগইন করতে পারবেন।'], ['একসঙ্গে কয়টি বই নেওয়া যায়?', 'একজন সদস্য একসঙ্গে সর্বোচ্চ ৩টি বই নিতে পারেন।'], ['বই কতদিন রাখা যায়?', '১৪ দিন। প্রয়োজনে সর্বোচ্চ ২ বার মেয়াদ বাড়ানোর আবেদন করা যায়।'], ['দেরিতে ফেরত দিলে জরিমানা কত?', 'প্রতিদিন ৫ টাকা হারে জরিমানা প্রযোজ্য।'], ['বই হারিয়ে গেলে কী করব?', 'দ্রুত লাইব্রেরিয়ানকে জানান। বইয়ের মূল্য অনুযায়ী ক্ষতিপূরণ দিতে হবে।']].forEach((x, i) => ins('faqs', { id: 'f' + i, q: x[0], a: x[1] }));
    ins('notifs', { id: 't0', mid: 'm0', text: 'আপনার একটি বইয়ের মেয়াদ শেষ হয়েছে। দ্রুত ফেরত দিন।', date: d(-1), read: 0 });
    ensureSettings(); ensureDepts();
  });
}
if (!get('SELECT COUNT(*) n FROM cats').n && !get('SELECT COUNT(*) n FROM users').n) seed();
ensureSettings(); ensureDepts();

/* ---------- sessions & security ---------- */
function startSession(type, uid_) { const t = crypto.randomBytes(32).toString('hex'); run('DELETE FROM sessions WHERE exp<?', Date.now()); run('INSERT INTO sessions VALUES(?,?,?,?)', t, type, uid_, Date.now() + 7 * DAY); return t; }
function sessOf(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || ''); if (!m) return null;
  const s = get('SELECT * FROM sessions WHERE token=?', m[1]); if (!s || s.exp < Date.now()) return null;
  const u = get(s.type === 'admin' ? 'SELECT * FROM users WHERE id=?' : 'SELECT * FROM members WHERE id=?', s.uid);
  if (!u || (s.type === 'member' && u.status !== 'active')) return null;
  return { token: m[1], t: s.type, u };
}
const hits = new Map();
function limit(ip, key, max, win) { const k = key + ip, n = Date.now(), h = (hits.get(k) || []).filter(t => n - t < win); if (h.length >= max) throw bad(429, 'Too many attempts. Please wait a few minutes and try again.', 'অনেকবার চেষ্টা হয়েছে। কয়েক মিনিট পরে আবার চেষ্টা করুন।'); return h; }
const note = (ip, key, win, h) => { h.push(Date.now()); hits.set(key + ip, h); };
const need = (s, roles) => {
  if (!s) throw bad(401, 'Please sign in first', 'আগে লগইন করুন');
  if (roles && !(s.t === 'admin' && roles.includes(s.u.role))) throw bad(403, 'You do not have permission for this action', 'এই কাজের অনুমতি আপনার নেই');
};
const str = (v, max = 300) => String(v ?? '').trim().slice(0, max);
const deptOk = n => !get('SELECT COUNT(*) n FROM depts').n || !!get('SELECT 1 x FROM depts WHERE name=?', n);
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const emailTaken = (e, exceptId) => !!(get('SELECT id FROM members WHERE email=? AND id<>?', e, exceptId || '') || get('SELECT id FROM users WHERE email=? AND id<>?', e, exceptId || ''));

/* ---------- data for the browser (what each role may see) ---------- */
function dataFor(s) {
  const db = { set: settings(), cats: all('SELECT * FROM cats'), authors: all('SELECT * FROM authors'), pubs: all('SELECT * FROM pubs'), depts: all('SELECT * FROM depts ORDER BY name'), books: all('SELECT * FROM books'), notices: all('SELECT * FROM notices'), events: all('SELECT * FROM events'), faqs: all('SELECT * FROM faqs') };
  const bool = r => ({ ...r, paid: !!r.paid }), staff = all('SELECT * FROM staff');
  if (s && s.t === 'admin') {
    Object.assign(db, { staff, members: all('SELECT * FROM members').map(strip), users: s.u.role === ALL[0] ? all('SELECT * FROM users').map(strip) : [], issues: all('SELECT * FROM issues').map(bool), reserve: all('SELECT * FROM reserve'), renewq: all('SELECT * FROM renewq'), lost: all('SELECT * FROM lost'), suppliers: all('SELECT * FROM suppliers'), purchases: all('SELECT * FROM purchases'), notifs: [] });
  } else {
    const me = s && s.t === 'member' ? s.u.id : null;
    const mine = all('SELECT * FROM issues').map(i => i.mid && i.mid === me ? bool(i) : { id: i.id, bookId: i.bookId, mid: '', issued: '', due: '', ret: i.ret, renew: 0, paid: false });
    Object.assign(db, {
      staff: staff.map(x => ({ id: x.id, name: x.name, desig: x.desig })),
      members: all('SELECT * FROM members').map(m => m.id === me ? strip(m) : { id: m.id, status: m.status }),
      users: [], issues: mine, lost: all('SELECT id,bookId,type FROM lost'), suppliers: [], purchases: [],
      reserve: me ? all('SELECT * FROM reserve WHERE mid=?', me) : [],
      renewq: me ? all('SELECT q.* FROM renewq q JOIN issues i ON i.id=q.issueId WHERE i.mid=?', me) : [],
      notifs: me ? all('SELECT * FROM notifs WHERE mid=? ORDER BY date DESC, rowid DESC', me).map(n => ({ ...n, read: !!n.read })) : []
    });
  }
  return { me: s ? { t: s.t, u: strip(s.u) } : null, db };
}

/* ---------- business rules ---------- */
function doIssue(bookId, mid) {
  const b = get('SELECT * FROM books WHERE id=?', bookId), m = get("SELECT * FROM members WHERE id=? AND status='active'", mid), st = settings();
  if (!b || !m) throw bad(400, 'Book or member not found', 'বই বা সদস্য পাওয়া যায়নি');
  if (availN(b) < 1) throw bad(409, 'No copies of this book are available', 'এই বইয়ের কোনো কপি এখন নেই');
  if (get('SELECT COUNT(*) n FROM issues WHERE mid=? AND ret IS NULL', mid).n >= st.max) throw bad(409, `A member can borrow at most ${st.max} books`, `সদস্য সর্বোচ্চ ${bnd(st.max)}টি বই নিতে পারেন`);
  if (get('SELECT 1 x FROM issues WHERE mid=? AND bookId=? AND ret IS NULL', mid, bookId)) throw bad(409, 'The member already has this book', 'এই বই সদস্যের কাছে আগেই আছে');
  const due = addDays(today(), st.loan);
  ins('issues', { id: 'i' + uid(), bookId, mid, issued: today(), due, ret: null, renew: 0, paid: 0 });
  notify(mid, `"${b.title}" বইটি ইস্যু হয়েছে। ফেরতের শেষ তারিখ ${fdb(due)}।`);
}
function doReturn(id) {
  const i = get('SELECT * FROM issues WHERE id=?', id); if (!i || i.ret) throw bad(404, 'Active loan not found', 'সক্রিয় ইস্যু পাওয়া যায়নি');
  run('UPDATE issues SET ret=? WHERE id=?', today(), id); i.ret = today();
  const f = lateDays(i) * settings().fine, b = get('SELECT title FROM books WHERE id=?', i.bookId) || { title: '' };
  const r = get("SELECT * FROM reserve WHERE bookId=? AND status='অপেক্ষমান' ORDER BY date, rowid LIMIT 1", i.bookId);
  if (r) { run("UPDATE reserve SET status='প্রস্তুত' WHERE id=?", r.id); notify(r.mid, `আপনার রিজার্ভ করা "${b.title}" এখন পাওয়া যাচ্ছে।`); }
  if (f && i.mid) notify(i.mid, `দেরিতে ফেরত দেওয়ায় আপনার জরিমানা ৳${bnd(f)}।`);
  return f;
}
function doRenew(id) {
  const i = get('SELECT * FROM issues WHERE id=?', id), st = settings(); if (!i || i.ret) throw bad(404, 'Active loan not found', 'সক্রিয় ইস্যু পাওয়া যায়নি');
  if (i.renew >= st.rmax) throw bad(409, `You can renew at most ${st.rmax} times`, `সর্বোচ্চ ${bnd(st.rmax)} বার মেয়াদ বাড়ানো যায়`);
  const due = addDays(i.due, st.loan); run('UPDATE issues SET due=?, renew=renew+1 WHERE id=?', due, id);
  const b = get('SELECT title FROM books WHERE id=?', i.bookId) || { title: '' };
  if (i.mid) notify(i.mid, `"${b.title}" বইয়ের নতুন ফেরতের তারিখ ${fdb(due)}।`);
}

/* ---------- generic admin CRUD ---------- */
const T = {
  books: { p: 'b', f: ['title', 'authorId', 'catId', 'pubId', 'isbn', 'copies', 'price', 'year', 'ebook'], n: ['copies', 'price', 'year'], req: ['title', 'authorId', 'catId', 'pubId', 'isbn', 'copies'], ref: { authorId: 'authors', catId: 'cats', pubId: 'pubs' }, def: () => ({ added: today() }), role: MGR },
  cats: { p: 'c', f: ['name'], req: ['name'], role: MGR },
  authors: { p: 'a', f: ['name', 'bio'], req: ['name'], role: MGR },
  pubs: { p: 'p', f: ['name', 'city'], req: ['name'], role: MGR },
  members: { p: 'm', f: ['name', 'email', 'phone', 'dept', 'roll', 'status', 'sq'], n: ['sq'], req: ['name', 'email', 'phone', 'dept', 'roll'], def: () => ({ joined: today(), status: 'active' }), role: ALL, cred: 1, en: { status: ['active', 'pending'] } },
  users: { p: 'u', f: ['name', 'email', 'role', 'sq'], n: ['sq'], req: ['name', 'email', 'role'], role: ADM, cred: 1, en: { role: ALL } },
  depts: { p: 'd', f: ['name'], req: ['name'], role: MGR },
  staff: { p: 's', f: ['name', 'desig', 'phone'], req: ['name'], role: MGR },
  lost: { p: 'l', f: ['bookId', 'mid', 'type', 'date', 'charge'], n: ['charge'], req: ['bookId', 'mid', 'type', 'date'], ref: { bookId: 'books', mid: 'members' }, en: { type: ['হারানো', 'ক্ষতিগ্রস্ত'] }, role: MGR },
  suppliers: { p: 'v', f: ['name', 'phone', 'addr'], req: ['name'], role: MGR },
  purchases: { p: 'x', f: ['bookId', 'supplierId', 'qty', 'cost', 'date'], n: ['qty', 'cost'], req: ['bookId', 'supplierId', 'qty', 'date'], ref: { bookId: 'books', supplierId: 'suppliers' }, role: MGR },
  notices: { p: 'n', f: ['title', 'body', 'date'], req: ['title', 'date'], role: MGR },
  events: { p: 'e', f: ['title', 'date', 'place', 'desc'], req: ['title', 'date'], role: MGR },
  faqs: { p: 'f', f: ['q', 'a'], req: ['q', 'a'], role: MGR }
};
function clean(t, c, body, id) {
  const o = {}, V = bad.bind(null, 400);
  for (const k of c.f) {
    if (id && !(k in body)) continue;
    let v = body[k];
    if (c.n && c.n.includes(k)) { v = Number(v); if (!Number.isFinite(v) || v < 0) throw V(`Invalid number: ${k}`, `সংখ্যাটি সঠিক নয়: ${k}`); } else v = str(v, k === 'body' || k === 'desc' || k === 'a' ? 2000 : 300);
    if (c.req.includes(k) && (v === '' || v === null)) throw V(`Please fill in: ${k}`, `ঘরটি পূরণ করুন: ${k}`);
    if (c.en && c.en[k] && !c.en[k].includes(v)) throw V(`Invalid value: ${k}`, `মান সঠিক নয়: ${k}`);
    if (c.ref && c.ref[k] && !get(`SELECT 1 x FROM "${c.ref[k]}" WHERE id=?`, v)) throw V(`Unknown reference: ${k}`, `সংযুক্ত তথ্য পাওয়া যায়নি: ${k}`);
    o[k] = v;
  }
  if (t === 'books' && o.copies !== undefined) {
    if (o.copies < 1) throw V('There must be at least 1 copy', 'কপির সংখ্যা কমপক্ষে ১ হতে হবে');
    if (id && o.copies < outN(id) + lostN(id)) throw V('Copies cannot be fewer than the books currently issued', 'বর্তমানে ইস্যু করা বইয়ের চেয়ে কপি কম হতে পারে না');
  }
  if (t === 'depts' && o.name && get('SELECT 1 x FROM depts WHERE name=? AND id<>?', o.name, id || '')) throw V('This department already exists', 'এই বিভাগ আগেই আছে');
  if (t === 'purchases' && o.qty !== undefined && o.qty < 1) throw V('Quantity must be at least 1', 'পরিমাণ কমপক্ষে ১ হতে হবে');
  if (c.cred) {
    if ('email' in o) { o.email = norm(o.email); if (!emailOk(o.email) || emailTaken(o.email, id)) throw V('This email is invalid or already in use', 'ইমেইলটি সঠিক নয় বা আগে থেকেই আছে'); }
    if ('sq' in o && ![0, 1, 2, 3].includes(o.sq)) o.sq = 1;
    const pw = str(body.pw, 100), sa = str(body.sa, 100);
    if (!id && pw.length < 6) throw V('Password must be at least 6 characters', 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে');
    if (!id && !sa) throw V('Please enter a security answer', 'নিরাপত্তা উত্তর দিন');
    if (pw) { if (pw.length < 6) throw V('Password must be at least 6 characters', 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে'); o.pw = hashPw(pw); }
    if (sa) o.sa = hashPw(norm(sa));
  }
  return o;
}
function guardDelete(t, id, s) {
  const r = get(`SELECT * FROM "${t}" WHERE id=?`, id); if (!r) throw bad(404, 'Record not found', 'তথ্য পাওয়া যায়নি');
  const G = (en, bn) => { throw bad(409, en, bn); };
  if (t === 'books' && outN(id)) G('Copies of this book are still issued', 'এই বইয়ের কপি এখনো ইস্যু করা আছে');
  if (t === 'cats' && get('SELECT 1 x FROM books WHERE catId=?', id)) G('This category still has books', 'এই ক্যাটাগরিতে বই আছে');
  if (t === 'authors' && get('SELECT 1 x FROM books WHERE authorId=?', id)) G('Books by this author are in the catalogue', 'এই লেখকের বই তালিকায় আছে');
  if (t === 'pubs' && get('SELECT 1 x FROM books WHERE pubId=?', id)) G('Books from this publisher are in the catalogue', 'এই প্রকাশকের বই তালিকায় আছে');
  if (t === 'depts' && get('SELECT 1 x FROM members WHERE dept=?', r.name)) G('This department still has members', 'এই বিভাগে সদস্য আছে');
  if (t === 'members' && get('SELECT 1 x FROM issues WHERE mid=? AND ret IS NULL', id)) G('This member still has unreturned books', 'সদস্যের কাছে বই জমা না দেওয়া অবস্থায় আছে');
  if (t === 'users') { if (id === s.u.id) G('You cannot delete your own account', 'নিজের অ্যাকাউন্ট মুছা যাবে না'); if (r.role === ALL[0] && get('SELECT COUNT(*) n FROM users WHERE role=?', ALL[0]).n < 2) G('At least one admin is required', 'কমপক্ষে একজন অ্যাডমিন থাকতে হবে'); }
}
function restore(o) {
  if (!o || !Array.isArray(o.books) || !Array.isArray(o.cats) || !Array.isArray(o.members)) throw bad(400, 'This is not a valid backup', 'এটি সঠিক ব্যাকআপ নয়');
  const keep = {}; ['members', 'users'].forEach(t => all(`SELECT id,pw,sa FROM "${t}"`).forEach(r => keep[t + r.id] = r));
  tx(() => {
    ORDER.forEach(t => run(`DELETE FROM "${t}"`));
    const cols = {}; ORDER.forEach(t => cols[t] = all(`PRAGMA table_info("${t}")`).map(c => c.name));
    const put = (t, rows) => (rows || []).forEach(r => { const row = {}; cols[t].forEach(k => { if (k in r) row[k] = typeof r[k] === 'boolean' ? +r[k] : r[k]; }); if (t === 'members' || t === 'users') { const k = keep[t + r.id]; row.pw = k ? k.pw : hashPw('changeme123'); row.sa = k ? k.sa : hashPw('dhaka'); } ins(t, row); });
    ['cats', 'authors', 'pubs', 'depts', 'staff', 'suppliers', 'members', 'users', 'books', 'issues', 'reserve', 'renewq', 'lost', 'purchases', 'notices', 'events', 'faqs'].forEach(t => put(t, o[t]));
    (o.notifs || []).forEach(n => ins('notifs', { id: n.id, mid: n.mid, text: n.text, date: n.date, read: +!!n.read }));
    if (o.set) Object.entries(o.set).forEach(([k, v]) => run('INSERT OR REPLACE INTO settings VALUES(?,?)', k, String(v)));
    ensureSettings(); ensureDepts();
    if (!get('SELECT COUNT(*) n FROM users WHERE role=?', ALL[0]).n) throw bad(400, 'The backup must contain at least one admin', 'ব্যাকআপে কমপক্ষে একজন অ্যাডমিন থাকতে হবে');
  });
}

/* ---------- API routes ---------- */
const ok = (msg, extra) => ({ ok: true, ...(msg ? { msg } : {}), ...(extra || {}) });
function api(req, res, m, p, body, s, ip) {
  let x;
  if (m === 'GET' && p === '/api/data') return dataFor(s);
  if (m === 'POST' && p === '/api/login') {
    const h = limit(ip, 'login', 10, 5 * 60e3), em = norm(body.email), pw = str(body.pw, 100);
    let t = 'admin', u = get('SELECT * FROM users WHERE email=?', em); if (!u) { t = 'member'; u = get('SELECT * FROM members WHERE email=?', em); }
    if (!u || !verify(pw, u.pw)) { note(ip, 'login', 0, h); throw bad(401, 'Incorrect email or password. Please try again.', 'ইমেইল বা পাসওয়ার্ড মেলেনি। আবার চেষ্টা করুন।'); }
    if (t === 'member' && u.status !== 'active') throw bad(403, 'Your registration has not been approved yet. You can sign in after the librarian approves it.', 'আপনার নিবন্ধন এখনো অনুমোদিত হয়নি। লাইব্রেরিয়ানের অনুমোদনের পর লগইন করতে পারবেন।');
    hits.delete('login' + ip); res.cookie = startSession(t, u.id); return ok();
  }
  if (m === 'POST' && p === '/api/logout') { if (s) run('DELETE FROM sessions WHERE token=?', s.token); res.cookie = 'clear'; return ok(); }
  if (m === 'POST' && p === '/api/register') {
    const h = limit(ip, 'reg', 8, 10 * 60e3), em = norm(body.email), pw = str(body.pw, 100), sa = str(body.sa, 100);
    const d = { name: str(body.name), phone: str(body.phone, 40), dept: str(body.dept, 80), roll: str(body.roll, 40) };
    if (!d.name || !d.phone || !d.dept || !d.roll || !sa) throw bad(400, 'Please fill in all fields.', 'সব ঘর পূরণ করুন।');
    if (!deptOk(d.dept)) throw bad(400, 'Please choose a department from the list.', 'তালিকা থেকে বিভাগ বাছাই করুন।');
    if (!emailOk(em)) throw bad(400, 'Enter a valid email address.', 'সঠিক ইমেইল দিন।');
    if (pw.length < 6) throw bad(400, 'Use a password of at least 6 characters.', 'কমপক্ষে ৬ অক্ষরের পাসওয়ার্ড দিন।');
    if (emailTaken(em)) throw bad(409, 'This email is already registered. Please sign in.', 'এই ইমেইলে আগেই নিবন্ধন হয়েছে। লগইন করুন।');
    note(ip, 'reg', 0, h); ins('members', { id: 'm' + uid(), ...d, email: em, pw: hashPw(pw), sq: [0, 1, 2, 3].includes(+body.sq) ? +body.sq : 1, sa: hashPw(norm(sa)), status: 'pending', joined: today() }); return ok();
  }
  if (m === 'POST' && p === '/api/forgot/question') {
    limit(ip, 'fp', 15, 10 * 60e3); const em = norm(body.email), u = get('SELECT sq FROM users WHERE email=?', em) || get('SELECT sq FROM members WHERE email=?', em);
    if (!u) throw bad(404, 'No account found with this email.', 'এই ইমেইলে কোনো অ্যাকাউন্ট পাওয়া যায়নি।'); return { q: u.sq };
  }
  if (m === 'POST' && p === '/api/forgot/reset') {
    const h = limit(ip, 'fr', 6, 10 * 60e3), em = norm(body.email), nw = str(body.nw, 100);
    let t = 'users', u = get('SELECT * FROM users WHERE email=?', em); if (!u) { t = 'members'; u = get('SELECT * FROM members WHERE email=?', em); }
    if (!u || !verify(norm(body.ans), u.sa)) { note(ip, 'fr', 0, h); throw bad(400, 'The answer is incorrect.', 'উত্তরটি সঠিক নয়।'); }
    if (nw.length < 6) throw bad(400, 'New password must be at least 6 characters.', 'নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।');
    run(`UPDATE ${t} SET pw=? WHERE id=?`, hashPw(nw), u.id); run('DELETE FROM sessions WHERE uid=?', u.id); return ok();
  }
  need(s);
  if (m === 'POST' && p === '/api/password') {
    const nw = str(body.nw, 100); if (!verify(str(body.old, 100), s.u.pw)) throw bad(400, 'The current password is incorrect.', 'বর্তমান পাসওয়ার্ড ভুল।');
    if (nw.length < 6) throw bad(400, 'New password must be at least 6 characters.', 'নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।');
    run(`UPDATE ${s.t === 'admin' ? 'users' : 'members'} SET pw=? WHERE id=?`, hashPw(nw), s.u.id); return ok();
  }
  if (m === 'PUT' && p === '/api/profile') {
    need(s); if (s.t !== 'member') throw bad(403, 'Members only', 'শুধু সদস্যদের জন্য');
    const d = { name: str(body.name), phone: str(body.phone, 40), dept: str(body.dept, 80) }; if (!d.name || !d.phone || !d.dept) throw bad(400, 'Please fill in all fields.', 'সব ঘর পূরণ করুন।');
    if (d.dept !== s.u.dept && !deptOk(d.dept)) throw bad(400, 'Please choose a department from the list.', 'তালিকা থেকে বিভাগ বাছাই করুন।');
    run('UPDATE members SET name=?, phone=?, dept=? WHERE id=?', d.name, d.phone, d.dept, s.u.id); return ok(['Profile updated', 'প্রোফাইল হালনাগাদ হয়েছে']);
  }
  if (m === 'POST' && p === '/api/notifs/read') { if (s.t === 'member') run('UPDATE notifs SET "read"=1 WHERE mid=?', s.u.id); return ok(); }
  if (m === 'POST' && p === '/api/reserve') {
    if (s.t !== 'member') throw bad(403, 'Sign in as a member to reserve books', 'বই রিজার্ভ করতে সদস্য হিসেবে লগইন করুন');
    const b = get('SELECT * FROM books WHERE id=?', str(body.bookId)); if (!b) throw bad(404, 'Book not found', 'বই পাওয়া যায়নি');
    if (get("SELECT 1 x FROM reserve WHERE bookId=? AND mid=? AND status NOT IN ('সম্পন্ন','বাতিল')", b.id, s.u.id)) throw bad(409, 'You have already reserved this book', 'এই বই আপনি আগেই রিজার্ভ করেছেন');
    ins('reserve', { id: 'r' + uid(), bookId: b.id, mid: s.u.id, date: today(), status: availN(b) > 0 ? 'প্রস্তুত' : 'অপেক্ষমান' }); return ok(['Book reserved', 'বই রিজার্ভ করা হয়েছে']);
  }
  if (m === 'POST' && (x = /^\/api\/reserve\/(\w+)\/(cancel|fulfil)$/.exec(p))) {
    const r = get('SELECT * FROM reserve WHERE id=?', x[1]); if (!r) throw bad(404, 'Reservation not found', 'রিজার্ভেশন পাওয়া যায়নি');
    if (x[2] === 'cancel') { if (!(s.t === 'admin' || r.mid === s.u.id)) throw bad(403, 'Not allowed', 'অনুমতি নেই'); run("UPDATE reserve SET status='বাতিল' WHERE id=?", r.id); return ok(['Reservation cancelled', 'রিজার্ভেশন বাতিল']); }
    need(s, ALL); tx(() => { doIssue(r.bookId, r.mid); run("UPDATE reserve SET status='সম্পন্ন' WHERE id=?", r.id); }); return ok(['Book issued', 'বই ইস্যু হয়েছে']);
  }
  if (m === 'POST' && (x = /^\/api\/renewreq\/(\w+)$/.exec(p))) {
    const i = get('SELECT * FROM issues WHERE id=?', x[1]); if (!i || i.mid !== s.u.id || i.ret) throw bad(404, 'Active loan not found', 'সক্রিয় ইস্যু পাওয়া যায়নি');
    if (i.renew >= settings().rmax) throw bad(409, 'Renewal limit reached', 'মেয়াদ বাড়ানোর সীমা শেষ');
    if (get("SELECT 1 x FROM renewq WHERE issueId=? AND status='অপেক্ষমান'", i.id)) throw bad(409, 'A request is already pending', 'আবেদন আগেই অপেক্ষমান আছে');
    ins('renewq', { id: 'q' + uid(), issueId: i.id, status: 'অপেক্ষমান' }); return ok(['Request sent', 'আবেদন পাঠানো হয়েছে']);
  }
  /* staff-only operations */
  need(s, ALL);
  if (m === 'POST' && p === '/api/issue') { tx(() => doIssue(str(body.bookId), str(body.mid))); return ok(['Book issued', 'বই ইস্যু হয়েছে']); }
  if (m === 'POST' && (x = /^\/api\/return\/(\w+)$/.exec(p))) { const f = tx(() => doReturn(x[1])); return ok(f ? [`Returned. Fine: ৳${f}`, `ফেরত নেওয়া হয়েছে। জরিমানা ৳${bnd(f)}`] : ['Book returned', 'বই ফেরত নেওয়া হয়েছে']); }
  if (m === 'POST' && (x = /^\/api\/renew\/(\w+)$/.exec(p))) { tx(() => doRenew(x[1])); return ok(['Renewed', 'মেয়াদ বাড়ানো হয়েছে']); }
  if (m === 'POST' && (x = /^\/api\/renewq\/(\w+)\/(approve|reject)$/.exec(p))) {
    const q = get('SELECT * FROM renewq WHERE id=?', x[1]); if (!q || q.status !== 'অপেক্ষমান') throw bad(404, 'Request not found', 'আবেদন পাওয়া যায়নি');
    if (x[2] === 'approve') { tx(() => { doRenew(q.issueId); run("UPDATE renewq SET status='অনুমোদিত' WHERE id=?", q.id); }); return ok(['Renewed', 'মেয়াদ বাড়ানো হয়েছে']); }
    const i = get('SELECT * FROM issues WHERE id=?', q.issueId), b = i && get('SELECT title FROM books WHERE id=?', i.bookId);
    run("UPDATE renewq SET status='বাতিল' WHERE id=?", q.id); if (i && i.mid) notify(i.mid, `"${b ? b.title : ''}" বইয়ের মেয়াদ বাড়ানোর আবেদন গ্রহণ করা যায়নি।`); return ok();
  }
  if (m === 'POST' && (x = /^\/api\/fine\/(\w+)\/pay$/.exec(p))) { const i = get('SELECT * FROM issues WHERE id=?', x[1]); if (!i) throw bad(404, 'Loan not found', 'ইস্যু পাওয়া যায়নি'); run('UPDATE issues SET paid=1 WHERE id=?', i.id); return ok(['Fine collected', 'জরিমানা আদায় হয়েছে']); }
  if (m === 'POST' && (x = /^\/api\/members\/(\w+)\/approve$/.exec(p))) { run("UPDATE members SET status='active' WHERE id=?", x[1]); notify(x[1], 'আপনার সদস্যপদ অনুমোদিত হয়েছে। এখন লগইন করে বই রিজার্ভ করতে পারবেন।'); return ok(['Member approved', 'সদস্য অনুমোদিত']); }
  if (p === '/api/admin/settings' && m === 'PUT') {
    need(s, ADM); const st = {};
    for (const k of ['name', 'en', 'addr', 'phone', 'email', 'open', 'close']) st[k] = str(body[k]);
    for (const k of ['fine', 'loan', 'max', 'rmax']) { const v = Number(body[k]); if (!Number.isFinite(v) || v < 0 || (k !== 'fine' && k !== 'rmax' && v < 1)) throw bad(400, `Invalid value: ${k}`, `মান সঠিক নয়: ${k}`); st[k] = v; }
    if (!st.name) throw bad(400, 'Organisation name is required', 'প্রতিষ্ঠানের নাম দিন');
    for (const [k, mx] of [['hero', 120], ['herod', 400], ['days', 60], ['hero_en', 120], ['herod_en', 400], ['days_en', 60]]) if (body[k] !== undefined) st[k] = str(body[k], mx);
    if (body.links !== undefined) {
      const ls = String(body.links).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (ls.length > 8) throw bad(400, 'At most 8 footer links', 'ফুটারে সর্বোচ্চ ৮টি লিংক দেওয়া যাবে');
      st.links = ls.map(l => { const [a, h, e] = l.split('|').map(x => str(x, 80)); if (!a || !/^(#[\w-]+|https?:\/\/[^\s|]+)$/.test(h || '')) throw bad(400, `Invalid link line: ${l}`, `লিংকের লাইনটি সঠিক নয়: ${l}। ফরম্যাট: নাম | #পেজ | ইংরেজি নাম`); return e ? `${a}|${h}|${e}` : `${a}|${h}`; }).join('\n');
    }
    if (body.logo !== undefined) {
      const lg = String(body.logo);
      if (lg !== '' && (lg.length > 300000 || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(lg))) throw bad(400, 'Logo must be a PNG, JPG or WebP image under about 200 KB', 'লোগো PNG, JPG বা WebP হতে হবে এবং প্রায় ২০০ কেবি-র কম হতে হবে');
      st.logo = lg;
    }
    Object.entries(st).forEach(([k, v]) => run('INSERT OR REPLACE INTO settings VALUES(?,?)', k, String(v))); return ok(['Settings saved', 'সেটিংস সংরক্ষিত হয়েছে']);
  }
  if (m === 'POST' && p === '/api/restore') { need(s, ADM); restore(body); return ok(['Data restored', 'ডেটা পুনরুদ্ধার হয়েছে']); }
  if (m === 'POST' && p === '/api/reset') { need(s, ADM); seed(); res.cookie = 'clear'; return ok(['Demo data restored. Please sign in again.', 'ডেমো ডেটা ফিরেছে। আবার লগইন করুন।']); }
  if ((x = /^\/api\/admin\/(\w+)(?:\/(\w+))?$/.exec(p)) && T[x[1]]) {
    const t = x[1], c = T[t]; need(s, c.role);
    if (m === 'POST' && !x[2]) { const o = { ...(c.def ? c.def() : {}), ...clean(t, c, body, null), id: c.p + uid() }; tx(() => { ins(t, o); if (t === 'purchases') run('UPDATE books SET copies=copies+? WHERE id=?', o.qty, o.bookId); }); return ok(['Saved', 'সংরক্ষণ হয়েছে']); }
    if (m === 'PUT' && x[2]) { const old = get(`SELECT * FROM "${t}" WHERE id=?`, x[2]); if (!old) throw bad(404, 'Record not found', 'তথ্য পাওয়া যায়নি'); const o = clean(t, c, body, x[2]), k = Object.keys(o); if (t === 'depts' && o.name && o.name !== old.name) run('UPDATE members SET dept=? WHERE dept=?', o.name, old.name); if (k.length) run(`UPDATE "${t}" SET ${k.map(y => `"${y}"=?`).join(',')} WHERE id=?`, ...k.map(y => o[y]), x[2]); return ok(['Saved', 'সংরক্ষণ হয়েছে']); }
    if (m === 'DELETE' && x[2]) { guardDelete(t, x[2], s); run(`DELETE FROM "${t}" WHERE id=?`, x[2]); if (t === 'users' || t === 'members') run('DELETE FROM sessions WHERE uid=?', x[2]); return ok(['Deleted', 'মুছে ফেলা হয়েছে']); }
  }
  throw bad(404, 'Not found', 'পাওয়া যায়নি');
}

/* ---------- HTTP server ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), p = decodeURIComponent(url.pathname), m = req.method, ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const base = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'same-origin' };
  if (!p.startsWith('/api/')) {
    if (m !== 'GET' && m !== 'HEAD') { res.writeHead(405, base); return res.end(); }
    const f = path.join(__dirname, 'index.html');
    if ((p !== '/' && p !== '/index.html') || !fs.existsSync(f)) { res.writeHead(404, base); return res.end('Not found'); }
    res.writeHead(200, { ...base, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); return fs.createReadStream(f).pipe(res);
  }
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > 8e6) req.destroy(); else chunks.push(c); });
  req.on('end', () => {
    const out = (code, obj) => {
      const h = { ...base, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      if (res.cookie) { const sec = (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) ? '; Secure' : ''; h['Set-Cookie'] = res.cookie === 'clear' ? `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${sec}` : `sid=${res.cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${sec}`; }
      res.writeHead(code, h); res.end(JSON.stringify(obj));
    };
    try {
      if (m !== 'GET' && !/application\/json/.test(req.headers['content-type'] || '')) throw bad(415, 'Unsupported request', 'অনুরোধটি সমর্থিত নয়');
      let body = {}; if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { throw bad(400, 'Invalid JSON', 'JSON সঠিক নয়'); } }
      out(200, api(req, res, m, p, body, sessOf(req), ip));
    } catch (e) {
      if (e.pair) return out(e.code, { error: e.pair });
      const msg = String(e.message || '');
      if (/constraint|UNIQUE|FOREIGN/i.test(msg)) return out(409, { error: ['This record conflicts with existing data', 'এই তথ্য বিদ্যমান তথ্যের সাথে সাংঘর্ষিক'] });
      console.error(e); out(500, { error: ['Server error. Please try again.', 'সার্ভারে সমস্যা হয়েছে। আবার চেষ্টা করুন।'] });
    }
  });
});
server.listen(PORT, '0.0.0.0', () => console.log(`Library system running on http://localhost:${PORT}`));
