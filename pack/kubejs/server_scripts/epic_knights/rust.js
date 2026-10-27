// priority: -10
"use strict";
/**
 * Ржавое снаряжение Epic Knights (падает с зомби) отчищается наждачкой Create: в руке (наждачка в руке,
 * ржавая вещь во второй - зажать ПКМ) или деплоером с наждачкой. Выходит чистый аналог, но изношенный:
 * прочности остаётся EK_RUST_LEFT от полной. Ржавые мечи и булавы - в железные.
 */
const EK_RUST = {
	rustedbarbute: 'barbute',
	rustedchainmail_helmet: 'chainmail_helmet',
	rustedchainmail_chestplate: 'chainmail_chestplate',
	rustedchainmail_leggings: 'chainmail_leggings',
	rustedchainmail_boots: 'chainmail_boots',
	rustedcrusader_chestplate: 'crusader_chestplate',
	rustedcrusader_boots: 'crusader_boots',
	rustedgreathelm: 'greathelm',
	rustedhalfarmor_chestplate: 'halfarmor_chestplate',
	rustedkettlehat: 'kettlehat',
	rustednorman_helmet: 'norman_helmet',
	rusted_bastardsword: 'iron_bastardsword',
	rusted_heavymace: 'iron_heavymace',
}
const EK_RUST_LEFT = 0.35

ServerEvents.recipes(event => {
	Object.keys(EK_RUST).forEach(rusted => {
		const clean = 'magistuarmory:' + EK_RUST[rusted]
		const max = Item.of(clean).getMaxDamage()
		const out = max > 0 ? Item.of(clean, '{Damage:' + Math.floor(max * (1 - EK_RUST_LEFT)) + '}') : Item.of(clean)
		event.recipes.create.sandpaper_polishing(out, 'magistuarmory:' + rusted)
			.id('tfg:sandpaper_polishing/ek_rust/' + rusted)
	})
})
