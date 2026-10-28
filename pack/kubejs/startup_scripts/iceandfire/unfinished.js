// priority: 0
"use strict";
/**
 * Заготовки металлической брони Ice and Fire (сгенерировано gen_iaf_forging.py).
 * ВНИМАНИЕ: новые предметы - нужен полный перезапуск и у сервера, и у игроков.
 */
StartupEvents.registry('item', event => {
    ;[
    { id: 'tfg:iaf_unfinished_armor_copper_metal_helmet', name: 'Заготовка: Медный шлем', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:iaf_unfinished_armor_copper_metal_chestplate', name: 'Заготовка: Медный нагрудник', texture: 'tfc:item/metal/unfinished_chestplate/steel' },
    { id: 'tfg:iaf_unfinished_armor_copper_metal_leggings', name: 'Заготовка: Медные поножи', texture: 'tfc:item/metal/unfinished_greaves/steel' },
    { id: 'tfg:iaf_unfinished_armor_copper_metal_boots', name: 'Заготовка: Медные ботинки', texture: 'tfc:item/metal/unfinished_boots/steel' },
    { id: 'tfg:iaf_unfinished_armor_silver_metal_helmet', name: 'Заготовка: Серебряный шлем', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:iaf_unfinished_armor_silver_metal_chestplate', name: 'Заготовка: Серебряный нагрудник', texture: 'tfc:item/metal/unfinished_chestplate/steel' },
    { id: 'tfg:iaf_unfinished_armor_silver_metal_leggings', name: 'Заготовка: Серебряные поножи', texture: 'tfc:item/metal/unfinished_greaves/steel' },
    { id: 'tfg:iaf_unfinished_armor_silver_metal_boots', name: 'Заготовка: Серебряные ботинки', texture: 'tfc:item/metal/unfinished_boots/steel' },
    { id: 'tfg:iaf_unfinished_dragonsteel_fire_helmet', name: 'Заготовка: Шлем из огненной драконостали', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:iaf_unfinished_dragonsteel_fire_chestplate', name: 'Заготовка: Нагрудник из огненной драконостали', texture: 'tfc:item/metal/unfinished_chestplate/steel' },
    { id: 'tfg:iaf_unfinished_dragonsteel_fire_leggings', name: 'Заготовка: Поножи из огненной драконостали', texture: 'tfc:item/metal/unfinished_greaves/steel' },
    { id: 'tfg:iaf_unfinished_dragonsteel_fire_boots', name: 'Заготовка: Ботинки из огненной драконостали', texture: 'tfc:item/metal/unfinished_boots/steel' },
    { id: 'tfg:iaf_unfinished_dragonsteel_ice_helmet', name: 'Заготовка: Шлем из ледяной драконостали', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:iaf_unfinished_dragonsteel_ice_chestplate', name: 'Заготовка: Нагрудник из ледяной драконостали', texture: 'tfc:item/metal/unfinished_chestplate/steel' },
    { id: 'tfg:iaf_unfinished_dragonsteel_ice_leggings', name: 'Заготовка: Поножи из ледяной драконостали', texture: 'tfc:item/metal/unfinished_greaves/steel' },
    { id: 'tfg:iaf_unfinished_dragonsteel_ice_boots', name: 'Заготовка: Ботинки из ледяной драконостали', texture: 'tfc:item/metal/unfinished_boots/steel' },
    { id: 'tfg:iaf_unfinished_dragonsteel_lightning_helmet', name: 'Заготовка: Шлем из грозовой драконостали', texture: 'tfc:item/metal/unfinished_helmet/steel' },
    { id: 'tfg:iaf_unfinished_dragonsteel_lightning_chestplate', name: 'Заготовка: Нагрудник из грозовой драконостали', texture: 'tfc:item/metal/unfinished_chestplate/steel' },
    { id: 'tfg:iaf_unfinished_dragonsteel_lightning_leggings', name: 'Заготовка: Поножи из грозовой драконостали', texture: 'tfc:item/metal/unfinished_greaves/steel' },
    { id: 'tfg:iaf_unfinished_dragonsteel_lightning_boots', name: 'Заготовка: Ботинки из грозовой драконостали', texture: 'tfc:item/metal/unfinished_boots/steel' },
    ].forEach(u => event.create(u.id).displayName(u.name).texture(u.texture).maxStackSize(1).tag('tfg:iaf_unfinished'))
})
