// priority: -100
"use strict";

// Butchery в сборке TFG (мод tfgui, план трупов: Downloads/TFG-трупы-план.md).
// - Мясо: куски Butchery идут везде, где сборка просит мясо TFC. Теги tfgui:meat/<мясо> (мясо TFC
//   и его куски) даёт мод tfgui; здесь куски добавляются во все теги с этим мясом, а рецепты из
//   скриптов сборки (машины GT, кухня) переводятся с мяса TFC на тег. Рецепты из самих модов
//   переписаны в kubejs/data генератором tools/gen_butchery_food.py.
// - Инструменты: шкуру снимает обычный нож TFG, мясо режет разделочный нож - ножи для шкур и тесаки
//   Butchery не нужны, их рецепты убраны и они скрыты. Крюки - на наковальне: железный (любая туша)
//   и медный tfgui:copper_hook (только небольшие туши). Скрипт после остальных (priority -100).

const TFGUI_MEATS = ['beef', 'pork', 'mutton', 'chevon', 'chicken', 'horse_meat', 'bear', 'wolf', 'fox',
	'gran_feline', 'camelidae', 'cod', 'salmon', 'tropical_fish', 'frog_legs', 'turtle', 'shellfish',
	// рыба: её филе (tfgui, tfgui_fish.js) идёт везде, где идёт сама рыба
	'bluegill', 'crappie', 'lake_trout', 'largemouth_bass', 'rainbow_trout', 'smallmouth_bass', 'toxlacanth'];
// мясо не из TFC: вид -> [сырое, жареное]; остальное - tfc:food/<вид> и tfc:food/cooked_<вид>
const TFGUI_MEAT_ITEMS = {toxlacanth: ['wan_ancient_beasts:toxlacanth', 'wan_ancient_beasts:cooked_toxlacanth']};
// мясо без своей еды-оригинала (глубинник Европы - только филе): теги еды - как у этого мяса TFC
const TFGUI_MEAT_TAGS_LIKE = {deepfish: 'cod'};
const tfguiMeatItem = (m, cooked) => TFGUI_MEAT_ITEMS[m] ? TFGUI_MEAT_ITEMS[m][cooked ? 1 : 0] : 'tfc:food/' + (cooked ? 'cooked_' : '') + m;
const TFGUI_BUTCHERY_METALS = ['bone', 'copper', 'iron', 'gold', 'diamond', 'netherite'];
// разделочный стол Butchery -> дерево TFC, из которого он делается (по цвету)
const TFGUI_BUTCHERY_TABLE_WOODS = {oak: 'oak', spruce: 'spruce', birch: 'birch', jungle: 'kapok', acacia: 'acacia',
	dark_oak: 'blackwood', mangrove: 'mangrove'};
const TFGUI_BUTCHERY_HIDDEN_TABLES = ['crimson', 'warped'];

ServerEvents.tags('item', event => {
	if (!Platform.isLoaded('butchery')) return;
	// куски - во все теги, где есть мясо TFC того же вида (бульоны, котлеты для бургеров, корм...)
	const extra = [];
	event.tags.forEach((id, wrapper) => {
		const tagId = String(id);
		if (tagId.startsWith('tfgui:meat/')) return;
		let ids;
		try { ids = wrapper.getObjectIds().toArray().map(String); } catch (e) { return; }
		TFGUI_MEATS.forEach(m => ['', 'cooked_'].forEach(c => {
			if (ids.indexOf(tfguiMeatItem(m, c !== '')) >= 0) extra.push([tagId, '#tfgui:meat/' + c + m]);
		}));
		Object.keys(TFGUI_MEAT_TAGS_LIKE).forEach(m => ['', 'cooked_'].forEach(c => {
			if (ids.indexOf(tfguiMeatItem(TFGUI_MEAT_TAGS_LIKE[m], c !== '')) >= 0) extra.push([tagId, '#tfgui:meat/' + c + m]);
		}));
	});
	extra.forEach(e => event.add(e[0], e[1]));

	// инструменты Butchery, которые в сборке заменены ножами TFG, и соль с серой Butchery (их не добыть)
	TFGUI_BUTCHERY_METALS.forEach(m => {
		event.add('c:hidden_from_recipe_viewers', `butchery:${m}_cleaver`);
		event.add('c:hidden_from_recipe_viewers', `butchery:${m}_skinning_knife`);
	});
	['salt', 'salt_block', 'sulfur', 'sulfur_ore', 'deepslate_sulfur_ore'].forEach(i => event.add('c:hidden_from_recipe_viewers', `butchery:${i}`));
	TFGUI_BUTCHERY_HIDDEN_TABLES.forEach(t => event.add('c:hidden_from_recipe_viewers', `butchery:${t}_butchers_table`));
});

ServerEvents.recipes(event => {
	if (!Platform.isLoaded('butchery')) return;

	// мясо TFC во входах -> «любое мясо этого вида»; не трогаем жарку и рецепты, где это же мясо выходит
	// (копчение, засолка в машинах: там у каждого куска свой рецепт), и свои (разделка рыбы на филе -
	// иначе филе резалось бы в филе)
	TFGUI_MEATS.forEach(m => ['', 'cooked_'].forEach(c => {
		const item = tfguiMeatItem(m, c !== '');
		event.replaceInput({
			input: item,
			not: [{type: 'tfc:heating'}, {mod: 'butchery'}, {mod: 'tfgui'}, {output: tfguiMeatItem(m, false)}, {output: tfguiMeatItem(m, true)}]
		}, item, '#tfgui:meat/' + c + m);
	}));

	// ножи для шкур и тесаки Butchery - не нужны
	TFGUI_BUTCHERY_METALS.forEach(m => {
		event.remove({id: `butchery:${m}cleaverrecipe`});
		event.remove({id: `butchery:${m}skinningkniferecipe`});
	});
	event.remove({output: /^butchery:.*(_cleaver|_skinning_knife)$/});
	event.remove({id: 'butchery:saltblockrecipe'});

	// крюки - на наковальне
	event.remove({id: 'butchery:hookrecipe'});
	event.recipes.tfc.anvil('butchery:hook', '#forge:ingots/wrought_iron', ['hit_last', 'bend_second_last', 'draw_third_last'])
		.tier(3).id('tfgui:anvil/hook_wrought_iron');
	event.recipes.tfc.anvil('tfgui:copper_hook', '#forge:ingots/copper', ['hit_last', 'bend_second_last', 'draw_third_last'])
		.tier(1).id('tfgui:anvil/hook_copper');

	// разделочные столы (мелкие тушки) - из дерева TFC: окорённое дерево, доски, полублок; железный -
	// пластины и прутья кованого железа. Столов из адского дерева нет (TFGUI_BUTCHERY_HIDDEN_TABLES)
	event.remove({output: /^butchery:.*_butchers_table$/});
	Object.keys(TFGUI_BUTCHERY_TABLE_WOODS).forEach(table => {
		const wood = TFGUI_BUTCHERY_TABLE_WOODS[table];
		event.shaped(`butchery:${table}_butchers_table`, ['AAA', 'BCB', 'B B'], {
			A: `tfc:wood/stripped_wood/${wood}`,
			B: `tfc:wood/planks/${wood}`,
			C: `tfc:wood/planks/${wood}_slab`
		}).id(`tfgui:crafting/butchers_table_${table}`);
	});
	event.shaped('butchery:metal_butchers_table', ['AAA', 'B B', 'B B'], {
		A: '#forge:plates/wrought_iron',
		B: '#forge:rods/wrought_iron'
	}).id('tfgui:crafting/butchers_table_metal');
});

// Бизон tfgui (скот TFC, дикий, пока не прикормлен) заменил бизона TFG - добыча та же, что у бизона TFG (tfg/loot.js)
LootJS.modifiers(event => {
	event.addEntityLootModifier('tfgui:bison')
		.addWeightedLoot([12, 20], ['tfg:food/raw_bison_meat'])
		.addWeightedLoot([7, 10], ['minecraft:bone'])
		.addLoot(LootEntry.of('tfc:large_raw_hide', 1))
		.addWeightedLoot([1, 2], ['tfc:blubber'])
		.addSequenceLoot(LootEntry.of('waterflasks:bladder').when(c => c.randomChance(0.1)))
		.addLoot(LootEntry.of('firmalife:rennet', 4))

	event.addEntityLootModifier('tfgui:bison')
		.matchMainHand('#forge:tools/butchery_knives')
		.addWeightedLoot([4, 6], ['tfg:food/raw_bison_meat'])
		.addWeightedLoot([0, 1], ['tfc:blubber'])
})
