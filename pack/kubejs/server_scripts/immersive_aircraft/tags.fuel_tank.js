// priority: 0
"use strict";

/**
 * Что можно налить в tfg:fuel_tank.
 *
 * Тег используется как whitelist самим предметом-контейнером (см. .fluidTagAccept
 * в startup_scripts/tfg/items.fuel_barrels.js), поэтому проверку "это признанное
 * топливо" делает TFC, а не наш скрипт: воду или металл в бак не налить.
 *
 * Список должен совпадать с TANK_FUELS в server_scripts/immersive_aircraft/
 * events.fuel_tank.js (там он нужен, чтобы по жидкости узнать, в какой
 * tfg:fuel_barrel_* превращать полный бак) и с ключами fuelList в
 * config/immersive_aircraft.json.
 *
 * Файл сам вешает своё событие - подключать в main_server_script.js не нужно.
 */
ServerEvents.tags('fluid', event => {
	event.add('tfg:aircraft_fuel',
		'gtceu:diesel',
		'gtceu:cetane_boosted_diesel',
		'gtceu:gasoline',
		'gtceu:high_octane_gasoline',
		'gtceu:ethanol',
		'gtceu:methanol',
		'gtceu:bio_diesel',
		'gtceu:creosote',
		'gtceu:seed_oil',
		'tfc:tallow',
		'tfc:olive_oil',
		'createaddition:bioethanol'
	)
})
