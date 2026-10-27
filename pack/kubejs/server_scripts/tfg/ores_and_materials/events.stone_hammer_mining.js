// priority: 20
"use strict";

// Stone-age "emergency mining" fallback.
// gtceu:stone_hammer is HARD_HAMMER-class, not PICKAXE-class - GregTech ore
// blocks normally drop nothing when broken with it (wrong tool for drops).
// This hands back exactly 1 poor-grade raw ore as a consolation drop, so
// players stuck without accessible surface "small ore" (e.g. buried under
// snow) can still bootstrap into the copper age, just at the worst yield.

const STONE_HAMMER_TOOL_ID = 'gtceu:stone_hammer';
const STONE_HAMMER_ORE_MAP = {};

forEachMaterial(material => {
	if (!material.hasProperty(PropertyKey.ORE)) return;
	if (material === GTMaterials.Coal || material === GTMaterials.get('lignite')) return;

	let poorRawOre = ChemicalHelper.get(TFGTagPrefix.poorRawOre, material, 1);
	if (poorRawOre.isEmpty()) return;

	let rawOreBlock = ChemicalHelper.get(TagPrefix.rawOreBlock, material, 1);
	if (!rawOreBlock.isEmpty()) {
		STONE_HAMMER_ORE_MAP['' + rawOreBlock.getItem().id] = poorRawOre;
	}

	global.ORE_BEARING_STONES.forEach(stoneType => {
		STONE_HAMMER_ORE_MAP[`gtceu:${stoneType}_${material.getName()}_ore`] = poorRawOre;
	});

	global.SAND_COLORS.forEach(sandType => {
		STONE_HAMMER_ORE_MAP[`gtceu:${sandType}_sand_${material.getName()}_ore`] = poorRawOre;
	});
})

BlockEvents.broken(event => {
	const { item, player, block } = event;
	if (('' + item.id) !== STONE_HAMMER_TOOL_ID) return;

	const poorOre = STONE_HAMMER_ORE_MAP['' + block.id];
	if (!poorOre) return;

	player.give(poorOre);
	player.tell('§7[Молот] Удалось выломать немного бедной руды.');
})
