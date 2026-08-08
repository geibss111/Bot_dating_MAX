import 'dotenv/config';
import { upsertUser } from './db.js';

const FIRST_NAMES_MALE = ['Александр', 'Иван', 'Дмитрий', 'Сергей', 'Павел', 'Максим', 'Артём', 'Николай'];
const FIRST_NAMES_FEMALE = ['Мария', 'Ольга', 'Екатерина', 'Анна', 'Наталья', 'Юлия', 'Виктория'];

const CITIES = ['Москва', 'Санкт-Петербург', 'Казань', 'Новосибирск', 'Екатеринбург', 'Краснодар'];

const BIOS = [
  'Люблю путешествия и хорошую кухню.',
  'Занимаюсь спортом, ищу единомышленника.',
  'Обожаю кино и долгие прогулки.',
  '',
  '',
];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomAge() {
  return 18 + Math.floor(Math.random() * 25); // 18..42
}

// Синтетические user_id, чтобы не пересекаться с реальными пользователями MAX
const SEED_ID_START = 900000001;
const COUNT = 15;

for (let i = 0; i < COUNT; i++) {
  const userId = SEED_ID_START + i;
  const gender = i % 2 === 0 ? 'male' : 'female';
  const name = gender === 'male' ? randomItem(FIRST_NAMES_MALE) : randomItem(FIRST_NAMES_FEMALE);
  upsertUser(userId, {
    username: `test_user_${i + 1}`,
    name,
    age: randomAge(),
    city: randomItem(CITIES),
    gender,
    bio: randomItem(BIOS),
    photo_token: null, // без реального фото — бот покажет анкету без картинки
    reg_state: 'done',
  });
}

console.log(
  `Добавлено ${COUNT} тестовых анкет (user_id ${SEED_ID_START}–${SEED_ID_START + COUNT - 1})`
);
