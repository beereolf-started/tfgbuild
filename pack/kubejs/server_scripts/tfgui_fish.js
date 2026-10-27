// priority: -100
"use strict";

// Разделка рыбы (мод tfgui, tools/gen_fish.py там же - те же числа). Убитая рыба лежит тушкой (трупы tfgui):
// её разделывают на столе Butchery (вся добыча) или на земле (меньше еды). Внутри - филе, потроха, кости
// и иногда икра TFG этой рыбы (она же засевает садок TFG). Пойманную рыбу режут ножом в сетке крафта -
// там без икры (рецепты tfgui:crafting/fish/*).

// вид рыбы -> [филе, сколько филе]
const TFGUI_FISH = {
	'tfc:salmon': ['tfgui:food/salmon_fillet', 2],
	'tfc:lake_trout': ['tfgui:food/lake_trout_fillet', 2],
	'tfc:rainbow_trout': ['tfgui:food/rainbow_trout_fillet', 2],
	'tfc:largemouth_bass': ['tfgui:food/largemouth_bass_fillet', 2],
	'tfc:smallmouth_bass': ['tfgui:food/smallmouth_bass_fillet', 1],
	'tfc:bluegill': ['tfgui:food/bluegill_fillet', 1],
	'tfc:crappie': ['tfgui:food/crappie_fillet', 1],
	'tfc:tropical_fish': ['tfgui:food/tropical_fish_fillet', 1],
	'tfc:cod': ['butchery:raw_cod_fillet', 2],
	'tfc:pufferfish': ['butchery:raw_pufferfish', 1],
	'wan_ancient_beasts:toxlacanth': ['tfgui:food/toxlacanth_fillet', 2],
	'species:deepfish': ['tfgui:food/deepfish_fillet', 1]
};
// икра - не из каждой рыбы
const TFGUI_FISH_ROE_CHANCE = 0.25;

LootJS.modifiers(event => {
	Object.keys(TFGUI_FISH).forEach(fish => {
		const fillet = TFGUI_FISH[fish];
		if (!Platform.isLoaded(fish.split(':')[0]) || !Platform.isLoaded(fillet[0].split(':')[0])) return;
		event.addEntityLootModifier(fish)
			.removeLoot(ItemFilter.ALWAYS_TRUE)
			.addLoot(LootEntry.of(fillet[0], fillet[1]))
			.addLoot('tfgui:fish_guts')
			.addLoot('tfgui:fish_bones')
			.addSequenceLoot(LootEntry.of(Item.of('tfg:fish_roe', `{mob_type:"${fish}"}`)).when(c => c.randomChance(TFGUI_FISH_ROE_CHANCE)));
	});
});
