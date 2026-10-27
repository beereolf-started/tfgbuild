// priority: 0
"use strict";
/**
 * Заготовки латных доспехов Epic Knights: у каждой вещи своя, чтобы при сварке не путались
 * восемь кирас из одной стали. Цена как у доспехов TFC (forging.js). Сгенерировано gen_ek_forging.py.
 * ВНИМАНИЕ: новые предметы - нужен полный перезапуск и у сервера, и у игроков (клиентский архив).
 */
StartupEvents.registry('item', event => {
    ;[
    { id: 'tfg:ek_unfinished_armet', name: 'Заготовка: Армет', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:ek_unfinished_barbute', name: 'Заготовка: Барбют', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:ek_unfinished_bascinet', name: 'Заготовка: Бацинет', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:ek_unfinished_grand_bascinet', name: 'Заготовка: Гранд бацинет', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:ek_unfinished_greathelm', name: 'Заготовка: Топфхельм', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:ek_unfinished_kettlehat', name: 'Заготовка: Шапель', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:ek_unfinished_norman_helmet', name: 'Заготовка: Норманский шлем', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:ek_unfinished_sallet', name: 'Заготовка: Салад', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:ek_unfinished_shishak', name: 'Заготовка: Шишак', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:ek_unfinished_stechhelm', name: 'Заготовка: Штеххельм', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:ek_unfinished_face_helmet', name: 'Заготовка: Шлем с личиной', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:ek_unfinished_cuirassier_helmet', name: 'Заготовка: Бургиньот', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:ek_unfinished_gothic_chestplate', name: 'Заготовка: Готический доспех', texture: 'tfc:item/metal/unfinished_chestplate/steel' },
    { id: 'tfg:ek_unfinished_jousting_chestplate', name: 'Заготовка: Турнирный доспех', texture: 'tfc:item/metal/unfinished_chestplate/steel' },
    { id: 'tfg:ek_unfinished_kastenbrust_chestplate', name: 'Заготовка: Нагрудник доспеха кастенбруст', texture: 'tfc:item/metal/unfinished_chestplate/steel' },
    { id: 'tfg:ek_unfinished_knight_chestplate', name: 'Заготовка: Рыцарский доспех', texture: 'tfc:item/metal/unfinished_chestplate/steel' },
    { id: 'tfg:ek_unfinished_platemail_chestplate', name: 'Заготовка: Укреплённый хауберк', texture: 'tfc:item/metal/unfinished_chestplate/steel' },
    { id: 'tfg:ek_unfinished_xivcenturyknight_chestplate', name: 'Заготовка: Рыцарский доспех 14 века', texture: 'tfc:item/metal/unfinished_chestplate/steel' },
    { id: 'tfg:ek_unfinished_cuirassier_chestplate', name: 'Заготовка: Кираса', texture: 'tfc:item/metal/unfinished_chestplate/steel' },
    { id: 'tfg:ek_unfinished_halfarmor_chestplate', name: 'Заготовка: Неполный доспех', texture: 'tfc:item/metal/unfinished_chestplate/steel' },
    { id: 'tfg:ek_unfinished_gothic_leggings', name: 'Заготовка: Готические поножи', texture: 'tfc:item/metal/unfinished_greaves/steel' },
    { id: 'tfg:ek_unfinished_jousting_leggings', name: 'Заготовка: Турнирные поножи', texture: 'tfc:item/metal/unfinished_greaves/steel' },
    { id: 'tfg:ek_unfinished_kastenbrust_leggings', name: 'Заготовка: Поножи доспеха кастенбруст', texture: 'tfc:item/metal/unfinished_greaves/steel' },
    { id: 'tfg:ek_unfinished_knight_leggings', name: 'Заготовка: Рыцарские поножи', texture: 'tfc:item/metal/unfinished_greaves/steel' },
    { id: 'tfg:ek_unfinished_platemail_leggings', name: 'Заготовка: Укреплённые кольчужные чулки', texture: 'tfc:item/metal/unfinished_greaves/steel' },
    { id: 'tfg:ek_unfinished_xivcenturyknight_leggings', name: 'Заготовка: Рыцарские поножи 14 века', texture: 'tfc:item/metal/unfinished_greaves/steel' },
    { id: 'tfg:ek_unfinished_crusader_leggings', name: 'Заготовка: Поножи крестоносца', texture: 'tfc:item/metal/unfinished_greaves/steel' },
    { id: 'tfg:ek_unfinished_gothic_boots', name: 'Заготовка: Готические ботинки', texture: 'tfc:item/metal/unfinished_boots/steel' },
    { id: 'tfg:ek_unfinished_jousting_boots', name: 'Заготовка: Турнирные сабатоны', texture: 'tfc:item/metal/unfinished_boots/steel' },
    { id: 'tfg:ek_unfinished_kastenbrust_boots', name: 'Заготовка: Сабатоны доспеха кастенбруст', texture: 'tfc:item/metal/unfinished_boots/steel' },
    { id: 'tfg:ek_unfinished_knight_boots', name: 'Заготовка: Рыцарские сабатоны', texture: 'tfc:item/metal/unfinished_boots/steel' },
    { id: 'tfg:ek_unfinished_platemail_boots', name: 'Заготовка: Укреплённые сапоги', texture: 'tfc:item/metal/unfinished_boots/steel' },
    { id: 'tfg:ek_unfinished_xivcenturyknight_boots', name: 'Заготовка: Рыцарские саботины 14 века', texture: 'tfc:item/metal/unfinished_boots/steel' },
    { id: 'tfg:ek_unfinished_crusader_boots', name: 'Заготовка: Ботфорты крестоносца', texture: 'tfc:item/metal/unfinished_boots/steel' },
    ].forEach(u => event.create(u.id).displayName(u.name).texture(u.texture).maxStackSize(1).tag('tfg:ek_unfinished'))
})
