// На этом ПК антивирус подменяет сертификаты HTTPS — тот же костыль, что и в
// bot.js. Для продакшена так делать не стоит.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import dotenv from 'dotenv';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getUser,
  listUsers,
  upsertUser,
  deleteUser,
  banUser,
  unbanUser,
  getStats,
  listDistinctCities,
  listUsersForBroadcast,
  listStopWords,
  addStopWord,
  removeStopWord,
  listReports,
  resolveReport,
  getRegistrationsByDay,
  getFunnel,
  listAdmins,
  getAdminByUsername,
  getAdminById,
  createAdmin,
  setAdminRole,
  setAdminBlocked,
  deleteAdmin,
  logAdminAction,
  listAdminLogs,
} from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Явно указываем путь к .env (он в корне проекта, на уровень выше папки admin/),
// чтобы это работало независимо от того, откуда запущен процесс — через
// "npm run admin" или напрямую кнопкой Run в IDE (у неё рабочая директория
// может отличаться).
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'change-me-please',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8 часов
  })
);

// Доступно во всех view без явной передачи — текущая роль и имя админа
// (нужно для того, чтобы прятать кнопки бана/удаления/управления админами у модераторов)
app.use((req, res, next) => {
  res.locals.role = req.session.role || null;
  res.locals.adminName = req.session.adminName || null;
  next();
});

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  return res.redirect('/login');
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.session.role === role) return next();
    return res.status(403).send('Недостаточно прав для этого действия — обратись к администратору.');
  };
}

// --- Авторизация ---

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;

  // Суперадмин — задаётся в .env, всегда работает, не хранится в БД
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    req.session.role = 'admin';
    req.session.adminName = username;
    return res.redirect('/users');
  }

  // Аккаунты модераторов/админов, созданные через панель
  const admin = getAdminByUsername(username);
  if (admin && !admin.blocked && bcrypt.compareSync(password || '', admin.password_hash)) {
    req.session.authenticated = true;
    req.session.role = admin.role;
    req.session.adminName = admin.username;
    return res.redirect('/users');
  }

  return res.render('login', { error: 'Неверный логин или пароль' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// --- Список пользователей ---

app.get('/', requireAuth, (req, res) => res.redirect('/users'));

app.get('/users', requireAuth, (req, res) => {
  const sortBy = req.query.sortBy || 'created_at';
  const order = req.query.order === 'asc' ? 'asc' : 'desc';
  const showDeleted = req.query.showDeleted === '1';
  const users = listUsers({ sortBy, order, includeDeleted: showDeleted });
  const stats = getStats();
  res.render('users', { users, sortBy, order, showDeleted, stats });
});

// --- Карточка пользователя: просмотр / редактирование / отправка на доработку ---

app.get('/users/:id', requireAuth, (req, res) => {
  const user = getUser(Number(req.params.id));
  if (!user) return res.status(404).send('Пользователь не найден');
  res.render('user', { user, saved: req.query.saved === '1', notifyError: null });
});

app.post('/users/:id', requireAuth, (req, res) => {
  const userId = Number(req.params.id);
  const user = getUser(userId);
  if (!user) return res.status(404).send('Пользователь не найден');

  const { name, age, city, gender, bio } = req.body;
  const before = { name: user.name, age: user.age, city: user.city, gender: user.gender, bio: user.bio };
  upsertUser(userId, {
    name: name?.trim() || null,
    age: age ? Number(age) : null,
    city: city?.trim() || null,
    gender: gender || null,
    bio: bio?.trim() ?? '',
  });

  const changed = Object.keys(before).filter((k) => String(before[k] ?? '') !== String(req.body[k] ?? ''));
  logAdminAction(res.locals.adminName, 'edit_profile', userId, `Изменены поля: ${changed.join(', ') || '—'}`);

  res.redirect(`/users/${userId}?saved=1`);
});

app.post('/users/:id/reject', requireAuth, async (req, res) => {
  const userId = Number(req.params.id);
  const user = getUser(userId);
  if (!user) return res.status(404).send('Пользователь не найден');

  const { note, clear_photo, clear_bio, clear_name } = req.body;
  const reviewNote = note?.trim() || 'Проверь анкету и обнови данные.';

  const updates = { reg_state: 'review_required', review_note: reviewNote };
  if (clear_photo) {
    updates.photo_token = null;
    updates.photo_url = null;
  }
  if (clear_bio) updates.bio = '';
  if (clear_name) updates.name = null;

  upsertUser(userId, updates);
  logAdminAction(res.locals.adminName, 'send_to_review', userId, reviewNote);

  let notifyError = null;
  try {
    await sendMaxMessage(
      userId,
      `⚠️ Администратор отправил твою анкету на доработку:\n\n${reviewNote}\n\n` +
      `Исправь анкету и сохрани — иначе она временно скрыта от других пользователей.`,
      [
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [
                { type: 'callback', text: '✏️ Редактировать анкету', payload: 'menu_edit' },
                { type: 'callback', text: '🗑 Удалить анкету', payload: 'menu_delete' },
              ],
            ],
          },
        },
      ]
    );
  } catch (err) {
    notifyError = err.message;
    console.error('Не удалось уведомить пользователя через MAX:', err.message);
  }

  if (notifyError) {
    return res.render('user', { user: getUser(userId), saved: true, notifyError });
  }
  res.redirect(`/users/${userId}?saved=1`);
});

app.post('/users/:id/delete', requireAuth, requireRole('admin'), (req, res) => {
  const userId = Number(req.params.id);
  logAdminAction(res.locals.adminName, 'delete_user', userId, null);
  deleteUser(userId);
  res.redirect('/users');
});

app.post('/users/:id/ban', requireAuth, requireRole('admin'), async (req, res) => {
  const userId = Number(req.params.id);
  const user = getUser(userId);
  if (!user) return res.status(404).send('Пользователь не найден');

  const reason = req.body.ban_reason?.trim() || 'Нарушение правил сервиса';
  banUser(userId, reason);
  logAdminAction(res.locals.adminName, 'ban', userId, reason);

  let notifyError = null;
  try {
    await sendMaxMessage(
      userId,
      `🚫 Твой аккаунт заблокирован администратором за нарушение правил сервиса.\n\nПричина: ${reason}\n\n` +
      `Бот больше недоступен для этого аккаунта.`
    );
  } catch (err) {
    notifyError = err.message;
    console.error('Не удалось уведомить пользователя о блокировке:', err.message);
  }

  res.render('user', { user: getUser(userId), saved: true, notifyError });
});

app.post('/users/:id/unban', requireAuth, requireRole('admin'), async (req, res) => {
  const userId = Number(req.params.id);
  const user = getUser(userId);
  if (!user) return res.status(404).send('Пользователь не найден');

  unbanUser(userId);
  logAdminAction(res.locals.adminName, 'unban', userId, null);

  let notifyError = null;
  try {
    await sendMaxMessage(userId, '✅ Блокировка снята администратором. Ты снова можешь пользоваться ботом — напиши /start.');
  } catch (err) {
    notifyError = err.message;
    console.error('Не удалось уведомить пользователя о снятии блокировки:', err.message);
  }

  res.render('user', { user: getUser(userId), saved: true, notifyError });
});

// --- Стоп-слова ---

app.get('/stop-words', requireAuth, (req, res) => {
  res.render('stop-words', { words: listStopWords(), error: null });
});

app.post('/stop-words', requireAuth, (req, res) => {
  const raw = req.body.word || '';
  const words = raw.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
  words.forEach(addStopWord);
  logAdminAction(res.locals.adminName, 'add_stop_words', null, words.join(', '));
  res.redirect('/stop-words');
});

app.post('/stop-words/delete', requireAuth, (req, res) => {
  removeStopWord(req.body.word || '');
  logAdminAction(res.locals.adminName, 'remove_stop_word', null, req.body.word || '');
  res.redirect('/stop-words');
});

// --- Жалобы пользователей ---

app.get('/reports', requireAuth, (req, res) => {
  const filter = req.query.status === 'all' ? undefined : 'open';
  const reports = listReports({ status: filter });
  res.render('reports', { reports, filter: filter || 'all' });
});

app.post('/reports/:id/resolve', requireAuth, (req, res) => {
  resolveReport(Number(req.params.id));
  logAdminAction(res.locals.adminName, 'resolve_report', null, `report #${req.params.id}`);
  res.redirect(req.get('Referer') || '/reports');
});

// --- Рассылка сообщений с фильтрами ---

app.get('/broadcast', requireAuth, (req, res) => {
  const cities = listDistinctCities();
  res.render('broadcast', { cities, result: null, form: {} });
});

app.post('/broadcast', requireAuth, async (req, res) => {
  const cities = listDistinctCities();
  const { text, city, gender, ageMin, ageMax } = req.body;

  if (!text || !text.trim()) {
    return res.render('broadcast', {
      cities,
      result: { error: 'Введи текст сообщения.' },
      form: req.body,
    });
  }

  const targets = listUsersForBroadcast({
    city: city || null,
    gender: gender || null,
    ageMin: ageMin || null,
    ageMax: ageMax || null,
  });

  let sent = 0;
  let failed = 0;
  for (const u of targets) {
    try {
      await sendMaxMessage(u.user_id, text.trim());
      sent++;
    } catch (err) {
      failed++;
      console.error(`Не удалось отправить пользователю ${u.user_id}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  logAdminAction(
    res.locals.adminName,
    'broadcast',
    null,
    `Фильтры: город=${city || 'любой'}, пол=${gender || 'любой'}, возраст=${ageMin || '–'}-${ageMax || '–'}. Отправлено ${sent}/${targets.length}`
  );

  res.render('broadcast', {
    cities,
    result: { sent, failed, total: targets.length },
    form: {},
  });
});

// --- Аналитика: рост и воронка ---

app.get('/analytics', requireAuth, (req, res) => {
  const registrations = getRegistrationsByDay(30);
  const funnel = getFunnel();
  res.render('analytics', { registrations, funnel });
});

// --- Аккаунты модераторов/админов ---

app.get('/admins', requireAuth, requireRole('admin'), (req, res) => {
  res.render('admins', { admins: listAdmins(), superAdminUsername: process.env.ADMIN_USERNAME, error: null });
});

app.post('/admins', requireAuth, requireRole('admin'), (req, res) => {
  const { username, password, role } = req.body;
  if (!username?.trim() || !password) {
    return res.render('admins', {
      admins: listAdmins(),
      superAdminUsername: process.env.ADMIN_USERNAME,
      error: 'Укажи логин и пароль.',
    });
  }
  if (getAdminByUsername(username.trim()) || username.trim() === process.env.ADMIN_USERNAME) {
    return res.render('admins', {
      admins: listAdmins(),
      superAdminUsername: process.env.ADMIN_USERNAME,
      error: 'Такой логин уже занят.',
    });
  }

  const hash = bcrypt.hashSync(password, 10);
  createAdmin(username.trim(), hash, role);
  logAdminAction(res.locals.adminName, 'create_admin', null, `${username.trim()} (${role})`);
  res.redirect('/admins');
});

app.post('/admins/:id/role', requireAuth, requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const admin = getAdminById(id);
  setAdminRole(id, req.body.role);
  logAdminAction(res.locals.adminName, 'change_admin_role', null, `${admin?.username} → ${req.body.role}`);
  res.redirect('/admins');
});

app.post('/admins/:id/block', requireAuth, requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const admin = getAdminById(id);
  setAdminBlocked(id, true);
  logAdminAction(res.locals.adminName, 'block_admin', null, admin?.username);
  res.redirect('/admins');
});

app.post('/admins/:id/unblock', requireAuth, requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const admin = getAdminById(id);
  setAdminBlocked(id, false);
  logAdminAction(res.locals.adminName, 'unblock_admin', null, admin?.username);
  res.redirect('/admins');
});

app.post('/admins/:id/delete', requireAuth, requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const admin = getAdminById(id);
  deleteAdmin(id);
  logAdminAction(res.locals.adminName, 'delete_admin', null, admin?.username);
  res.redirect('/admins');
});

// --- Журнал действий администраторов ---

app.get('/admin-log', requireAuth, requireRole('admin'), (req, res) => {
  res.render('admin-log', { logs: listAdminLogs(200) });
});

// --- Отправка сообщения пользователю напрямую через MAX API ---
// (админ-панель — отдельный процесс от бота, поэтому обращается к MAX API сама,
// используя тот же токен бота)
async function sendMaxMessage(userId, text, attachments) {
  const body = { text };
  if (attachments) body.attachments = attachments;

  const apiRes = await fetch(`https://platform-api2.max.ru/messages?user_id=${userId}`, {
    method: 'POST',
    headers: {
      Authorization: process.env.BOT_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!apiRes.ok) {
    const errText = await apiRes.text();
    throw new Error(`MAX API ${apiRes.status}: ${errText}`);
  }
  return apiRes.json();
}

const PORT = process.env.ADMIN_PORT || 3001;
app.listen(PORT, () => console.log(`Admin panel: http://localhost:${PORT}`));
