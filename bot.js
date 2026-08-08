process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import 'dotenv/config';
import { Bot, Keyboard, ImageAttachment } from '@maxhub/max-bot-api';
import {
  getUser,
  upsertUser,
  deleteUser,
  markSelfDeleted,
  recordSwipe,
  hasLiked,
  getNextCandidate,
  countRecentSwipes,
  DAILY_SWIPE_LIMIT,
  recordMatch,
  getMatches,
  containsStopWord,
  addReport,
  touchLastActive,
  markReminderSent,
  markRegistrationCompleted,
  listInactiveUsersForReminder,
  countFreshCandidatesInCity,
} from './db.js';

const bot = new Bot(process.env.BOT_TOKEN);

// Не даём одной ошибке (например, попытке написать несуществующему тестовому
// пользователю) обрушить весь процесс бота.
bot.catch(async (error, ctx) => {
  console.error('Ошибка при обработке апдейта:', error?.message ?? error);
});

// Блокировка забаненных администратором пользователей — проверяется перед
// любым другим обработчиком (командой, кнопкой, текстом).
bot.use(async (ctx, next) => {
  const userId = ctx.user?.user_id;
  if (userId) {
    const user = getUser(userId);
    if (user?.banned) {
      return ctx.reply(
        `🚫 Твой аккаунт заблокирован администратором и не может пользоваться ботом.\n\n` +
        `Причина: ${user.ban_reason || 'нарушение правил сервиса'}.`
      );
    }
    if (user) touchLastActive(userId);
  }
  return next();
});

async function safeSendToUser(userId, text, extra) {
  try {
    return await bot.api.sendMessageToUser(userId, text, extra);
  } catch (err) {
    console.error(`Не удалось отправить сообщение пользователю ${userId}:`, err?.message ?? err);
    return null;
  }
}

bot.api.setMyCommands([
  { name: 'start', description: 'Начать / посмотреть свою анкету' },
  { name: 'search', description: 'Смотреть анкеты' },
  { name: 'profile', description: 'Моя анкета' },
  { name: 'edit', description: 'Редактировать анкету' },
  { name: 'delete', description: 'Удалить анкету' },
  { name: 'matches', description: 'Мои мэтчи' },
  { name: 'rules', description: 'Правила сервиса' },
]);

// --- Валидаторы анкеты ---
function parseAge(text) {
  const age = parseInt(text.trim(), 10);
  if (Number.isNaN(age) || age < 18 || age > 100) return null;
  return age;
}

function parseName(text) {
  const name = text.trim();
  if (name.length < 2 || name.length > 40) return null;
  return name;
}

function parseCity(text) {
  const city = text.trim();
  if (city.length < 2 || city.length > 60) return null;
  return city;
}

const BIO_MAX_LENGTH = 200; // примерно 2-3 коротких предложения

function parseBio(text) {
  const bio = text.trim();
  if (bio.length > BIO_MAX_LENGTH) return null;
  return bio;
}

function genderLabel(gender) {
  if (gender === 'male') return 'Мужской';
  if (gender === 'female') return 'Женский';
  return '—';
}

function targetGenderFor(gender) {
  if (gender === 'male') return 'female';
  if (gender === 'female') return 'male';
  return null; // пол не указан — не фильтруем
}

// --- Клавиатуры ---
function genderKeyboard() {
  return Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('👨 Мужской', 'gender_male'),
      Keyboard.button.callback('👩 Женский', 'gender_female'),
    ],
  ]);
}

function confirmKeyboard() {
  return Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('✅ Всё верно', 'confirm_profile'),
      Keyboard.button.callback('✏️ Заполнить заново', 'edit_profile'),
    ],
  ]);
}

function swipeKeyboard(candidateId) {
  return Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('👎 Пропустить', `skip:${candidateId}`),
      Keyboard.button.callback('❤️ Нравится', `like:${candidateId}`),
    ],
    [Keyboard.button.callback('🚨 Пожаловаться', `report:${candidateId}`)],
    [Keyboard.button.callback('🏠 В главное меню', 'back_to_menu')],
  ]);
}

function reportReasonKeyboard(candidateId) {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('Неприемлемое фото', `report_reason:${candidateId}:photo`)],
    [Keyboard.button.callback('Оскорбления / мат', `report_reason:${candidateId}:abuse`)],
    [Keyboard.button.callback('Спам / реклама', `report_reason:${candidateId}:spam`)],
    [Keyboard.button.callback('Похоже на фейк', `report_reason:${candidateId}:fake`)],
    [Keyboard.button.callback('Другое', `report_reason:${candidateId}:other`)],
  ]);
}

const REPORT_REASON_LABELS = {
  photo: 'Неприемлемое фото',
  abuse: 'Оскорбления / мат',
  spam: 'Спам / реклама',
  fake: 'Похоже на фейк',
};

function mainMenuKeyboard() {
  return Keyboard.inlineKeyboard([
    [Keyboard.button.callback('🔍 Смотреть анкеты', 'menu_search')],
    [
      Keyboard.button.callback('👤 Моя анкета', 'menu_profile'),
      Keyboard.button.callback('✏️ Редактировать', 'menu_edit'),
    ],
    [
      Keyboard.button.callback('💌 Мои мэтчи', 'menu_matches'),
      Keyboard.button.callback('🗑 Удалить анкету', 'menu_delete'),
    ],
    [Keyboard.button.callback('📜 Правила сервиса', 'menu_rules')],
  ]);
}

// Показывает сообщение об итоге редактирования и сразу главное меню под ним
async function finishEditing(ctx, message) {
  return ctx.reply(message, { attachments: [mainMenuKeyboard()] });
}

function editMenuKeyboard() {
  return Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('👤 Имя', 'edit_name'),
      Keyboard.button.callback('🎂 Возраст', 'edit_age'),
    ],
    [
      Keyboard.button.callback('🏙 Город', 'edit_city'),
      Keyboard.button.callback('⚧ Пол', 'edit_gender'),
    ],
    [
      Keyboard.button.callback('📷 Фото', 'edit_photo'),
      Keyboard.button.callback('📝 Описание', 'edit_bio'),
    ],
    [Keyboard.button.callback('Отмена', 'edit_cancel')],
  ]);
}

function cancelKeyboard() {
  return Keyboard.inlineKeyboard([[Keyboard.button.callback('Отмена', 'edit_cancel')]]);
}

function skipBioKeyboard(payload = 'bio_skip') {
  return Keyboard.inlineKeyboard([[Keyboard.button.callback('Пропустить', payload)]]);
}

function editGenderKeyboard() {
  return Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('👨 Мужской', 'gender_male'),
      Keyboard.button.callback('👩 Женский', 'gender_female'),
    ],
    [Keyboard.button.callback('Отмена', 'edit_cancel')],
  ]);
}

function deleteConfirmKeyboard() {
  return Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('❌ Да, удалить', 'delete_confirm'),
      Keyboard.button.callback('Отмена', 'delete_cancel'),
    ],
  ]);
}

async function showProfilePreview(ctx, user) {
  const bioLine = user.bio ? `\n\n${user.bio}` : '';
  const caption =
    `Проверь анкету:\n\n` +
    `Имя: ${user.name}\nВозраст: ${user.age}\nГород: ${user.city}\nПол: ${genderLabel(user.gender)}${bioLine}\n\n` +
    `Всё верно?`;

  if (user.photo_token) {
    const image = new ImageAttachment({ token: user.photo_token });
    return ctx.reply(caption, { attachments: [image.toJson(), confirmKeyboard()] });
  }
  return ctx.reply(caption, { attachments: [confirmKeyboard()] });
}

function profileCaption(user, { withHeader } = {}) {
  const header = withHeader ? `${withHeader}\n\n` : '';
  const bioLine = user.bio ? `\n\n${user.bio}` : '';
  return `${header}Имя: ${user.name}\nВозраст: ${user.age}\nГород: ${user.city}\nПол: ${genderLabel(user.gender)}${bioLine}`;
}

async function showOwnProfile(ctx, user, header) {
  const caption = profileCaption(user, { withHeader: header });
  if (user.photo_token) {
    const image = new ImageAttachment({ token: user.photo_token });
    return ctx.reply(caption, { attachments: [image.toJson()] });
  }
  return ctx.reply(caption);
}

async function showNextCandidate(ctx, userId) {
  if (countRecentSwipes(userId) >= DAILY_SWIPE_LIMIT) {
    return ctx.reply(
      `Ты уже посмотрел(а) ${DAILY_SWIPE_LIMIT} анкет за последние 24 часа — это дневной лимит 🙌\n\n` +
      `Чтобы смотреть больше анкет без ограничений, скоро можно будет оформить подписку.`,
      { attachments: [mainMenuKeyboard()] }
    );
  }

  const me = getUser(userId);
  if (!me || me.reg_state !== 'done') {
    return ctx.reply('Сначала заполни анкету — напиши /start');
  }
  const candidate = getNextCandidate(userId, me.city, targetGenderFor(me.gender), me.age);

  if (!candidate) {
    return ctx.reply(
      'Анкеты закончились — новых пока нет 🙁 Загляни чуть позже, когда появятся новые анкеты.',
      { attachments: [mainMenuKeyboard()] }
    );
  }

  const bioLine = candidate.bio ? `\n${candidate.bio}` : '';
  const caption = `${candidate.name}, ${candidate.age}\n${candidate.city}${bioLine}`;

  if (candidate.photo_token) {
    const image = new ImageAttachment({ token: candidate.photo_token });
    return ctx.reply(caption, {
      attachments: [image.toJson(), swipeKeyboard(candidate.user_id)],
    });
  }
  return ctx.reply(caption, { attachments: [swipeKeyboard(candidate.user_id)] });
}

function matchInstructions(partnerName) {
  return (
    `У вас взаимная симпатия с ${partnerName}! 🎉\n\n` +
    `Чтобы продолжить общение, отправь ${partnerName} ссылку-приглашение на свой профиль в MAX ` +
    `(переписываться внутри бота не нужно).\n\n` +
    `Как получить ссылку:\n` +
    `1. Открой Настройки в MAX\n` +
    `2. Нажми «Пригласить друзей»\n` +
    `3. Выбери «Пригласить по ссылке» → «Скопировать ссылку»\n` +
    `4. Пришли эту ссылку сюда, в этот чат с ботом — я перешлю её ${partnerName}.`
  );
}

// --- Старт диалога / регистрация ---
async function handleStart(ctx) {
  const userId = ctx.user.user_id;
  const username = ctx.user.username ?? null;
  const user = getUser(userId);

  if (user && user.reg_state === 'done') {
    await showOwnProfile(ctx, user, `С возвращением, ${user.name}!`);
    return ctx.reply('Что делаем дальше?', { attachments: [mainMenuKeyboard()] });
  }

  if (user && user.reg_state === 'review_required') {
    await showOwnProfile(ctx, user, `С возвращением, ${user.name}!`);
    return showReviewReminder(ctx, user);
  }

  upsertUser(userId, { username, reg_state: 'ask_name' });
  return ctx.reply(
    'Привет! Давай познакомимся 👋\nЭто бот знакомств для пользователей MAX.\n\n' +
    'Для начала заполним небольшую анкету.\nКак тебя зовут?'
  );
}

bot.command('start', handleStart);
// Срабатывает, когда пользователь открывает бота впервые (или после удаления
// чата) и нажимает кнопку «Начать» на карточке бота
bot.on('bot_started', handleStart);

const RULES_TEXT =
  '📜 Правила сервиса\n\n' +
  '1. Указывай о себе достоверную информацию: настоящее имя (или его форму), реальный возраст и город.\n' +
  '2. Фото профиля — только своё, где чётко видно лицо. Чужие фото, фото знаменитостей, коллажи и рекламные картинки запрещены.\n' +
  '3. Запрещены оскорбления, нецензурная лексика и разжигание ненависти в любой форме — в имени, описании и переписке.\n' +
  '4. Запрещены фото и описания сексуального характера, обнажённый и откровенный контент 18+.\n' +
  '5. Запрещена реклама, спам, ссылки на сторонние ресурсы и предложение платных услуг.\n' +
  '6. Запрещено выдавать себя за другого человека и создавать фальшивые анкеты.\n' +
  '7. Уважай собеседника: если общение не складывается — просто прекрати переписку, без грубости.\n\n' +
  '⚠️ Нарушение правил может привести к отправке анкеты на доработку или к полной блокировке в сервисе.';

bot.command('rules', async (ctx) => ctx.reply(RULES_TEXT, { attachments: [mainMenuKeyboard()] }));
bot.action('menu_rules', async (ctx) => ctx.reply(RULES_TEXT, { attachments: [mainMenuKeyboard()] }));

function reviewKeyboard() {
  return Keyboard.inlineKeyboard([
    [
      Keyboard.button.callback('✏️ Редактировать анкету', 'menu_edit'),
      Keyboard.button.callback('🗑 Удалить анкету', 'menu_delete'),
    ],
  ]);
}

async function showReviewReminder(ctx, user) {
  return ctx.reply(
    `⚠️ Администратор отправил твою анкету на доработку:\n\n${user.review_note || 'Проверь анкету и обнови данные.'}\n\n` +
    `Исправь анкету и сохрани — тогда снова сможешь смотреть анкеты и получать лайки.`,
    { attachments: [reviewKeyboard()] }
  );
}

// --- Главное меню ---
bot.command('profile', async (ctx) => {
  const user = getUser(ctx.user.user_id);
  if (!user || (user.reg_state !== 'done' && user.reg_state !== 'review_required')) {
    return ctx.reply('Сначала заполни анкету — напиши /start');
  }
  await showOwnProfile(ctx, user, 'Твоя анкета:');
  if (user.reg_state === 'review_required') return showReviewReminder(ctx, user);
  return ctx.reply('Что делаем дальше?', { attachments: [mainMenuKeyboard()] });
});
bot.action('menu_profile', async (ctx) => {
  const user = getUser(ctx.user.user_id);
  if (!user || (user.reg_state !== 'done' && user.reg_state !== 'review_required')) {
    return ctx.reply('Сначала заполни анкету — напиши /start');
  }
  await showOwnProfile(ctx, user, 'Твоя анкета:');
  if (user.reg_state === 'review_required') return showReviewReminder(ctx, user);
  return ctx.reply('Что делаем дальше?', { attachments: [mainMenuKeyboard()] });
});

bot.command('search', async (ctx) => {
  const user = getUser(ctx.user.user_id);
  if (user && user.reg_state === 'review_required') return showReviewReminder(ctx, user);
  if (!user || user.reg_state !== 'done') return ctx.reply('Сначала заполни анкету — напиши /start');
  return showNextCandidate(ctx, ctx.user.user_id);
});
bot.action('menu_search', async (ctx) => {
  const user = getUser(ctx.user.user_id);
  if (user && user.reg_state === 'review_required') return showReviewReminder(ctx, user);
  return showNextCandidate(ctx, ctx.user.user_id);
});

bot.command('matches', async (ctx) => showMatches(ctx));
bot.action('menu_matches', async (ctx) => showMatches(ctx));

async function showMatches(ctx) {
  const matches = getMatches(ctx.user.user_id);
  if (matches.length === 0) {
    return ctx.reply('Пока мэтчей нет — заходи в /search, чтобы найти анкеты!', {
      attachments: [mainMenuKeyboard()],
    });
  }
  const list = matches.map((m) => `• ${m.name}, ${m.age}, ${m.city}`).join('\n');
  return ctx.reply(`Твои мэтчи:\n\n${list}`, { attachments: [mainMenuKeyboard()] });
}

bot.command('edit', async (ctx) => {
  const user = getUser(ctx.user.user_id);
  if (!user || (user.reg_state !== 'done' && user.reg_state !== 'review_required')) {
    return ctx.reply('Сначала заполни анкету — напиши /start');
  }
  return ctx.reply('Что хочешь изменить?', { attachments: [editMenuKeyboard()] });
});
bot.action('menu_edit', async (ctx) => ctx.reply('Что хочешь изменить?', { attachments: [editMenuKeyboard()] }));

bot.action('edit_name', async (ctx) => {
  upsertUser(ctx.user.user_id, { reg_state: 'edit_name' });
  return ctx.reply('Как тебя зовут?', { attachments: [cancelKeyboard()] });
});
bot.action('edit_age', async (ctx) => {
  upsertUser(ctx.user.user_id, { reg_state: 'edit_age' });
  return ctx.reply('Сколько тебе лет?', { attachments: [cancelKeyboard()] });
});
bot.action('edit_city', async (ctx) => {
  upsertUser(ctx.user.user_id, { reg_state: 'edit_city' });
  return ctx.reply('Из какого ты города?', { attachments: [cancelKeyboard()] });
});
bot.action('edit_gender', async (ctx) => {
  upsertUser(ctx.user.user_id, { reg_state: 'edit_gender' });
  return ctx.reply('Укажи свой пол:', { attachments: [editGenderKeyboard()] });
});
bot.action('edit_photo', async (ctx) => {
  upsertUser(ctx.user.user_id, { reg_state: 'edit_photo' });
  return ctx.reply('Пришли новое фото 📸', { attachments: [cancelKeyboard()] });
});
bot.action('edit_bio', async (ctx) => {
  upsertUser(ctx.user.user_id, { reg_state: 'edit_bio' });
  return ctx.reply(
    `Расскажи немного о себе (до ${BIO_MAX_LENGTH} символов, 2–3 коротких предложения):`,
    { attachments: [cancelKeyboard()] }
  );
});

bot.action('edit_cancel', async (ctx) => {
  const userId = ctx.user.user_id;
  const user = getUser(userId);
  if (user && user.reg_state !== 'done' && user.reg_state !== 'new') {
    if (user.review_note) {
      upsertUser(userId, { reg_state: 'review_required' });
      return showReviewReminder(ctx, getUser(userId));
    }
    upsertUser(userId, { reg_state: 'done' });
  }
  return finishEditing(ctx, 'Хорошо, ничего не меняю.');
});

bot.command('delete', async (ctx) => {
  return ctx.reply('Точно удалить анкету? Это действие необратимо.', {
    attachments: [deleteConfirmKeyboard()],
  });
});
bot.action('menu_delete', async (ctx) => {
  return ctx.reply('Точно удалить анкету? Это действие необратимо.', {
    attachments: [deleteConfirmKeyboard()],
  });
});
bot.action('delete_confirm', async (ctx) => {
  markSelfDeleted(ctx.user.user_id);
  return ctx.reply('Анкета удалена. Если захочешь вернуться — просто напиши /start.');
});
bot.action('delete_cancel', async (ctx) => finishEditing(ctx, 'Хорошо, ничего не удаляю.'));

bot.action('bio_skip', async (ctx) => {
  const userId = ctx.user.user_id;
  const user = getUser(userId);
  if (!user) return;

  if (user.reg_state === 'ask_bio') {
    upsertUser(userId, { bio: '', reg_state: 'ask_photo' });
    return ctx.reply('Хорошо, без описания. Почти готово! Пришли своё фото для анкеты 📸');
  }
  if (user.reg_state === 'edit_bio') {
    upsertUser(userId, { bio: '', reg_state: 'done', review_note: null });
    return finishEditing(ctx, 'Описание удалено ✅');
  }
});

// --- Выбор пола (при регистрации и при редактировании) ---
bot.action('gender_male', async (ctx) => handleGenderPick(ctx, 'male'));
bot.action('gender_female', async (ctx) => handleGenderPick(ctx, 'female'));

async function handleGenderPick(ctx, gender) {
  const userId = ctx.user.user_id;
  const user = getUser(userId);
  if (!user) return;

  if (user.reg_state === 'ask_gender') {
    upsertUser(userId, { gender, reg_state: 'ask_bio' });
    return ctx.reply(
      `Расскажи немного о себе (необязательно, до ${BIO_MAX_LENGTH} символов, 2–3 коротких предложения) — ` +
      `или нажми «Пропустить»:`,
      { attachments: [skipBioKeyboard()] }
    );
  }
  if (user.reg_state === 'edit_gender') {
    upsertUser(userId, { gender, reg_state: 'done', review_note: null });
    return finishEditing(ctx, `Пол обновлён: ${genderLabel(gender)} ✅`);
  }
}

// Убирает inline-клавиатуру с сообщения, оставляя текст и фото как есть
async function stripKeyboard(ctx) {
  const mid = ctx.message?.body?.mid;
  if (!mid) return;
  const text = ctx.message?.body?.text ?? '';
  const keepAttachments = (ctx.message?.body?.attachments ?? []).filter(
    (a) => a.type !== 'inline_keyboard'
  );
  try {
    await ctx.api.editMessage(mid, { text, attachments: keepAttachments });
  } catch (err) {
    console.error('Не удалось убрать кнопки с сообщения:', err?.message ?? err);
  }
}

// --- Кнопки подтверждения анкеты ---
bot.action('confirm_profile', async (ctx) => {
  const userId = ctx.user.user_id;
  const user = upsertUser(userId, { reg_state: 'done' });
  markRegistrationCompleted(userId);

  const previewMid = ctx.message?.body?.mid;
  if (previewMid) await ctx.api.deleteMessage(previewMid).catch(() => {});

  await showOwnProfile(ctx, user, 'Анкета сохранена ✅');
  return ctx.reply('Готов(а) смотреть анкеты?', { attachments: [mainMenuKeyboard()] });
});

bot.action('edit_profile', async (ctx) => {
  const userId = ctx.user.user_id;
  upsertUser(userId, {
    name: null,
    age: null,
    city: null,
    gender: null,
    photo_token: null,
    reg_state: 'ask_name',
  });

  const previewMid = ctx.message?.body?.mid;
  if (previewMid) await ctx.api.deleteMessage(previewMid).catch(() => {});

  return ctx.reply('Хорошо, начнём заново. Как тебя зовут?');
});

// --- Лайк / пропуск анкеты ---
bot.action('back_to_menu', async (ctx) => {
  await stripKeyboard(ctx);
  return ctx.reply('Что делаем дальше?', { attachments: [mainMenuKeyboard()] });
});

bot.action(/^skip:(\d+)$/, async (ctx) => {
  const userId = ctx.user.user_id;
  const candidateId = Number(ctx.match[1]);
  recordSwipe(userId, candidateId, 'skip');

  await stripKeyboard(ctx);
  return showNextCandidate(ctx, userId);
});

// --- Жалоба на анкету ---
bot.action(/^report:(\d+)$/, async (ctx) => {
  const candidateId = Number(ctx.match[1]);
  return ctx.reply('Что не так с этой анкетой?', { attachments: [reportReasonKeyboard(candidateId)] });
});

bot.action(/^report_reason:(\d+):(\w+)$/, async (ctx) => {
  const userId = ctx.user.user_id;
  const candidateId = Number(ctx.match[1]);
  const reasonCode = ctx.match[2];

  if (reasonCode === 'other') {
    upsertUser(userId, { awaiting_report_for: candidateId });
    return ctx.reply('Опиши, пожалуйста, коротко, в чём проблема:');
  }

  addReport(userId, candidateId, REPORT_REASON_LABELS[reasonCode] || reasonCode);
  return ctx.reply('Спасибо, жалоба отправлена администратору на рассмотрение.', {
    attachments: [mainMenuKeyboard()],
  });
});

bot.action(/^like:(\d+)$/, async (ctx) => {
  const userId = ctx.user.user_id;
  const candidateId = Number(ctx.match[1]);
  recordSwipe(userId, candidateId, 'like');
  await stripKeyboard(ctx);

  const me = getUser(userId);
  const candidate = getUser(candidateId);

  if (!me || !candidate) {
    return ctx.reply('Эта анкета больше не доступна.', { attachments: [mainMenuKeyboard()] });
  }

  if (hasLiked(candidateId, userId)) {
    // Взаимный лайк — оба готовят и обмениваются ссылками-приглашениями
    recordMatch(userId, candidateId);
    upsertUser(userId, { awaiting_link_for: candidateId });
    upsertUser(candidateId, { awaiting_link_for: userId });

    await ctx.reply(matchInstructions(candidate.name));
    await safeSendToUser(candidateId, matchInstructions(me.name));
  } else {
    // Пока лайк не взаимный — сразу уведомляем того, кого лайкнули
    const notifyCaption =
      `Тебе поставили лайк! 💌\n\n${me.name}, ${me.age}\n${me.city}\n\nНравится тебе эта анкета?`;

    if (me.photo_token) {
      const image = new ImageAttachment({ token: me.photo_token });
      await safeSendToUser(candidateId, notifyCaption, {
        attachments: [image.toJson(), swipeKeyboard(userId)],
      });
    } else {
      await safeSendToUser(candidateId, notifyCaption, { attachments: [swipeKeyboard(userId)] });
    }
  }

  return showNextCandidate(ctx, userId);
});

// --- Обработка ответов анкеты / пересылка ссылки-приглашения ---
bot.on('message_created', async (ctx) => {
  const text = ctx.message?.body?.text;
  const attachments = ctx.message?.body?.attachments ?? [];

  if (text && text.startsWith('/')) return;

  const userId = ctx.user.user_id;
  const user = getUser(userId);

  if (!user || user.reg_state === 'new') {
    return ctx.reply('Напиши /start, чтобы начать регистрацию.');
  }

  // Если ждём от пользователя ссылку-приглашение после мэтча — приоритет за этим
  if (user.awaiting_link_for && text) {
    const looksLikeLink = /https?:\/\//i.test(text) || text.includes('max.ru');
    if (!looksLikeLink) {
      return ctx.reply(
        'Это не похоже на ссылку. Пришли, пожалуйста, именно ссылку-приглашение из MAX ' +
        '(Настройки → Пригласить друзей → Скопировать ссылку).'
      );
    }
    const targetId = user.awaiting_link_for;
    const target = getUser(targetId);
    await safeSendToUser(targetId, `${user.name} отправил(а) тебе ссылку на свой профиль:\n${text}`);
    upsertUser(userId, { awaiting_link_for: null });
    return ctx.reply(`Готово! Отправил(а) твою ссылку ${target?.name ?? 'собеседнику'}.`);
  }

  // Ждём текст жалобы («Другое»)
  if (user.awaiting_report_for && text) {
    addReport(userId, user.awaiting_report_for, text.trim());
    upsertUser(userId, { awaiting_report_for: null });
    return ctx.reply('Спасибо, жалоба отправлена администратору на рассмотрение.', {
      attachments: [mainMenuKeyboard()],
    });
  }

  switch (user.reg_state) {
    case 'ask_name': {
      if (!text) return ctx.reply('Напиши своё имя текстом:');
      if (containsStopWord(text)) {
        return ctx.reply('Это имя содержит недопустимое слово или выражение. Укажи, пожалуйста, другое имя:');
      }
      const name = parseName(text);
      if (!name) return ctx.reply('Имя должно быть от 2 до 40 символов. Попробуй ещё раз:');
      upsertUser(userId, { name, reg_state: 'ask_age' });
      return ctx.reply(`Приятно познакомиться, ${name}! Сколько тебе лет?`);
    }

    case 'ask_age': {
      if (!text) return ctx.reply('Напиши свой возраст числом:');
      const age = parseAge(text);
      if (age === null) return ctx.reply('Введи возраст числом (от 18 до 100):');
      upsertUser(userId, { age, reg_state: 'ask_city' });
      return ctx.reply('Из какого ты города?');
    }

    case 'ask_city': {
      if (!text) return ctx.reply('Напиши название города текстом:');
      if (containsStopWord(text)) {
        return ctx.reply('Это название содержит недопустимое слово или выражение. Укажи, пожалуйста, реальный город:');
      }
      const city = parseCity(text);
      if (!city) return ctx.reply('Название города должно быть от 2 до 60 символов. Попробуй ещё раз:');
      upsertUser(userId, { city, reg_state: 'ask_gender' });
      return ctx.reply('Укажи свой пол:', { attachments: [genderKeyboard()] });
    }

    case 'ask_gender':
      return ctx.reply('Выбери один из вариантов на кнопках выше 👆', { attachments: [genderKeyboard()] });

    case 'ask_bio': {
      if (!text) return ctx.reply('Напиши немного о себе текстом или нажми «Пропустить»:', { attachments: [skipBioKeyboard()] });
      if (containsStopWord(text)) {
        return ctx.reply(
          'Это описание содержит недопустимое слово или выражение. Отредактируй текст и попробуй снова:',
          { attachments: [skipBioKeyboard()] }
        );
      }
      const bio = parseBio(text);
      if (bio === null) {
        return ctx.reply(
          `Слишком длинно — максимум ${BIO_MAX_LENGTH} символов. Сократи и попробуй ещё раз:`,
          { attachments: [skipBioKeyboard()] }
        );
      }
      upsertUser(userId, { bio, reg_state: 'ask_photo' });
      return ctx.reply('Почти готово! Пришли своё фото для анкеты 📸');
    }

    case 'ask_photo': {
      const image = attachments.find((a) => a.type === 'image');
      if (!image) return ctx.reply('Нужно прислать именно фото (картинкой, не файлом). Попробуй ещё раз:');
      const updated = upsertUser(userId, {
        photo_token: image.payload?.token,
        photo_url: image.payload?.url ?? null,
        reg_state: 'confirm',
      });
      return showProfilePreview(ctx, updated);
    }

    case 'confirm':
      return ctx.reply('Нажми одну из кнопок выше, чтобы подтвердить анкету или заполнить заново.');

    case 'edit_name': {
      if (!text) return ctx.reply('Напиши имя текстом:', { attachments: [cancelKeyboard()] });
      if (containsStopWord(text)) {
        return ctx.reply(
          'Это имя содержит недопустимое слово или выражение. Укажи, пожалуйста, другое имя:',
          { attachments: [cancelKeyboard()] }
        );
      }
      const name = parseName(text);
      if (!name) return ctx.reply('Имя должно быть от 2 до 40 символов. Попробуй ещё раз:', { attachments: [cancelKeyboard()] });
      upsertUser(userId, { name, reg_state: 'done', review_note: null });
      return finishEditing(ctx, `Имя обновлено: ${name} ✅`);
    }

    case 'edit_age': {
      if (!text) return ctx.reply('Напиши возраст числом:', { attachments: [cancelKeyboard()] });
      const age = parseAge(text);
      if (age === null) return ctx.reply('Введи возраст числом (от 18 до 100):', { attachments: [cancelKeyboard()] });
      upsertUser(userId, { age, reg_state: 'done', review_note: null });
      return finishEditing(ctx, `Возраст обновлён: ${age} ✅`);
    }

    case 'edit_city': {
      if (!text) return ctx.reply('Напиши город текстом:', { attachments: [cancelKeyboard()] });
      if (containsStopWord(text)) {
        return ctx.reply(
          'Это название содержит недопустимое слово или выражение. Укажи, пожалуйста, реальный город:',
          { attachments: [cancelKeyboard()] }
        );
      }
      const city = parseCity(text);
      if (!city) return ctx.reply('Название города должно быть от 2 до 60 символов. Попробуй ещё раз:', { attachments: [cancelKeyboard()] });
      upsertUser(userId, { city, reg_state: 'done', review_note: null });
      return finishEditing(ctx, `Город обновлён: ${city} ✅`);
    }

    case 'edit_gender':
      return ctx.reply('Выбери один из вариантов на кнопках выше 👆', { attachments: [editGenderKeyboard()] });

    case 'edit_bio': {
      if (!text) {
        return ctx.reply('Напиши описание текстом или нажми «Пропустить», чтобы убрать его:', {
          attachments: [skipBioKeyboard()],
        });
      }
      if (containsStopWord(text)) {
        return ctx.reply(
          'Это описание содержит недопустимое слово или выражение. Отредактируй текст и попробуй снова:',
          { attachments: [skipBioKeyboard()] }
        );
      }
      const bio = parseBio(text);
      if (bio === null) {
        return ctx.reply(
          `Слишком длинно — максимум ${BIO_MAX_LENGTH} символов. Сократи и попробуй ещё раз:`,
          { attachments: [skipBioKeyboard()] }
        );
      }
      upsertUser(userId, { bio, reg_state: 'done', review_note: null });
      return finishEditing(ctx, 'Описание обновлено ✅');
    }

    case 'edit_photo': {
      const image = attachments.find((a) => a.type === 'image');
      if (!image) return ctx.reply('Нужно прислать именно фото (картинкой, не файлом). Попробуй ещё раз:', { attachments: [cancelKeyboard()] });
      upsertUser(userId, {
        photo_token: image.payload?.token,
        photo_url: image.payload?.url ?? null,
        reg_state: 'done',
        review_note: null,
      });
      return finishEditing(ctx, 'Фото обновлено ✅');
    }

    case 'review_required':
      return showReviewReminder(ctx, user);

    case 'done':
    default:
      return ctx.reply('Что делаем дальше?', { attachments: [mainMenuKeyboard()] });
  }
});

// --- Напоминания неактивным пользователям ---
// Раз в час проверяем, кто не заходил больше REMINDER_INACTIVE_HOURS часов,
// и если у него в базе есть непросмотренные анкеты его города — шлём напоминание
// (не чаще одного раза в REMINDER_COOLDOWN_HOURS часов на человека).
const REMINDER_INACTIVE_HOURS = 48;
const REMINDER_COOLDOWN_HOURS = 48;
const REMINDER_CHECK_INTERVAL_MS = 60 * 60 * 1000; // раз в час

async function sendInactivityReminders() {
  const candidates = listInactiveUsersForReminder({
    inactiveHours: REMINDER_INACTIVE_HOURS,
    reminderCooldownHours: REMINDER_COOLDOWN_HOURS,
  });

  for (const u of candidates) {
    if (u.city) {
      const count = countFreshCandidatesInCity(u.user_id, u.city, targetGenderFor(u.gender));
      if (count > 0) {
        await safeSendToUser(
          u.user_id,
          `Привет! У тебя ${count} ${pluralizeProfiles(count)} в городе ${u.city} 👀\n` +
          `Заходи посмотреть — напиши /search`
        );
      }
    }
    markReminderSent(u.user_id);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function pluralizeProfiles(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'новая анкета';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'новые анкеты';
  return 'новых анкет';
}

setInterval(sendInactivityReminders, REMINDER_CHECK_INTERVAL_MS);

bot.start();
console.log('Bot started');
