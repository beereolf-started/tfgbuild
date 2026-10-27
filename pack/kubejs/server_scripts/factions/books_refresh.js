// priority: -13
"use strict";

/**
 * ОБНОВЛЕНИЕ УЖЕ РАЗДАННЫХ КНИГ. Подписанная книга (minecraft:written_book) хранит страницы в себе,
 * а не читает их из библиотеки. Поэтому экземпляры, разложенные по сундукам поселений до правки
 * текстов, остались бы со старым текстом - в том числе с тем, что противоречит канону.
 *
 * У каждой нашей книги в метках лежит её номер (tfg_book, ставит books.js). По нему книгу можно
 * пересобрать на месте. Чтобы не пересобирать её при каждом открытии, рядом пишется номер правки
 * (tfg_rev): совпал - книга свежая, не совпал - пересобираем.
 *
 * Первое открытие устаревшей книги её обновляет и не открывает; второе открывает уже новый текст.
 * Это одно лишнее нажатие на книгу, один раз за книгу.
 *
 * Дневники (tfg_book = "diary") не трогаем: они составлены из жизни своего автора и в библиотеке
 * их нет.
 */

// Номер правки текстов. Поднять, когда тексты книг снова изменятся.
const LBR_REV = 2;

function lbrEntry(id) {
    try {
        const lib = global.TFG_BOOKS.library();
        for (let i = 0; i < lib.length; i++) if (String(lib[i].id) === id) return lib[i];
    } catch (e) { }
    return null;
}

ItemEvents.rightClicked('minecraft:written_book', event => {
    const player = event.player;
    if (!player || !player.server) return;
    const stack = event.item;
    if (!stack || stack.isEmpty()) return;

    let nbt = null;
    try { nbt = stack.nbt; } catch (e) { return; }
    if (!nbt || !nbt.contains('tfg_book')) return;

    const id = String(nbt.getString('tfg_book'));
    if (!id || id === 'diary') return;
    let rev = 0;
    try { rev = nbt.contains('tfg_rev') ? Number(nbt.getInt('tfg_rev')) : 0; } catch (e) { rev = 0; }
    if (rev >= LBR_REV) return;

    const entry = lbrEntry(id);
    if (!entry) return;

    let fresh = null;
    try { fresh = global.TFG_BOOKS.make(entry); } catch (e) {
        console.error('[книги] не пересобрать ' + id + ': ' + e);
        return;
    }
    if (!fresh || fresh.isEmpty()) return;
    try {
        fresh.nbt.putInt('tfg_rev', LBR_REV);
        fresh.count = stack.count;
    } catch (e) { }

    try { player.setItemInHand(event.hand, fresh); } catch (e) {
        console.error('[книги] не заменить в руке ' + id + ': ' + e);
        return;
    }
    // книгу в этот раз не открываем: клиент держит ещё старый экземпляр
    try { event.cancel(); } catch (e) { }
});
