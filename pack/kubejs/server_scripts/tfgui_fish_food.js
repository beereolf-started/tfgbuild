// priority: -110
"use strict";

// Рыбные части мода tfgui (еда, кости) и разделочные столы Butchery из дерева TFG.
//
// ПОЧЕМУ ЕДА СКРИПТОМ. Филе, потроха и солёные потроха мод регистрирует обычными предметами
// (FishParts.java: new Item(new Item.Properties())) - без свойств еды. Данные TFC
// (tfgui:tfc/food_items/fish) задают сытость, воду и питательность, но съедобным предмет
// делает только FoodProperties в коде мода, поэтому вилка «съесть» не появлялась.
// Пока мод не пересобран, едим скриптом: правый клик кормит игрока через FoodData TFC,
// то есть по тем же числам из данных мода (сытость, насыщение, вода, питательность, порча).
//
// СТОЛЫ. В сборке девять деревянных столов Butchery и железный. Рецепты к ним собираются из
// брёвен, досок и полублоков всех пород TFG (TFC и AFC): порода подобрана по цвету стола, так
// что стол делается в любом лесу своей породой. Плюс стол таксидермиста.

// ─── Еда: правый клик кормит по данным TFC ───────────────────────────────────

const TFGUI_EDIBLE = id => id.indexOf('tfgui:') === 0
	&& (id.indexOf('_fillet') >= 0 || id.indexOf('fish_guts') >= 0);

// блоки со своим правым кликом: по ним едой не щёлкаем (всё с механизмом внутри - по block.entity)
const TFGUI_INTERACTIVE = /door|gate|trapdoor|button|lever|bed|anvil|quern|lectern|bell|cake|campfire|repeater|comparator|note_block|jukebox|cauldron|composter|respawn_anchor|flower_pot|candle|loom|grill|crop|bush|sapling|lamp|switch|crank|valve|rack|shelf/;

const tfguiFeed = (player, stack) => {
	if (!player || player.isSpectator() || !player.server) return false;
	let data = null;
	try { data = player.getFoodData(); } catch (e) { data = null; }
	if (!data) return false;
	try {
		if (Number(data.getFoodLevel()) >= 20) {
			player.tell(Text.of('§7Сейчас не хочется есть.'));
			return false;
		}
	} catch (e) { /* нет уровня сытости - просто кормим */ }
	try {
		// FoodData TFC сам читает способность еды со стопки: сытость, насыщение, воду, питательность
		data.eat(stack.getItem(), stack);
	} catch (e) {
		if (global.tfgLogError) global.tfgLogError('tfgui рыба', 'не вышло накормить ' + stack.id, e);
		else console.error('[tfgui рыба] не вышло накормить ' + stack.id + ': ' + e);
		return false;
	}
	stack.shrink(1);
	try {
		player.level.playSound(null, player.x, player.y, player.z,
			'minecraft:entity.generic.eat', 'players', 0.8, 0.9 + Math.random() * 0.2);
	} catch (e) { }
	return true;
};

// щелчок по воздуху
ItemEvents.rightClicked(event => {
	if (!Platform.isLoaded('tfgui')) return;
	const stack = event.item;
	if (!stack || stack.isEmpty() || !TFGUI_EDIBLE(String(stack.id))) return;
	if (tfguiFeed(event.player, stack)) {
		try { event.player.swing(event.hand); } catch (e) { }
	}
});

// щелчок с предметом в руке до того, как сработает блок: ItemEvents.rightClickedBlock в KubeJS
// НЕТ (journal: Unknown event), поэтому берём firstRightClicked.
// Блоки со своим кликом (сундуки, двери, костры) пропускаем - там игрок хотел не поесть.
ItemEvents.firstRightClicked(event => {
	if (!Platform.isLoaded('tfgui')) return;
	const stack = event.item;
	if (!stack || stack.isEmpty() || !TFGUI_EDIBLE(String(stack.id))) return;
	const player = event.player;
	if (!player || player.isCrouching()) return;
	try {
		const block = event.block;
		if (block.entity) return;
		if (TFGUI_INTERACTIVE.test(String(block.id))) return;
	} catch (e) { return; }
	if (tfguiFeed(player, stack)) {
		try { event.cancel(); } catch (e) { }
	}
});

// ─── Кости рыбы = обычные кости ──────────────────────────────────────────────

ServerEvents.tags('item', event => {
	if (!Platform.isLoaded('tfgui')) return;
	// свой тег «любые кости» - на него переводятся рецепты
	event.add('tfgui:bones', 'minecraft:bone');
	event.add('tfgui:bones', 'tfgui:fish_bones');

	// и во все теги, где уже есть обычная кость (костная мука, корм, удобрения, машины GT)
	const add = [];
	event.tags.forEach((id, wrapper) => {
		const tagId = String(id);
		if (tagId === 'tfgui:bones' || tagId.indexOf('hidden_from_recipe_viewers') >= 0) return;
		let ids;
		try { ids = wrapper.getObjectIds().toArray().map(String); } catch (e) { return; }
		if (ids.indexOf('minecraft:bone') >= 0 && ids.indexOf('tfgui:fish_bones') < 0) add.push(tagId);
	});
	add.forEach(t => event.add(t, 'tfgui:fish_bones'));
	console.log('[tfgui рыба] кости рыбы добавлены в теги: ' + add.length);
});

// ─── Рецепты: кости рыбы ─────────────────────────────────────────────────────

ServerEvents.recipes(event => {
	if (!Platform.isLoaded('tfgui')) return;

	// где кость на входе - годится и рыбья; рецепты, выдающие кость, не трогаем
	event.replaceInput({
		input: 'minecraft:bone',
		not: [{output: 'minecraft:bone'}, {output: 'tfgui:fish_bones'}, {mod: 'tfgui'}]
	}, 'minecraft:bone', '#tfgui:bones');

	// костная мука из рыбьих костей - прямым рецептом, а не только через тег
	event.shapeless(Item.of('minecraft:bone_meal', 3), ['tfgui:fish_bones'])
		.id('tfgui:crafting/bone_meal_from_fish_bones');

	// измельчитель GregTech: кости рыбы в костную муку
	if (Platform.isLoaded('gtceu')) {
		event.remove({id: 'tfgui:fish_bones'});
		event.recipes.gtceu.macerator('tfgui:macerator/fish_bones')
			.itemInputs('tfgui:fish_bones')
			.itemOutputs('2x minecraft:bone_meal')
			.duration(40)
			.EUt(2);
	}
});

// ─── Разделочные столы и стол гравировки - ДАТАПАКОМ ────────────────────────
//
// Рецепты столов лежат в kubejs/data/tfgui/recipes/*.json, а тег столов Macaw - в
// kubejs/data/tfg/tags/items/mcw_tables.json. Причина: скриптом их провести не удалось трижды -
// обработчики рецептов до этих файлов просто не доходили, молча и без ошибки в журнале.
// JSON читает сам игровой загрузчик, до всяких событий KubeJS, поэтому сломать его нечем.
// Здесь их нарочно НЕТ - и нарочно нет удаления старых: оно снесло бы и датапачные.

// ─── Проверка: что в итоге лежит в наборе рецептов ───────────────────────────
//
// Рецепты добавляются без ошибок, но в игре их не видно - поэтому пересчитываем их в самом
// наборе после всех скриптов и пишем числа в лог сервера.

ServerEvents.recipes(event => {
	let tables = 0, bones = 0, fillets = 0;
	try { event.forEachRecipe({output: /^butchery:.*(_butchers_table|taxidermy_table)$/}, () => tables++); } catch (e) { tables = -1; }
	try { event.forEachRecipe({input: 'tfgui:fish_bones'}, () => bones++); } catch (e) { bones = -1; }
	try { event.forEachRecipe({output: /^tfgui:food\/.*_fillet$/}, () => fillets++); } catch (e) { fillets = -1; }
	let bone = 0;
	try { bone = Ingredient.of('tfgui:fish_bones').itemIds.toArray().length; } catch (e) { bone = -1; }
	console.log('[tfgui проверка] столы разделки: ' + tables + ' рецептов; кости рыбы на входе: ' + bones
		+ '; филе на выходе: ' + fillets + '; предмет tfgui:fish_bones: ' + (bone > 0 ? 'есть' : 'НЕТ'));
});
