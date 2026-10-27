"use strict";
/**
 * ДЛИННЫЕ ЗНАЧЕНИЯ В ДАННЫХ СЕРВЕРА.
 *
 * Строка в NBT не может быть длиннее 65535 байт. Если писать больше, значение молча
 * становится пустым - и пропадает всё, что в нём лежало: так однажды исчезли все шаблоны
 * построек разом. Поэтому длинные записи режем на куски по 20 000 символов:
 *
 *   <ключ>_parts   - сколько кусков;
 *   <ключ>_0 ...   - сами куски.
 *
 * Старое цельное значение читается как было, пока не будет переписано.
 */

const TFG_PART = 20000

function tfgStoreRead(pd, key) {
    try {
        var n = 0
        if (pd.contains(key + "_parts")) n = Number(pd.getString(key + "_parts")) || 0
        if (n > 0) {
            var text = ""
            for (var i = 0; i < n; i++) {
                var k = key + "_" + i
                text += pd.contains(k) ? String(pd.getString(k)) : ""
            }
            return text
        }
        return pd.contains(key) ? String(pd.getString(key)) : ""
    } catch (e) {
        try { console.error("[хранилище] чтение " + key + ": " + e) } catch (err) { }
        return ""
    }
}

/** Возвращает null, если записалось целиком, иначе строку с жалобой. */
function tfgStoreWrite(pd, key, text) {
    text = String(text === undefined || text === null ? "" : text)
    try {
        var parts = Math.ceil(text.length / TFG_PART) || 1
        for (var i = 0; i < parts; i++) pd.putString(key + "_" + i, text.substr(i * TFG_PART, TFG_PART))
        // читаем обратно: если кусок не влез, он окажется пустым
        var back = ""
        for (var j = 0; j < parts; j++) {
            var k = key + "_" + j
            back += pd.contains(k) ? String(pd.getString(k)) : ""
        }
        pd.putString(key + "_parts", String(parts))
        // хвосты от прошлых, более длинных записей
        for (var extra = parts; extra < parts + 8; extra++) {
            var ke = key + "_" + extra
            try { if (pd.contains(ke)) pd.remove(ke) } catch (e2) { }
        }
        try { if (pd.contains(key)) pd.remove(key) } catch (e3) { }
        if (back.length !== text.length) return key + ": записано " + back.length + " из " + text.length
        return null
    } catch (e) {
        try { console.error("[хранилище] запись " + key + ": " + e) } catch (err) { }
        return String(e)
    }
}

global.TFG_STORE = {
    read: (pd, key) => tfgStoreRead(pd, key),
    write: (pd, key, text) => tfgStoreWrite(pd, key, text),
    part: TFG_PART,
}
