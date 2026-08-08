import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Путь по умолчанию считаем от расположения самого db.js (корень проекта),
// а не от текущей рабочей директории процесса — так путь остаётся верным,
// откуда бы ни запускали bot.js/seed.js/admin (через npm run или кнопку Run в IDE).
const envPath = process.env.DB_PATH;
const dbPath = envPath
  ? (path.isAbsolute(envPath) ? envPath : path.join(__dirname, envPath))
  : path.join(__dirname, 'data', 'bot.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);

// WAL-режим позволяет читать и писать в базу из нескольких процессов
// одновременно (у нас это bot.js и admin/server.js) без ошибок
// "database is locked". busy_timeout — сколько ждать перед ошибкой, если
// база всё-таки занята другим процессом в конкретный момент.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id           INTEGER PRIMARY KEY,  -- MAX user_id
    username          TEXT,
    name              TEXT,
    age               INTEGER,
    city              TEXT,
    gender            TEXT,                 -- 'male' | 'female'
    bio               TEXT,                 -- короткое описание "о себе", необязательное
    photo_token       TEXT,                 -- токен для повторной отправки фото через бота
    photo_url         TEXT,                 -- прямая ссылка на фото (для показа в admin-панели)
    reg_state         TEXT DEFAULT 'new',    -- new|ask_name|ask_age|ask_city|ask_gender|ask_bio|ask_photo|confirm|
                                              -- edit_name|edit_age|edit_city|edit_bio|edit_photo|review_required|done
    review_note       TEXT,                 -- комментарий администратора при отправке анкеты на доработку
    banned            INTEGER DEFAULT 0,     -- 1 = заблокирован администратором навсегда
    ban_reason         TEXT,                 -- причина блокировки
    awaiting_link_for INTEGER,               -- кому переслать следующую ссылку-приглашение, которую пришлёт пользователь
    awaiting_report_for INTEGER,             -- на кого ждём текст жалобы (причина "Другое")
    last_active_at    TEXT,                 -- когда пользователь последний раз что-то делал в боте
    last_reminder_sent_at TEXT,              -- когда последний раз слали напоминание о неактивности
    completed_registration_at TEXT,          -- когда анкета была впервые полностью заполнена (для воронки)
    created_at        TEXT DEFAULT (datetime('now'))
  );
`);
// Покрывает основной фильтр подбора анкет: WHERE reg_state='done' AND banned=0 AND gender=...
db.exec('CREATE INDEX IF NOT EXISTS idx_users_search ON users(reg_state, banned, gender);');

const USER_FIELDS = [
  'username', 'name', 'age', 'city', 'gender', 'bio',
  'photo_token', 'photo_url', 'reg_state', 'review_note',
  'banned', 'ban_reason', 'awaiting_link_for', 'awaiting_report_for',
];

export function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId);
}

export function upsertUser(userId, fields) {
  const existing = getUser(userId);
  if (!existing) {
    db.prepare(
      `INSERT INTO users (user_id, username, name, age, city, gender, bio, photo_token, photo_url, reg_state, review_note, banned, ban_reason, awaiting_link_for, awaiting_report_for)
       VALUES (@user_id, @username, @name, @age, @city, @gender, @bio, @photo_token, @photo_url, @reg_state, @review_note, @banned, @ban_reason, @awaiting_link_for, @awaiting_report_for)`
    ).run({
      user_id: userId,
      username: fields.username ?? null,
      name: fields.name ?? null,
      age: fields.age ?? null,
      city: fields.city ?? null,
      gender: fields.gender ?? null,
      bio: fields.bio ?? null,
      photo_token: fields.photo_token ?? null,
      photo_url: fields.photo_url ?? null,
      reg_state: fields.reg_state ?? 'new',
      review_note: fields.review_note ?? null,
      banned: fields.banned ?? 0,
      ban_reason: fields.ban_reason ?? null,
      awaiting_link_for: fields.awaiting_link_for ?? null,
      awaiting_report_for: fields.awaiting_report_for ?? null,
    });
  } else {
    const merged = { ...existing, ...fields };
    db.prepare(
      `UPDATE users SET username=@username, name=@name, age=@age, city=@city, gender=@gender, bio=@bio,
       photo_token=@photo_token, photo_url=@photo_url, reg_state=@reg_state, review_note=@review_note,
       banned=@banned, ban_reason=@ban_reason, awaiting_link_for=@awaiting_link_for,
       awaiting_report_for=@awaiting_report_for
       WHERE user_id=@user_id`
    ).run({
      user_id: userId,
      username: merged.username,
      name: merged.name,
      age: merged.age,
      city: merged.city,
      gender: merged.gender,
      bio: merged.bio,
      photo_token: merged.photo_token,
      photo_url: merged.photo_url,
      reg_state: merged.reg_state,
      review_note: merged.review_note,
      banned: merged.banned,
      ban_reason: merged.ban_reason,
      awaiting_link_for: merged.awaiting_link_for,
      awaiting_report_for: merged.awaiting_report_for,
    });
  }
  return getUser(userId);
}

export function banUser(userId, reason) {
  return upsertUser(userId, { banned: 1, ban_reason: reason || 'Нарушение правил сервиса' });
}

export function unbanUser(userId) {
  return upsertUser(userId, { banned: 0, ban_reason: null });
}

// Жёсткое удаление — используется только из admin-панели администратором
export function deleteUser(userId) {
  db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM swipes WHERE user_id = ? OR target_id = ?').run(userId, userId);
  db.prepare('DELETE FROM matches WHERE user_a = ? OR user_b = ?').run(userId, userId);
}

// Мягкое удаление — когда пользователь сам удаляет анкету через бота.
// Запись остаётся в базе (для истории/статистики в admin-панели), но помечается
// статусом 'deleted_by_user' и пропадает из подбора анкет (он фильтрует reg_state='done').
export function markSelfDeleted(userId) {
  return upsertUser(userId, {
    reg_state: 'deleted_by_user',
    awaiting_link_for: null,
    review_note: null,
  });
}

// --- Активность / напоминания / воронка регистрации ---

export function touchLastActive(userId) {
  db.prepare(`UPDATE users SET last_active_at = datetime('now') WHERE user_id = ?`).run(userId);
}

export function markReminderSent(userId) {
  db.prepare(`UPDATE users SET last_reminder_sent_at = datetime('now') WHERE user_id = ?`).run(userId);
}

// Фиксируется один раз — при первом успешном завершении анкеты. Повторные
// вызовы ничего не перезаписывают (COALESCE), так что дальнейшие
// редактирования анкеты на воронку не влияют.
export function markRegistrationCompleted(userId) {
  db.prepare(
    `UPDATE users SET completed_registration_at = COALESCE(completed_registration_at, datetime('now')) WHERE user_id = ?`
  ).run(userId);
}

// Пользователи, которые давно не заходили и которым пора напомнить о новых
// анкетах (и которым мы не слали напоминание последние reminderCooldownHours).
export function listInactiveUsersForReminder({ inactiveHours = 48, reminderCooldownHours = 48 } = {}) {
  return db
    .prepare(
      `SELECT * FROM users
       WHERE reg_state = 'done'
         AND banned = 0
         AND last_active_at IS NOT NULL
         AND last_active_at <= datetime('now', '-${inactiveHours} hours')
         AND (last_reminder_sent_at IS NULL OR last_reminder_sent_at <= datetime('now', '-${reminderCooldownHours} hours'))`
    )
    .all();
}

// Сколько непросмотренных анкет своего города сейчас доступно пользователю
// (для текста напоминания "у тебя N новых анкет в городе")
export function countFreshCandidatesInCity(userId, city, targetGender) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM users
       WHERE reg_state = 'done'
         AND banned = 0
         AND user_id != @userId
         AND city = @city
         AND (@targetGender IS NULL OR gender = @targetGender)
         AND user_id NOT IN (SELECT target_id FROM swipes WHERE user_id = @userId)`
    )
    .get({ userId, city, targetGender });
  return row.cnt;
}

// --- Для admin-панели ---

const SORTABLE_COLUMNS = new Set(['created_at', 'age', 'city', 'name', 'reg_state']);

export function listUsers({ sortBy = 'created_at', order = 'desc', includeDeleted = false } = {}) {
  const column = SORTABLE_COLUMNS.has(sortBy) ? sortBy : 'created_at';
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const where = includeDeleted ? '' : `WHERE reg_state != 'deleted_by_user'`;
  return db.prepare(`SELECT * FROM users ${where} ORDER BY ${column} ${direction}`).all();
}

export function getStats() {
  const count = (where) => db.prepare(`SELECT COUNT(*) AS cnt FROM users ${where}`).get().cnt;
  return {
    total: count(`WHERE reg_state != 'deleted_by_user'`),
    active: count(`WHERE reg_state = 'done' AND banned = 0`),
    reviewRequired: count(`WHERE reg_state = 'review_required'`),
    inProgress: count(`WHERE reg_state NOT IN ('done', 'review_required', 'deleted_by_user')`),
    deletedByUser: count(`WHERE reg_state = 'deleted_by_user'`),
    banned: count(`WHERE banned = 1`),
    matches: db.prepare('SELECT COUNT(*) AS cnt FROM matches').get().cnt,
    openReports: db.prepare(`SELECT COUNT(*) AS cnt FROM reports WHERE status = 'open'`).get().cnt,
  };
}

// Регистрации по дням за последние N дней (для графика роста)
export function getRegistrationsByDay(days = 30) {
  return db
    .prepare(
      `SELECT date(created_at) AS day, COUNT(*) AS cnt
       FROM users
       WHERE created_at >= datetime('now', '-${days} days')
       GROUP BY day
       ORDER BY day`
    )
    .all();
}

// Воронка: начал анкету → завершил → получил хотя бы один мэтч
export function getFunnel() {
  const started = db.prepare(`SELECT COUNT(*) AS cnt FROM users WHERE reg_state != 'new'`).get().cnt;
  const completed = db
    .prepare(`SELECT COUNT(*) AS cnt FROM users WHERE completed_registration_at IS NOT NULL`)
    .get().cnt;
  const matched = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT user_a AS uid FROM matches
         UNION
         SELECT user_b AS uid FROM matches
       )`
    )
    .get().cnt;
  return { started, completed, matched };
}

export function listDistinctCities() {
  return db
    .prepare(
      `SELECT DISTINCT city FROM users
       WHERE city IS NOT NULL AND city != '' AND reg_state != 'deleted_by_user'
       ORDER BY city`
    )
    .all()
    .map((r) => r.city);
}

// Пользователи для рассылки — все, кто хоть раз запустил бота и не удалил анкету
// сам (включая тех, кто ещё заполняет анкету), с необязательными фильтрами.
export function listUsersForBroadcast({ city, gender, ageMin, ageMax } = {}) {
  const conditions = [`reg_state NOT IN ('new', 'deleted_by_user')`, `banned = 0`];
  const params = {};

  if (city) {
    conditions.push('city = @city');
    params.city = city;
  }
  if (gender) {
    conditions.push('gender = @gender');
    params.gender = gender;
  }
  if (ageMin) {
    conditions.push('age >= @ageMin');
    params.ageMin = Number(ageMin);
  }
  if (ageMax) {
    conditions.push('age <= @ageMax');
    params.ageMax = Number(ageMax);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  return db.prepare(`SELECT * FROM users ${where}`).all(params);
}

// --- Лайки/пропуски и подбор анкет ---

db.exec(`
  CREATE TABLE IF NOT EXISTS swipes (
    user_id    INTEGER NOT NULL,
    target_id  INTEGER NOT NULL,
    action     TEXT NOT NULL,             -- 'like' | 'skip'
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, target_id)
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_swipes_target ON swipes(target_id);');

export function recordSwipe(userId, targetId, action) {
  db.prepare(
    `INSERT INTO swipes (user_id, target_id, action, created_at)
     VALUES (@user_id, @target_id, @action, datetime('now'))
     ON CONFLICT(user_id, target_id) DO UPDATE SET action=@action, created_at=datetime('now')`
  ).run({ user_id: userId, target_id: targetId, action });
}

// Лайкнул ли targetId пользователя userId ранее? (для проверки взаимного лайка)
export function hasLiked(targetId, userId) {
  const row = db
    .prepare(`SELECT 1 FROM swipes WHERE user_id=@target_id AND target_id=@user_id AND action='like'`)
    .get({ target_id: targetId, user_id: userId });
  return !!row;
}

// Дневной лимит лайков/пропусков (в сумме) на пользователя
export const DAILY_SWIPE_LIMIT = 10;

export function countRecentSwipes(userId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM swipes
       WHERE user_id=@userId AND created_at >= datetime('now', '-24 hours')`
    )
    .get({ userId });
  return row.cnt;
}

// Следующая анкета для показа пользователю:
//  - только противоположный пол (если у пользователя указан пол)
//  - приоритет: свой город + возраст ±10 лет, затем ослабляем по одному критерию
//  - сначала непросмотренные анкеты (в т.ч. других городов, если свой город кончился)
//  - когда непросмотренные кончаются — снова показываем пропущенные анкеты:
//    своего города через SAME_CITY_RECYCLE_HOURS часов, других городов — через
//    OTHER_CITY_RECYCLE_DAYS дней
const SAME_CITY_RECYCLE_HOURS = 12;
const OTHER_CITY_RECYCLE_DAYS = 3;

export function getNextCandidate(userId, city, targetGender, myAge) {
  const params = { userId, city, targetGender, myAge };

  const scoreExpr = `
    (CASE WHEN city = @city THEN 2 ELSE 0 END) +
    (CASE WHEN ABS(age - @myAge) <= 10 THEN 1 ELSE 0 END)
  `;

  const scoreExprPrefixed = `
    (CASE WHEN u.city = @city THEN 2 ELSE 0 END) +
    (CASE WHEN ABS(u.age - @myAge) <= 10 THEN 1 ELSE 0 END)
  `;

  const fresh = db
    .prepare(
      `SELECT * FROM users
       WHERE reg_state = 'done'
         AND banned = 0
         AND user_id != @userId
         AND (@targetGender IS NULL OR gender = @targetGender)
         AND user_id NOT IN (SELECT target_id FROM swipes WHERE user_id = @userId)
       ORDER BY ${scoreExpr} DESC, RANDOM()
       LIMIT 1`
    )
    .get(params);
  if (fresh) return fresh;

  const recycled = db
    .prepare(
      `SELECT u.* FROM users u
       JOIN swipes s ON s.target_id = u.user_id AND s.user_id = @userId
       WHERE u.reg_state = 'done'
         AND u.banned = 0
         AND u.user_id != @userId
         AND (@targetGender IS NULL OR u.gender = @targetGender)
         AND s.action = 'skip'
         AND (
           (u.city = @city AND s.created_at <= datetime('now', '-${SAME_CITY_RECYCLE_HOURS} hours'))
           OR
           (u.city != @city AND s.created_at <= datetime('now', '-${OTHER_CITY_RECYCLE_DAYS} days'))
         )
       ORDER BY ${scoreExprPrefixed} DESC, RANDOM()
       LIMIT 1`
    )
    .get(params);
  return recycled ?? null;
}

// --- Мэтчи (взаимные лайки) ---

db.exec(`
  CREATE TABLE IF NOT EXISTS matches (
    user_a     INTEGER NOT NULL,
    user_b     INTEGER NOT NULL,
    matched_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_a, user_b)
  );
`);

export function recordMatch(userId1, userId2) {
  const a = Math.min(userId1, userId2);
  const b = Math.max(userId1, userId2);
  db.prepare(
    `INSERT OR IGNORE INTO matches (user_a, user_b, matched_at) VALUES (@a, @b, datetime('now'))`
  ).run({ a, b });
}

export function getMatches(userId) {
  return db
    .prepare(
      `SELECT u.* FROM matches m
       JOIN users u ON u.user_id = (CASE WHEN m.user_a = @userId THEN m.user_b ELSE m.user_a END)
       WHERE m.user_a = @userId OR m.user_b = @userId
       ORDER BY m.matched_at DESC`
    )
    .all({ userId });
}

// --- Стоп-слова (модерация текста анкет) ---

db.exec(`
  CREATE TABLE IF NOT EXISTS stop_words (
    word     TEXT PRIMARY KEY,
    added_at TEXT DEFAULT (datetime('now'))
  );
`);

export function listStopWords() {
  return db.prepare('SELECT word FROM stop_words ORDER BY word').all().map((r) => r.word);
}

export function addStopWord(word) {
  const normalized = word.trim().toLowerCase();
  if (!normalized) return;
  db.prepare('INSERT OR IGNORE INTO stop_words (word) VALUES (?)').run(normalized);
}

export function removeStopWord(word) {
  db.prepare('DELETE FROM stop_words WHERE word = ?').run(word.trim().toLowerCase());
}

// Проверяет, встречается ли в тексте хотя бы одно стоп-слово (подстрокой, без
// учёта регистра — этого достаточно для большинства случаев с матом и слэнгом).
export function containsStopWord(text) {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return listStopWords().some((w) => w && normalized.includes(w));
}

// Стартовый список — небольшой набор реально распространённой нецензурной
// лексики, оскорблений и слов, связанных с интим-услугами/18+. Загружается
// один раз, если таблица пустая; дальше список полностью управляется из
// admin-панели (вкладка «Стоп-слова»).
const DEFAULT_STOP_WORDS = [
  // нецензурная лексика (корни и частые формы — без слишком коротких
  // подстрок вроде "еб" или "хер", которые ложно совпадали бы со словами
  // вроде "Херсон", "Глеб", "ребёнок")
  'хуй', 'хуе', 'хуя', 'нахер', 'похер', 'херня', 'хернёй',
  'пизд', 'пздц',
  'ебат', 'ебан', 'ебал', 'ебуч', 'выеб', 'наеб', 'подъеб', 'заеб',
  'бля', 'блят', 'блядь',
  'сука', 'сучк',
  'муда', 'мудак', 'мудил',
  'долбоеб', 'долбоёб',
  'гандон', 'гондон',
  'сволоч', 'падла', 'скотина',
  'урод', 'дебил', 'даун', 'придурок', 'кретин', 'тупиц',
  'шлюха', 'шалав', 'потаскух',
  'пидор', 'пидар', 'педик',
  'ниггер',
  // 18+ / интим-услуги / спам
  'проститут', 'интим услуг', 'секс за деньги', 'эскорт услуг',
  'порно', 'вебкам', 'нюдс',
  'куплю подписчик', 'заработок в интернете', 'казино', 'ставки на спорт',
];

if (listStopWords().length === 0) {
  for (const w of DEFAULT_STOP_WORDS) addStopWord(w);
}

// --- Жалобы пользователей друг на друга ---

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL,
    reported_id INTEGER NOT NULL,
    reason      TEXT,
    status      TEXT DEFAULT 'open',   -- open | resolved
    created_at  TEXT DEFAULT (datetime('now'))
  );
`);

export function addReport(reporterId, reportedId, reason) {
  db.prepare(
    `INSERT INTO reports (reporter_id, reported_id, reason) VALUES (@reporter_id, @reported_id, @reason)`
  ).run({ reporter_id: reporterId, reported_id: reportedId, reason });
}

export function listReports({ status } = {}) {
  const where = status ? `WHERE r.status = @status` : '';
  return db
    .prepare(
      `SELECT
         r.*,
         reporter.name AS reporter_name, reporter.username AS reporter_username,
         reported.name AS reported_name, reported.username AS reported_username,
         reported.photo_url AS reported_photo_url, reported.city AS reported_city,
         reported.age AS reported_age, reported.banned AS reported_banned
       FROM reports r
       LEFT JOIN users reporter ON reporter.user_id = r.reporter_id
       LEFT JOIN users reported ON reported.user_id = r.reported_id
       ${where}
       ORDER BY r.created_at DESC`
    )
    .all(status ? { status } : {});
}

export function resolveReport(id) {
  db.prepare(`UPDATE reports SET status = 'resolved' WHERE id = ?`).run(id);
}

export function countOpenReports() {
  return db.prepare(`SELECT COUNT(*) AS cnt FROM reports WHERE status = 'open'`).get().cnt;
}

// --- Аккаунты модераторов/админов (доп. к суперадмину из .env) ---

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'moderator', -- 'admin' | 'moderator'
    blocked       INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  );
`);

export function listAdmins() {
  return db.prepare('SELECT id, username, role, blocked, created_at FROM admins ORDER BY created_at DESC').all();
}

export function getAdminByUsername(username) {
  return db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
}

export function getAdminById(id) {
  return db.prepare('SELECT id, username, role, blocked, created_at FROM admins WHERE id = ?').get(id);
}

export function createAdmin(username, passwordHash, role) {
  db.prepare(
    `INSERT INTO admins (username, password_hash, role) VALUES (@username, @password_hash, @role)`
  ).run({ username, password_hash: passwordHash, role: role === 'admin' ? 'admin' : 'moderator' });
}

export function setAdminRole(id, role) {
  db.prepare(`UPDATE admins SET role = ? WHERE id = ?`).run(role === 'admin' ? 'admin' : 'moderator', id);
}

export function setAdminBlocked(id, blocked) {
  db.prepare(`UPDATE admins SET blocked = ? WHERE id = ?`).run(blocked ? 1 : 0, id);
}

export function deleteAdmin(id) {
  db.prepare('DELETE FROM admins WHERE id = ?').run(id);
}

// --- Журнал действий администраторов ---

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_logs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_name     TEXT NOT NULL,
    action         TEXT NOT NULL,
    target_user_id INTEGER,
    details        TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
  );
`);

export function logAdminAction(adminName, action, targetUserId, details) {
  db.prepare(
    `INSERT INTO admin_logs (admin_name, action, target_user_id, details)
     VALUES (@admin_name, @action, @target_user_id, @details)`
  ).run({
    admin_name: adminName,
    action,
    target_user_id: targetUserId ?? null,
    details: details ?? null,
  });
}

export function listAdminLogs(limit = 200) {
  return db.prepare(`SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT ?`).all(limit);
}
