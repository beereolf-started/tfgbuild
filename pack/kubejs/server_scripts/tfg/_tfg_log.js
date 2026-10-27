// priority: 1000
"use strict";

/**
 * ЕДИНАЯ ТОЧКА ЛОГИРОВАНИЯ НАШИХ МЕХАНИК.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ПОЧЕМУ НЕ ОТДЕЛЬНЫЙ ФАЙЛ, КАК ХОТЕЛОСЬ
 *
 * Первая версия писала в logs/tfg.log через java.io.FileWriter и обрушила
 * сервер логами на 2.16 ГБ. Разбор:
 *   _tfg_log.js#17: Failed to load Java class 'java.io.FileWriter':
 *   Class is not allowed by class filter!
 * KubeJS запрещает java.io через Java.loadClass. Скрипт падал на этой строке,
 * а global.tfgLog определялся НИЖЕ - и не определялся никогда. Дальше каждый
 * вызов из семи скриптов кидал TypeError, а KubeJS на такой ошибке печатает
 * ДАМП ВСЕХ ГЛОБАЛЬНЫХ ПЕРЕМЕННЫХ - мегабайты на каждый тик.
 *
 * Обойти фильтр можно (достать java.io.File у server.getServerDirectory() и
 * дальше через загрузчик классов), но это ровно обход защиты, которую поставили
 * не просто так. Не стоит того ради удобства чтения логов.
 *
 * ДВА ВЫВОДА, заложенные здесь:
 *  1. Пишем обычным console.log с единым префиксом [tfg ...]. Строки легко
 *     вытащить в отдельный файл одной командой grep - см. ниже.
 *  2. Функции объявлены ПЕРВЫМИ и не зависят ни от чего. Что бы ни случилось
 *     дальше, global.tfgLog существует, и каскада падений быть не может.
 *
 * Вытащить наши строки из серверного лога:
 *   grep "\[tfg " logs/latest.log > tfg-only.log
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Метка времени без Java - только штатный JS. */
function tfgLogStamp() {
	var d = new Date()
	function p(n) { return String(n).padStart(2, '0') }
	return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Обычная строка. Префикс [tfg <тег>] - по нему всё и вылавливается.
 * Сама функция не может упасть: ни Java, ни внешних зависимостей.
 */
global.tfgLog = function (tag, message) {
	try {
		console.log(`[${tfgLogStamp()}] [tfg ${tag}] ${message}`)
	} catch (e) {
		console.log('[tfg log] ' + tag + ' ' + message)
	}
}

/**
 * Ошибка. ВАЖНО: печатаем только текст исключения и стек, но НИКОГДА не сам
 * объект - иначе KubeJS вывалит дамп всей области видимости, чем и был раздут
 * лог до двух гигабайт.
 */
global.tfgLogError = function (tag, message, e) {
	try {
		var text = String(message)
		if (e) {
			text += ': ' + String(e)
			if (e.stack) text += '\n    ' + String(e.stack)
		}
		console.error(`[${tfgLogStamp()}] [tfg ${tag}/ОШИБКА] ${text}`)
	} catch (inner) {
		console.error('[tfg ' + tag + '/ОШИБКА] ' + message)
	}
}

/**
 * Страховка для скриптов, которые загрузились РАНЬШЕ этого файла или в
 * которых логгер почему-то недоступен: вызов через global.tfgLog && ... не
 * нужен, функция гарантированно есть. Но если этот файл всё же не загрузится,
 * пусть остальные не падают - они зовут global.tfgLog, а не голый tfgLog,
 * и обращение к отсутствующему свойству объекта даёт undefined, а не
 * ReferenceError. Вызов undefined всё же кинет TypeError, поэтому ниже -
 * последний рубеж.
 */
if (typeof global.tfgLog !== 'function') {
	global.tfgLog = function (tag, message) { console.log('[tfg ' + tag + '] ' + message) }
}
if (typeof global.tfgLogError !== 'function') {
	global.tfgLogError = function (tag, message, e) { console.error('[tfg ' + tag + '/ОШИБКА] ' + message + (e ? (': ' + e) : '')) }
}

global.tfgLog('log', 'логирование готово, скрипты перезагружены')
