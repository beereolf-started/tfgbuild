// priority: 0
"use strict";

/**
 * Крафт пустого стального топливного бака (пруты + листы).
 *
 * tfg:fuel_tank - предмет-жидкостный контейнер TFC (tfc:fluid_container, см.
 * startup_scripts/tfg/items.fuel_barrels.js), заливается штатными средствами
 * TFC: из бочки, крана, любого источника, как кувшин. Уровень виден в тултипе
 * и в самой модели предмета.
 *
 * Готовые "tfg:fuel_barrel_*" (то, что реально ест самолёт) отдельного рецепта
 * не имеют и не должны: полный бак превращается в них по ПКМ, см.
 * events.fuel_tank.js.
 *
 * @param {Internal.RecipesEventJS} event
 */
// Файл сам вешает ServerEvents.recipes - подключать в main_server_script.js не нужно.
ServerEvents.recipes(event => {

	event.recipes.gtceu.shaped('tfg:fuel_tank', [
		'PPP',
		'RPR',
		'PPP'
	], {
		P: '#forge:plates/steel',
		R: '#forge:rods/steel'
	}).addMaterialInfo().id('tfg:fuel_barrels/shaped/fuel_tank')
})
