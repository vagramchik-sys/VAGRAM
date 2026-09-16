'use strict';
const messages = Object.freeze({
  AI_UNAVAILABLE: 'Codex не найден на сервере. Обратитесь к администратору.',
  AI_LAUNCH: 'Не удалось запустить Codex. Требуется проверка установки на сервере.',
  AI_TIMEOUT: 'Директор не ответил за две минуты. Попробуйте отправить обращение ещё раз.',
  AI_OUTPUT_LIMIT: 'Ответ ИИ превысил допустимый объём. Сократите запрос и повторите обращение.',
  AI_PROCESS_EXIT: 'Codex завершился без ответа. Повторите обращение; если ошибка повторяется, нужна проверка подключения и входа Codex на сервере.',
  AI_EMPTY: 'Codex не вернул текст ответа. Повторите обращение.',
  AI_UNKNOWN: 'Не удалось получить ответ ИИ. Повторите обращение; если ошибка повторяется, обратитесь к администратору.'
});
function codeOf(error) { return Object.hasOwn(messages, error?.code) ? error.code : 'AI_UNKNOWN'; }
function createError(code) { return Object.assign(new Error(messages[code] || messages.AI_UNKNOWN), {code: Object.hasOwn(messages, code) ? code : 'AI_UNKNOWN'}); }
function publicMessage(error) { const code=codeOf(error); return `${messages[code]} Код: ${code}.`; }
module.exports={createError,publicMessage,codeOf};
