// priority: 0
"use strict";

/**
 * Лут мобов Ice and Fire: ванильные предметы без применения в TFG -> аналоги сборки.
 *
 * Таблицы мода (data/iceandfire/loot_tables/entities) отдают ванильное мясо и
 * шерсть. Ванильное мясо в TFG мёртвое: не еда по механике TFC, не готовится и не
 * портится (ванильный лут кур пак и так удаляет - minecraft/loot.js).
 * Количество сохраняется. Остальной ванильный дроп (кости, перья, гнилая плоть,
 * паучьи глаза, снежки, изумруд, железо, кожа, грибы) в сборке используется.
 *
 * Файл самостоятельный: свой LootJS.modifiers, в main_server_script.js не подключается.
 */
LootJS.modifiers(event => {
	event.addEntityLootModifier('iceandfire:cockatrice')
		.replaceLoot('minecraft:chicken', 'tfc:food/chicken', true)

	event.addEntityLootModifier('iceandfire:cyclops')
		.replaceLoot('minecraft:mutton', 'tfc:food/mutton', true)
		.replaceLoot('minecraft:white_wool', 'tfc:wool', true)

	event.addEntityLootModifier('iceandfire:stymphalian_bird')
		.replaceLoot('minecraft:copper_ingot', 'tfc:metal/ingot/copper', true)
})
